"""
debug_detector.py — визуальная проверка авто-детекта стола.

Запуск:
    python debug_detector.py

Что делает:
  1. Делает скриншот
  2. Ищет зелёный стол через table_detector
  3. Рисует на скриншоте:
       — зелёный прямоугольник   = bbox стола
       — синие кружки            = зоны hole-карт (твои)
       — жёлтые кружки           = зоны борд-карт
       — оранжевые кружки        = зоны мест оппонентов
       — красный прямоугольник   = зона банка
  4. Сохраняет debug_output.png и показывает в окне

Если кружки не попадают на карты — подправь HSV-диапазон
в table_detector.py (_HSV_LO / _HSV_HI) и запусти снова.
"""

import sys
import os
import cv2
import numpy as np

# Добавляем папку python/ в путь (на случай запуска из другой директории)
sys.path.insert(0, os.path.dirname(__file__))

from table_detector import find_table, compute_regions, _HSV_LO, _HSV_HI

try:
    import mss
except ImportError:
    print("Установи зависимости: pip install -r requirements.txt")
    sys.exit(1)


OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "debug_output.png")


def capture() -> np.ndarray:
    with mss.MSS() as sct:
        monitor = sct.monitors[1]
        raw = sct.grab(monitor)
        return np.frombuffer(raw.raw, dtype=np.uint8).reshape(
            (raw.height, raw.width, 4)
        )[:, :, :3].copy()   # RGB


def draw_regions(frame: np.ndarray, bbox, regions_dict: dict) -> np.ndarray:
    vis = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
    fh, fw = vis.shape[:2]

    # ── Bbox стола ────────────────────────────────────────────────────────────
    bx, by, bw, bh = bbox
    cv2.rectangle(vis, (bx, by), (bx + bw, by + bh), (0, 200, 0), 3)
    cv2.putText(vis, f"TABLE  {bw}x{bh}  {regions_dict['layout']}",
                (bx + 6, by + 28), cv2.FONT_HERSHEY_SIMPLEX, 0.75, (0, 200, 0), 2)

    def dot(cx_n, cy_n, color, label, r=14):
        px, py = int(cx_n * fw), int(cy_n * fh)
        cv2.circle(vis, (px, py), r, color, 2)
        cv2.putText(vis, label, (px + r + 3, py + 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)

    # ── Карты ─────────────────────────────────────────────────────────────────
    for r in regions_dict["regions"]:
        lbl = r["label"]
        if lbl.startswith("Hole"):
            dot(r["cx"], r["cy"], (255, 80,  80),  lbl)    # синий (BGR: R=80,G=80,B=255)
        else:
            dot(r["cx"], r["cy"], (0,   210, 210), lbl)    # жёлтый

    # ── Зоны мест оппонентов ──────────────────────────────────────────────────
    for i, s in enumerate(regions_dict["seat_regions"]):
        dot(s["cx"], s["cy"], (0, 140, 255), f"Seat{i+1}", r=10)

    # ── Банк ──────────────────────────────────────────────────────────────────
    pot = regions_dict["money_regions"].get("pot")
    if pot:
        x1 = int(pot["x1"] * fw); y1 = int(pot["y1"] * fh)
        x2 = int(pot["x2"] * fw); y2 = int(pot["y2"] * fh)
        cv2.rectangle(vis, (x1, y1), (x2, y2), (0, 0, 220), 2)
        cv2.putText(vis, "POT", (x1, y1 - 4),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 220), 1)

    return vis


def show_hsv_mask(frame: np.ndarray):
    """Показывает что именно видит HSV-маска — для отладки диапазона."""
    hsv  = cv2.cvtColor(frame, cv2.COLOR_RGB2HSV)
    mask = cv2.inRange(hsv, _HSV_LO, _HSV_HI)
    import cv2 as _cv
    kernel = _cv.getStructuringElement(_cv.MORPH_ELLIPSE, (5, 5))
    mask   = _cv.morphologyEx(mask, _cv.MORPH_OPEN,  kernel)
    mask   = _cv.morphologyEx(mask, _cv.MORPH_CLOSE, kernel)
    # Покрашиваем маску зелёным поверх оригинала
    overlay = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
    overlay[mask > 0] = (0, 180, 60)
    return overlay


def main():
    print("Захват экрана...")
    frame = capture()
    print(f"Размер: {frame.shape[1]}×{frame.shape[0]}")

    # ── Маска ─────────────────────────────────────────────────────────────────
    mask_vis = show_hsv_mask(frame)
    cv2.imwrite(OUTPUT_PATH.replace(".png", "_mask.png"), mask_vis)
    print(f"HSV-маска: {OUTPUT_PATH.replace('.png', '_mask.png')}")

    # ── Детект стола ──────────────────────────────────────────────────────────
    bbox = find_table(frame)

    if bbox is None:
        print("\n❌ Стол НЕ найден!")
        print("   Возможные причины:")
        print("   1. Окно Ton Poker свёрнуто или не открыто")
        print("   2. HSV-диапазон не подходит — посмотри debug_output_mask.png")
        print("      и подправь _HSV_LO/_HSV_HI в table_detector.py")
        # Всё равно сохраняем скриншот для анализа
        bgr = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
        cv2.imwrite(OUTPUT_PATH, bgr)
        print(f"   Скриншот сохранён: {OUTPUT_PATH}")
        cv2.imshow("Debug — стол не найден (маска)", mask_vis)
        cv2.waitKey(0)
        return

    bx, by, bw, bh = bbox
    print(f"\n✅ Стол найден!")
    print(f"   bbox: x={bx} y={by} w={bw} h={bh}")
    print(f"   aspect ratio: {bw/bh:.2f}  →  {'landscape' if bw >= bh else 'portrait'}")

    # ── Регионы ───────────────────────────────────────────────────────────────
    regions_dict = compute_regions(bbox, frame)

    print(f"\n📍 Регионы ({regions_dict['layout']}):")
    for r in regions_dict["regions"]:
        print(f"   {r['label']:8s}  cx={r['cx']:.4f}  cy={r['cy']:.4f}")
    pot = regions_dict["money_regions"].get("pot", {})
    print(f"   Pot zone:  x1={pot.get('x1','?'):.4f}  y1={pot.get('y1','?'):.4f}"
          f"  x2={pot.get('x2','?'):.4f}  y2={pot.get('y2','?'):.4f}")
    print(f"\n👥 Зоны мест оппонентов ({len(regions_dict['seat_regions'])} шт.):")
    for i, s in enumerate(regions_dict["seat_regions"]):
        print(f"   Seat{i+1}: cx={s['cx']:.4f}  cy={s['cy']:.4f}")

    # ── Визуализация ──────────────────────────────────────────────────────────
    vis = draw_regions(frame, bbox, regions_dict)
    cv2.imwrite(OUTPUT_PATH, vis)
    print(f"\n💾 Сохранено: {OUTPUT_PATH}")

    print("\n🔍 Легенда:")
    print("   Зелёный прямоугольник  = стол")
    print("   Синие кружки           = hole-карты (твои)")
    print("   Жёлтые кружки          = борд")
    print("   Оранжевые кружки       = места оппонентов")
    print("   Красный прямоугольник  = зона банка")
    print("\nЕсли кружки не совпадают с картами — сообщи, скорректируем пропорции.")

    # Показываем окно (если есть дисплей)
    try:
        cv2.imshow("Debug — авто-детект регионов", vis)
        print("\nНажми любую клавишу для закрытия окна...")
        cv2.waitKey(0)
        cv2.destroyAllWindows()
    except Exception:
        print("(GUI недоступен — смотри файл debug_output.png)")


if __name__ == "__main__":
    main()
