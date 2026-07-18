"""
poker_scanner.py — локальный Python-агент для World Poker Club и других браузерных румов.

Что делает:
  1. Захватывает экран через mss (~60 FPS, почти 0% CPU)
  2. Вырезает регионы карт по сохранённой калибровке
  3. Распознаёт ранг через EasyOCR + масть через HSV-анализ
  4. Шлёт JSON на /api/python/scan → GTO расчёт → Telegram

Запуск (после pip install -r requirements.txt и python calibrate.py):
    python poker_scanner.py
"""

import json
import os
import sys
import time
import hashlib
import threading
from typing import Optional

import cv2
import numpy as np
import requests

# EasyOCR — лениво инициализируем при первом скане, чтобы не тормозить старт
_ocr_reader = None
_ocr_lock = threading.Lock()

def get_ocr():
    global _ocr_reader
    if _ocr_reader is None:
        with _ocr_lock:
            if _ocr_reader is None:
                print("Инициализация EasyOCR (первый запуск ~10 сек)...")
                import easyocr
                _ocr_reader = easyocr.Reader(["en"], gpu=False, verbose=False)
                print("EasyOCR готов.\n")
    return _ocr_reader

# ── Константы ─────────────────────────────────────────────────────────────────
CONFIG_PATH = os.path.join(os.path.dirname(__file__), "config.json")

RANK_MAP = {
    "a": "A", "k": "K", "q": "Q", "j": "J",
    "10": "T", "t": "T",
    "9": "9", "8": "8", "7": "7", "6": "6",
    "5": "5", "4": "4", "3": "3", "2": "2",
    # Частые OCR-ошибки → коррекция
    "i": "J", "l": "J", "0": "O",
    "o": "O",   # будет отброшен ниже (не ранг)
    "1": "A",   # бывает что A читается как 1
}

VALID_RANKS = set("A K Q J T 9 8 7 6 5 4 3 2".split())

SCAN_FPS = 5          # кадров в секунду
MIN_CONFIDENCE = 0.3  # порог уверенности EasyOCR (0..1)

# ── Конфиг ────────────────────────────────────────────────────────────────────
def load_config() -> dict:
    if not os.path.exists(CONFIG_PATH):
        print(f"❌ config.json не найден. Сначала запусти: python calibrate.py")
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        return json.load(f)

# ── Захват экрана ─────────────────────────────────────────────────────────────
def capture_screen() -> Optional[np.ndarray]:
    try:
        import mss
        with mss.mss() as sct:
            mon = sct.monitors[1]
            raw = sct.grab(mon)
            img = np.frombuffer(raw.rgb, dtype=np.uint8).reshape(raw.height, raw.width, 3)
            return img.copy()
    except Exception as e:
        print(f"Ошибка захвата экрана: {e}")
        return None

# ── Вырезка региона карты ─────────────────────────────────────────────────────
def extract_card_region(frame: np.ndarray, cx: float, cy: float,
                         card_w: int, card_h: int) -> np.ndarray:
    h, w = frame.shape[:2]
    x = int(cx * w - card_w / 2)
    y = int(cy * h - card_h / 2)
    x1, y1 = max(0, x), max(0, y)
    x2, y2 = min(w, x + card_w), min(h, y + card_h)
    return frame[y1:y2, x1:x2]

# ── Определение масти по цвету ────────────────────────────────────────────────
def detect_suit(card_crop: np.ndarray) -> Optional[str]:
    """
    Медиана насыщенных пикселей (исключаем белый фон и чёрные края).
    Возвращает 'h'/'d'/'c'/'s' или None.
    """
    if card_crop.size == 0:
        return None

    hsv = cv2.cvtColor(card_crop, cv2.COLOR_RGB2HSV)
    h_ch = hsv[:, :, 0].astype(float)
    s_ch = hsv[:, :, 1].astype(float)
    v_ch = hsv[:, :, 2].astype(float)

    # маска насыщенных, не слишком тёмных, не белых пикселей
    mask = (s_ch > 40) & (v_ch > 50) & (v_ch < 240)
    saturated = h_ch[mask]
    if len(saturated) < 5:
        return None

    med = float(np.median(saturated))

    # красный (ломается через 0°/360°)
    if med < 15 or med > 160:
        return "h"   # hearts/diamonds — разберём дальше по яркости
    if med < 50:
        return "d"   # yellow-orange → diamonds (некоторые румы)
    if med < 85:
        return "c"   # green → clubs
    if med < 140:
        return "c"
    return "s"       # blue-purple → spades (тёмные)

def refine_red_suit(card_crop: np.ndarray) -> str:
    """Среди красных мастей: hearts (♥) vs diamonds (♦) по форме."""
    # Простой heuristic: diamonds чуть более orange (hue ~5-10), hearts ~0 или >160
    hsv = cv2.cvtColor(card_crop, cv2.COLOR_RGB2HSV)
    h_ch = hsv[:, :, 0].astype(float)
    s_ch = hsv[:, :, 1].astype(float)
    mask = (s_ch > 40)
    reds = h_ch[mask]
    if len(reds) == 0:
        return "h"
    med = float(np.median(reds))
    return "d" if 5 < med < 20 else "h"

# ── OCR ранга ─────────────────────────────────────────────────────────────────
def ocr_rank(card_crop: np.ndarray) -> Optional[str]:
    """
    Вырезаем верхний-левый угол карты (где ранг), бинаризуем, запускаем EasyOCR.
    """
    if card_crop.size == 0:
        return None

    h, w = card_crop.shape[:2]
    # Берём верхние 35% карты, левую треть — там всегда написан ранг
    rank_crop = card_crop[:max(1, int(h * 0.38)), :max(1, int(w * 0.55))]

    # Апскейл для OCR
    scale = max(1, int(60 / rank_crop.shape[0]))
    enlarged = cv2.resize(rank_crop, None, fx=scale * 2, fy=scale * 2,
                          interpolation=cv2.INTER_CUBIC)

    gray = cv2.cvtColor(enlarged, cv2.COLOR_RGB2GRAY)
    _, binarized = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    try:
        results = get_ocr().readtext(binarized, detail=1, allowlist="AKQJTakqjt23456789 10")
    except Exception:
        return None

    for (_, text, conf) in results:
        if conf < MIN_CONFIDENCE:
            continue
        t = text.strip().lower().replace(" ", "")
        # "10" особый случай
        if "10" in t:
            return "T"
        # берём первый символ
        if t:
            mapped = RANK_MAP.get(t[0], t[0].upper())
            if mapped in VALID_RANKS:
                return mapped
    return None

# ── Распознавание одной карты ─────────────────────────────────────────────────
def recognize_card(frame: np.ndarray, cx: float, cy: float,
                   card_w: int, card_h: int) -> Optional[str]:
    """Возвращает строку типа 'Ah', 'Kd', 'Tc' или None."""
    crop = extract_card_region(frame, cx, cy, card_w, card_h)
    if crop.size == 0:
        return None

    rank = ocr_rank(crop)
    if not rank:
        return None

    suit = detect_suit(crop)
    if not suit:
        return None

    if suit == "h":
        suit = refine_red_suit(crop)

    return f"{rank}{suit}"

# ── Проверка — борд пустой? ───────────────────────────────────────────────────
def looks_empty(crop: np.ndarray) -> bool:
    """Тёмный или очень однородный регион = скорее всего пустой слот."""
    if crop.size == 0:
        return True
    gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY).astype(float)
    return float(np.mean(gray)) < 30 or float(np.std(gray)) < 8

# ── Отправка на сервер ────────────────────────────────────────────────────────
_last_key: str = ""

def send_scan(cfg: dict, hole: list[str], board: list[str]) -> None:
    global _last_key

    payload = {
        "holeCards": hole,
        "boardCards": board,
        "potSize": 0,         # TODO Этап 3: PaddleOCR для чисел
        "betToCall": 0,
        "players": cfg.get("players", 6),
        "position": cfg.get("position", "BTN"),
    }

    key = hashlib.md5(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    if key == _last_key:
        return  # ничего не изменилось — не спамим
    _last_key = key

    url = cfg["server_url"]
    try:
        r = requests.post(url, json=payload, timeout=4)
        data = r.json()
        action = data.get("action", "?")
        equity = round((data.get("equity") or 0) * 100)
        print(f"  → {action}  Win {equity}%  |  {' '.join(hole)} | {' '.join(board)}")
    except requests.exceptions.ConnectionError:
        print(f"  ⚠️  Сервер недоступен ({url[:40]}…)")
    except Exception as e:
        print(f"  ⚠️  Ошибка запроса: {e}")

# ── Дублирование карт ─────────────────────────────────────────────────────────
def has_duplicates(cards: list[str]) -> bool:
    return len(cards) != len(set(cards))

# ── Основной цикл ─────────────────────────────────────────────────────────────
def main():
    cfg = load_config()
    regions = cfg.get("regions", [])
    if len(regions) < 5:
        print("❌ В config.json меньше 5 регионов. Запусти python calibrate.py")
        sys.exit(1)

    server_url = cfg.get("server_url", "")
    if "ТВОЙ_ДОМЕН" in server_url or not server_url:
        print("❌ Укажи server_url в config.json (URL твоего Replit-приложения)")
        sys.exit(1)

    hole_regs  = regions[:2]
    board_regs = regions[2:]

    interval = 1.0 / SCAN_FPS
    card_h_pct = cfg.get("card_height_pct", 9)

    print(f"Сканирование запущено ({SCAN_FPS} FPS). Ctrl+C для остановки.\n")

    # Прогрев OCR в фоне чтобы не тормозить первый скан
    threading.Thread(target=get_ocr, daemon=True).start()

    while True:
        t0 = time.perf_counter()

        frame = capture_screen()
        if frame is None:
            time.sleep(interval)
            continue

        fh, fw = frame.shape[:2]
        card_h = max(10, int(fh * card_h_pct / 100))
        card_w = max(8, int(card_h * 0.72))

        # Распознаём в одном потоке (EasyOCR не thread-safe на GPU)
        hole: list[str] = []
        for r in hole_regs:
            card = recognize_card(frame, r["cx"], r["cy"], card_w, card_h)
            if card:
                hole.append(card)

        if len(hole) < 2:
            # Нет своих карт — рука ещё не началась или между раздачами
            elapsed = time.perf_counter() - t0
            time.sleep(max(0, interval - elapsed))
            continue

        board: list[str] = []
        for r in board_regs:
            crop = extract_card_region(frame, r["cx"], r["cy"], card_w, card_h)
            if looks_empty(crop):
                continue
            card = recognize_card(frame, r["cx"], r["cy"], card_w, card_h)
            if card:
                board.append(card)

        all_cards = hole + board
        if has_duplicates(all_cards):
            # Невозможная комбинация = OCR ошибся, пропускаем кадр
            continue

        send_scan(cfg, hole, board)

        elapsed = time.perf_counter() - t0
        time.sleep(max(0, interval - elapsed))

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nОстановлено.")
