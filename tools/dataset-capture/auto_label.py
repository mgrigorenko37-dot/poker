"""
Auto-Label Cards in Dataset
============================
Запускает существующую модель playing_cards.onnx по всем картинкам в папке
и создаёт .txt файлы разметки в формате YOLO.

Карты (классы 0-51) размечаются автоматически.
Новые классы (dealer_button, folded и т.д.) нужно добавить вручную
в любом YOLO-совместимом инструменте (Roboflow, LabelImg, CVAT).

Установка:
    pip install onnxruntime pillow numpy opencv-python tqdm

Запуск:
    python auto_label.py --dataset dataset/ --model playing_cards.onnx
"""

import argparse
import os
import sys
from pathlib import Path

try:
    import cv2
    import numpy as np
    import onnxruntime as ort
    from PIL import Image
    from tqdm import tqdm
except ImportError:
    os.system(f"{sys.executable} -m pip install onnxruntime pillow numpy opencv-python tqdm -q")
    import cv2
    import numpy as np
    import onnxruntime as ort
    from PIL import Image
    from tqdm import tqdm


# ─── Классы карт (совпадают с playing_cards.onnx) ────────────────────────────
CARD_CLASSES = [
    '10C','10D','10H','10S','2C','2D','2H','2S','3C','3D','3H','3S',
    '4C','4D','4H','4S','5C','5D','5H','5S','6C','6D','6H','6S',
    '7C','7D','7H','7S','8C','8D','8H','8S','9C','9D','9H','9S',
    'AC','AD','AH','AS','JC','JD','JH','JS','KC','KD','KH','KS',
    'QC','QD','QH','QS',
]

# ─── Новые классы (добавятся после карт) ─────────────────────────────────────
EXTRA_CLASSES = [
    'dealer_button',   # 52 — оранжевый кружок D
    'player_folded',   # 53 — красная карта / иконка фолда
    'player_away',     # 54 — «Отошел» / отключился
    'pot_chips',       # 55 — банк в центре стола
    'player_bet',      # 56 — ставка перед игроком
    'stack_label',     # 57 — текст стека (числа под ником)
]

ALL_CLASSES = CARD_CLASSES + EXTRA_CLASSES


# ─── YOLO preprocessing ───────────────────────────────────────────────────────

def letterbox(img: np.ndarray, size=640):
    """Ресайз с сохранением пропорций, серые поля сверху/снизу."""
    h, w = img.shape[:2]
    scale = size / max(h, w)
    nh, nw = int(h * scale), int(w * scale)
    img_resized = cv2.resize(img, (nw, nh))
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    pad_top  = (size - nh) // 2
    pad_left = (size - nw) // 2
    canvas[pad_top:pad_top+nh, pad_left:pad_left+nw] = img_resized
    return canvas, scale, pad_left, pad_top


def preprocess(img_bgr: np.ndarray):
    lb, scale, pl, pt = letterbox(img_bgr)
    inp = lb[:, :, ::-1].astype(np.float32) / 255.0   # BGR→RGB, [0,1]
    inp = inp.transpose(2, 0, 1)[np.newaxis]            # HWC→NCHW
    return inp, scale, pl, pt


# ─── NMS ─────────────────────────────────────────────────────────────────────

def nms(boxes, scores, iou_thresh=0.45):
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        inter_x1 = np.maximum(x1[i], x1[order[1:]])
        inter_y1 = np.maximum(y1[i], y1[order[1:]])
        inter_x2 = np.minimum(x2[i], x2[order[1:]])
        inter_y2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(inter_x2 - inter_x1, 0) * np.maximum(inter_y2 - inter_y1, 0)
        iou   = inter / (areas[i] + areas[order[1:]] - inter + 1e-6)
        order = order[1:][iou < iou_thresh]
    return keep


# ─── Инференс ─────────────────────────────────────────────────────────────────

def detect_cards(session: ort.InferenceSession, img_bgr: np.ndarray,
                 conf_thresh=0.40, iou_thresh=0.45):
    """
    Возвращает список (class_id, cx, cy, bw, bh) в нормированных координатах
    относительно оригинального изображения.
    """
    h_orig, w_orig = img_bgr.shape[:2]
    inp, scale, pl, pt = preprocess(img_bgr)

    out = session.run(None, {session.get_inputs()[0].name: inp})[0]  # [1, 56, 8400]
    out = out[0].T  # [8400, 56]

    bboxes_raw = out[:, :4]    # cx, cy, w, h  (in 640-space)
    class_scores = out[:, 4:]  # 52 classes

    best_cls  = class_scores.argmax(axis=1)
    best_conf = class_scores.max(axis=1)

    mask = best_conf >= conf_thresh
    if not mask.any():
        return []

    bboxes_raw = bboxes_raw[mask]
    best_cls   = best_cls[mask]
    best_conf  = best_conf[mask]

    # cx,cy,w,h → x1,y1,x2,y2 in letterbox-space
    x1 = bboxes_raw[:, 0] - bboxes_raw[:, 2] / 2
    y1 = bboxes_raw[:, 1] - bboxes_raw[:, 3] / 2
    x2 = bboxes_raw[:, 0] + bboxes_raw[:, 2] / 2
    y2 = bboxes_raw[:, 1] + bboxes_raw[:, 3] / 2
    boxes = np.stack([x1, y1, x2, y2], axis=1)

    keep = nms(boxes, best_conf, iou_thresh)
    boxes     = boxes[keep]
    best_cls  = best_cls[keep]

    results = []
    for box, cls_id in zip(boxes, best_cls):
        # Убираем паддинг и масштабируем обратно к оригиналу
        bx1 = (box[0] - pl) / scale
        by1 = (box[1] - pt) / scale
        bx2 = (box[2] - pl) / scale
        by2 = (box[3] - pt) / scale

        bx1 = max(0, min(bx1, w_orig))
        by1 = max(0, min(by1, h_orig))
        bx2 = max(0, min(bx2, w_orig))
        by2 = max(0, min(by2, h_orig))

        cx = ((bx1 + bx2) / 2) / w_orig
        cy = ((by1 + by2) / 2) / h_orig
        bw = (bx2 - bx1) / w_orig
        bh = (by2 - by1) / h_orig

        if bw > 0.001 and bh > 0.001:
            results.append((int(cls_id), cx, cy, bw, bh))

    return results


# ─── Запись разметки ─────────────────────────────────────────────────────────

def write_labels(label_path: Path, detections: list):
    with open(label_path, "w") as f:
        for cls_id, cx, cy, bw, bh in detections:
            f.write(f"{cls_id} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}\n")


# ─── Точка входа ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Auto-label cards in dataset")
    parser.add_argument("--dataset", default="dataset",
                        help="Папка с картинками (default: dataset/)")
    parser.add_argument("--model",   default="playing_cards.onnx",
                        help="Путь к ONNX-модели карт")
    parser.add_argument("--conf",    type=float, default=0.40,
                        help="Порог уверенности (default: 0.40)")
    parser.add_argument("--labels-dir", default=None,
                        help="Куда писать .txt (default: рядом с картинкой)")
    args = parser.parse_args()

    dataset_dir = Path(args.dataset)
    model_path  = Path(args.model)

    if not model_path.exists():
        print(f"❌ Модель не найдена: {model_path}")
        print("   Скопируй playing_cards.onnx из artifacts/poker-advisor/public/models/ сюда.")
        sys.exit(1)

    images = sorted([
        p for p in dataset_dir.rglob("*")
        if p.suffix.lower() in (".jpg", ".jpeg", ".png")
    ])
    if not images:
        print(f"❌ Картинки не найдены в {dataset_dir}")
        sys.exit(1)

    print(f"🔍 Загружаю модель: {model_path}")
    session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])

    # Записываем data.yaml
    yaml_path = dataset_dir / "data.yaml"
    with open(yaml_path, "w") as f:
        f.write(f"path: {dataset_dir.resolve()}\n")
        f.write("train: images\nval: images\n\n")
        f.write(f"nc: {len(ALL_CLASSES)}\n")
        f.write("names:\n")
        for cls in ALL_CLASSES:
            f.write(f"  - {cls}\n")
    print(f"✅ Записан data.yaml → {yaml_path}")

    auto = skip = 0
    print(f"\n📸 Обрабатываю {len(images)} кадров...\n")

    for img_path in tqdm(images, unit="img"):
        label_dir  = Path(args.labels_dir) if args.labels_dir else img_path.parent
        label_path = label_dir / (img_path.stem + ".txt")

        # Не перезаписываем если уже есть (там могут быть ручные метки)
        if label_path.exists():
            skip += 1
            continue

        img_bgr = cv2.imread(str(img_path))
        if img_bgr is None:
            continue

        dets = detect_cards(session, img_bgr, conf_thresh=args.conf)
        write_labels(label_path, dets)
        auto += 1

    print(f"\n✅ Готово!")
    print(f"   Авто-размечено: {auto} кадров")
    print(f"   Пропущено (уже есть): {skip} кадров")
    print(f"\nСледующий шаг:")
    print(f"  Открой Roboflow / LabelImg и добавь вручную:")
    for i, cls in enumerate(EXTRA_CLASSES):
        print(f"    [{52+i}] {cls}")


if __name__ == "__main__":
    main()
