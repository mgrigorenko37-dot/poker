"""
collect_templates.py — полуавтоматический сбор шаблонов карт.

Что делает:
  Запускается параллельно с игрой. Захватывает экран,
  для каждого карточного региона запускает EasyOCR с высоким порогом (0.75).
  Когда карта распознана уверенно — сохраняет обрезок в templates/<РАНГ><МАСТЬ>.png.
  Показывает прогресс: сколько из 52 карт уже собрано.

Запуск:
    python collect_templates.py

Просто играй в обычном режиме — скрипт сам всё соберёт.
Обычно хватает 2-3 раздачи чтобы увидеть все 13 рангов.
После окончания нажми Q или дождись сбора всех 52 карт.
"""

import json
import os
import sys
import time
from typing import Optional, Tuple

import cv2
import numpy as np

from card_utils import detect_suit, refine_red_suit

try:
    import easyocr
    import mss
except ImportError:
    print("Установи зависимости: pip install -r requirements.txt")
    sys.exit(1)

CONFIG_PATH   = os.path.join(os.path.dirname(__file__), "config.json")
TEMPLATES_DIR = os.path.join(os.path.dirname(__file__), "templates")

RANKS = list("A K Q J T 9 8 7 6 5 4 3 2".split())
SUITS = ["h", "d", "c", "s"]
ALL_CARDS = {f"{r}{s}" for r in RANKS for s in SUITS}  # 52 карты

RANK_MAP = {
    "a":"A","k":"K","q":"Q","j":"J","10":"T","t":"T",
    "9":"9","8":"8","7":"7","6":"6","5":"5","4":"4","3":"3","2":"2",
    "i":"J","l":"J","1":"A",
}
VALID_RANKS = set(RANKS)

# Порог уверенности для сохранения шаблона
COLLECT_CONFIDENCE = 0.75


# ── Утилиты ───────────────────────────────────────────────────────────────────
def load_config() -> dict:
    if not os.path.exists(CONFIG_PATH):
        print("❌ config.json не найден — сначала запусти python calibrate.py")
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        return json.load(f)

def capture_screen() -> Optional[np.ndarray]:
    try:
        with mss.mss() as sct:
            mon = sct.monitors[1]
            raw = sct.grab(mon)
            return np.frombuffer(raw.rgb, dtype=np.uint8)\
                     .reshape(raw.height, raw.width, 3).copy()
    except Exception as e:
        print(f"Ошибка захвата: {e}")
        return None

def extract_card(frame, cx, cy, cw, ch) -> np.ndarray:
    fh, fw = frame.shape[:2]
    x = int(cx * fw - cw / 2); y = int(cy * fh - ch / 2)
    return frame[max(0,y):min(fh,y+ch), max(0,x):min(fw,x+cw)]

def loaded_cards() -> set:
    """Возвращает набор карт для которых уже есть шаблон."""
    if not os.path.isdir(TEMPLATES_DIR):
        return set()
    found = set()
    for fn in os.listdir(TEMPLATES_DIR):
        if fn.endswith(".png"):
            key = fn[:-4]  # "Ah", "Kd" …
            if key in ALL_CARDS:
                found.add(key)
    return found

def ocr_card_full(reader, crop: np.ndarray) -> Tuple[Optional[str], Optional[str], float]:
    """
    Распознаёт ранг и масть из обрезка карты.
    Возвращает (rank, suit, confidence) или (None, None, 0).
    """
    h, w = crop.shape[:2]
    rank_crop = crop[:max(1, int(h * 0.38)), :max(1, int(w * 0.55))]
    scale = max(1, int(60 / max(1, rank_crop.shape[0])))
    big   = cv2.resize(rank_crop, None, fx=scale*2, fy=scale*2,
                       interpolation=cv2.INTER_CUBIC)
    gray  = cv2.cvtColor(big, cv2.COLOR_RGB2GRAY)
    _, bin_ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    results = reader.readtext(bin_, detail=1, allowlist="AKQJTakqjt23456789 10")
    rank = None
    conf = 0.0
    for (_, text, c) in results:
        t = text.strip().lower().replace(" ", "")
        if "10" in t:
            rank, conf = "T", c; break
        if t:
            m = RANK_MAP.get(t[0], t[0].upper())
            if m in VALID_RANKS:
                rank, conf = m, c; break

    if rank is None:
        return None, None, 0.0

    # Масть через общую функцию из card_utils (поддерживает белые фоны Ton Poker)
    suit = detect_suit(crop)
    if suit == "h":
        suit = refine_red_suit(crop)
    if suit is None:
        return rank, None, 0.0

    return rank, suit, conf


# ── Главный цикл ──────────────────────────────────────────────────────────────
def main():
    cfg = load_config()
    regions = cfg.get("regions", [])
    if len(regions) < 2:
        print("❌ Нет карточных регионов — запусти python calibrate.py")
        sys.exit(1)

    os.makedirs(TEMPLATES_DIR, exist_ok=True)

    print("\n=== Сбор шаблонов карт ===")
    print("Инициализация EasyOCR (может занять ~15 сек)...")
    reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    print("Готов. Просто играй — шаблоны сохраняются автоматически.\n")
    print("Q — выход\n")

    card_h_pct = cfg.get("card_height_pct", 9)

    # Открываем маленькое окно прогресса — нужно для cv2.waitKey()
    STATUS_WIN = "Сбор шаблонов [Q = выход]"
    cv2.namedWindow(STATUS_WIN, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(STATUS_WIN, 520, 60)

    def _draw_status(done: int, total: int) -> None:
        img = np.zeros((60, 520, 3), dtype=np.uint8)
        filled = int(500 * done / max(1, total))
        cv2.rectangle(img, (10, 20), (10 + filled, 40), (0, 200, 80), -1)
        cv2.rectangle(img, (10, 20), (510, 40), (100, 100, 100), 1)
        label = f"{done}/{total} cards"
        cv2.putText(img, label, (10, 58),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (200, 200, 200), 1)
        cv2.imshow(STATUS_WIN, img)

    while True:
        collected = loaded_cards()
        missing   = ALL_CARDS - collected
        done      = len(collected)
        total     = len(ALL_CARDS)

        # ── Статус ──────────────────────────────────────────────────────────
        bar_len = 40
        filled  = int(bar_len * done / total)
        bar     = "█" * filled + "░" * (bar_len - filled)
        print(f"\r[{bar}] {done}/{total}  ", end="", flush=True)
        _draw_status(done, total)

        if not missing:
            print("\n\n✅ Все 52 карты собраны!")
            break

        # ── Захват ──────────────────────────────────────────────────────────
        frame = capture_screen()
        if frame is None:
            time.sleep(0.3)
            continue

        fh, fw = frame.shape[:2]
        ch = max(10, int(fh * card_h_pct / 100))
        cw = max(8,  int(ch * 0.72))

        # ── Каждый регион ───────────────────────────────────────────────────
        for r in regions:
            crop = extract_card(frame, r["cx"], r["cy"], cw, ch)
            if crop.size == 0:
                continue

            rank, suit, conf = ocr_card_full(reader, crop)
            if rank is None or suit is None:
                continue
            if conf < COLLECT_CONFIDENCE:
                continue

            key = f"{rank}{suit}"
            if key not in ALL_CARDS:
                continue
            if key not in missing:
                continue  # уже есть

            # Сохраняем BGR для cv2.imread совместимости
            path = os.path.join(TEMPLATES_DIR, f"{key}.png")
            bgr  = cv2.cvtColor(crop, cv2.COLOR_RGB2BGR)
            cv2.imwrite(path, bgr)
            missing.discard(key)
            print(f"\n  💾 {key}  (уверенность {conf:.2f})  → {path}")

        # ── Клавиша (waitKey работает т.к. STATUS_WIN открыт) ───────────────
        k = cv2.waitKey(1) & 0xFF
        if k in (ord('q'), ord('Q'), 27):   # Q, q, ESC
            break

        time.sleep(0.25)  # 4 FPS достаточно для сбора

    cv2.destroyAllWindows()

    remaining = ALL_CARDS - loaded_cards()
    if remaining:
        print(f"\n⚠️  Не собраны ({len(remaining)}): {', '.join(sorted(remaining))}")
        print("  Продолжай играть и запусти скрипт снова чтобы дособрать их.")
    print("\nГотово. Запускай poker_scanner.py — template matching включится автоматически.")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nОстановлено.")
