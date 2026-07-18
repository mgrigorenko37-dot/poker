"""
poker_scanner.py — локальный Python-агент для World Poker Club и других браузерных румов.

Что делает:
  1. Захватывает экран через mss (~60 FPS, почти 0% CPU)
  2. Вырезает регионы карт по сохранённой калибровке
  3. Распознаёт ранг через EasyOCR + масть через HSV-анализ
  4. Читает банк и ставку/колл из откалиброванных прямоугольников (Этап 3)
  5. Шлёт JSON на /api/python/scan → GTO расчёт → Telegram

Запуск (после pip install -r requirements.txt и python calibrate.py):
    python poker_scanner.py
"""

import json
import os
import re
import sys
import time
import hashlib
import threading
from typing import Optional

import cv2
import numpy as np
import requests

# ── EasyOCR — ленивая инициализация ─────────────────────────────────────────
_ocr_reader = None
_ocr_lock   = threading.Lock()

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
    "i": "J", "l": "J",
    "1": "A",
}
VALID_RANKS = set("A K Q J T 9 8 7 6 5 4 3 2".split())

SCAN_FPS        = 5     # кадров в секунду
MIN_RANK_CONF   = 0.3   # порог уверенности EasyOCR для ранга
MIN_MONEY_CONF  = 0.2   # порог для чисел (ниже, т.к. шрифты маленькие)

# ── Конфиг ────────────────────────────────────────────────────────────────────
def load_config() -> dict:
    if not os.path.exists(CONFIG_PATH):
        print("❌ config.json не найден. Сначала запусти: python calibrate.py")
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
        print(f"Ошибка захвата: {e}")
        return None

# ── Вырезка региона карты (по центру + размер) ────────────────────────────────
def extract_card_region(frame: np.ndarray, cx: float, cy: float,
                        cw: int, ch: int) -> np.ndarray:
    fh, fw = frame.shape[:2]
    x = int(cx * fw - cw / 2)
    y = int(cy * fh - ch / 2)
    x1, y1 = max(0, x), max(0, y)
    x2, y2 = min(fw, x + cw), min(fh, y + ch)
    return frame[y1:y2, x1:x2]

# ── Вырезка денежного региона (по прямоугольнику из calibrate) ───────────────
def extract_money_region(frame: np.ndarray, region: dict) -> np.ndarray:
    fh, fw = frame.shape[:2]
    x1 = int(region["x1"] * fw)
    y1 = int(region["y1"] * fh)
    x2 = int(region["x2"] * fw)
    y2 = int(region["y2"] * fh)
    return frame[max(0,y1):min(fh,y2), max(0,x1):min(fw,x2)]

# ── Определение масти ─────────────────────────────────────────────────────────
def detect_suit(crop: np.ndarray) -> Optional[str]:
    if crop.size == 0:
        return None
    hsv = cv2.cvtColor(crop, cv2.COLOR_RGB2HSV)
    h_ch = hsv[:, :, 0].astype(float)
    s_ch = hsv[:, :, 1].astype(float)
    v_ch = hsv[:, :, 2].astype(float)
    mask = (s_ch > 40) & (v_ch > 50) & (v_ch < 240)
    sat = h_ch[mask]
    if len(sat) < 5:
        return None
    med = float(np.median(sat))
    if med < 15 or med > 160:
        return "h"
    if med < 50:
        return "d"
    if med < 85:
        return "c"
    if med < 140:
        return "c"
    return "s"

def refine_red_suit(crop: np.ndarray) -> str:
    hsv = cv2.cvtColor(crop, cv2.COLOR_RGB2HSV)
    h_ch = hsv[:, :, 0].astype(float)
    s_ch = hsv[:, :, 1].astype(float)
    reds = h_ch[s_ch > 40]
    if len(reds) == 0:
        return "h"
    return "d" if 5 < float(np.median(reds)) < 20 else "h"

# ── OCR ранга карты ───────────────────────────────────────────────────────────
def ocr_rank(crop: np.ndarray) -> Optional[str]:
    if crop.size == 0:
        return None
    h, w = crop.shape[:2]
    rank_crop = crop[:max(1, int(h * 0.38)), :max(1, int(w * 0.55))]
    scale = max(1, int(60 / max(1, rank_crop.shape[0])))
    enlarged = cv2.resize(rank_crop, None, fx=scale * 2, fy=scale * 2,
                          interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(enlarged, cv2.COLOR_RGB2GRAY)
    _, binarized = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    try:
        results = get_ocr().readtext(binarized, detail=1,
                                     allowlist="AKQJTakqjt23456789 10")
    except Exception:
        return None
    for (_, text, conf) in results:
        if conf < MIN_RANK_CONF:
            continue
        t = text.strip().lower().replace(" ", "")
        if "10" in t:
            return "T"
        if t:
            mapped = RANK_MAP.get(t[0], t[0].upper())
            if mapped in VALID_RANKS:
                return mapped
    return None

# ── OCR числа (банк / ставка) — Этап 3 ───────────────────────────────────────
def parse_number(text: str) -> Optional[float]:
    """
    Разбирает OCR-строку в число.
    Примеры входа: "40 413", "10K", "1.5M", "$3.50", "10 / 20", "3.6К" (кириллица)

    Логика:
      - убираем $, пробелы, запятые
      - если содержит "/" — берём ПЕРВОЕ число (это bet-to-call формат "ставка/банк")
      - суффикс K/к/К → ×1 000, M/м/М → ×1 000 000
    """
    text = text.strip()
    if not text:
        return None

    # формат "10 / 20" → берём первую часть
    if "/" in text:
        text = text.split("/")[0]

    # убираем $, пробелы-разделители тысяч, запятые
    text = re.sub(r"[$, ]", "", text)
    text = text.replace(",", ".")

    # суффикс (K/K кирилл/М/m)
    multiplier = 1.0
    suffix = text[-1].lower() if text else ""
    if suffix in ("k", "к"):       # latin K или кириллица К
        multiplier = 1_000
        text = text[:-1]
    elif suffix in ("m", "м"):
        multiplier = 1_000_000
        text = text[:-1]

    try:
        return float(text) * multiplier
    except ValueError:
        return None

def ocr_number(frame: np.ndarray, region: dict) -> Optional[float]:
    """
    Извлекает число из денежного прямоугольника.
    Препроцессинг: апскейл × 3, адаптивный порог, инверсия если фон тёмный.
    """
    crop = extract_money_region(frame, region)
    if crop.size == 0 or crop.shape[0] < 4 or crop.shape[1] < 4:
        return None

    # апскейл — OCR лучше работает на крупном тексте
    scale = max(1, int(40 / max(1, crop.shape[0])))
    big = cv2.resize(crop, None, fx=scale * 3, fy=scale * 3,
                     interpolation=cv2.INTER_CUBIC)

    gray = cv2.cvtColor(big, cv2.COLOR_RGB2GRAY)

    # инвертируем если фон тёмный (белый текст на тёмном)
    if float(np.mean(gray)) < 128:
        gray = cv2.bitwise_not(gray)

    # адаптивный порог лучше справляется с градиентными фонами покер-румов
    binarized = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY, 15, 8
    )

    # разрешаем цифры, точку, запятую, пробел, K/M и слэш (для "bet/pot" форматов)
    allowlist = "0123456789.,KkMmКкМм $/"
    try:
        results = get_ocr().readtext(binarized, detail=1, allowlist=allowlist,
                                     paragraph=False)
    except Exception:
        return None

    best_conf = 0.0
    best_val: Optional[float] = None

    for (_, text, conf) in results:
        if conf < MIN_MONEY_CONF:
            continue
        val = parse_number(text)
        if val is not None and val > 0 and conf > best_conf:
            best_conf = conf
            best_val  = val

    return best_val

# ── Борд пустой? ─────────────────────────────────────────────────────────────
def looks_empty(crop: np.ndarray) -> bool:
    if crop.size == 0:
        return True
    gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY).astype(float)
    return float(np.mean(gray)) < 30 or float(np.std(gray)) < 8

# ── Распознать одну карту ─────────────────────────────────────────────────────
def recognize_card(frame: np.ndarray, cx: float, cy: float,
                   cw: int, ch: int) -> Optional[str]:
    crop = extract_card_region(frame, cx, cy, cw, ch)
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

# ── Дублирование карт ─────────────────────────────────────────────────────────
def has_duplicates(cards: list) -> bool:
    return len(cards) != len(set(cards))

# ── Отправка на сервер ────────────────────────────────────────────────────────
_last_key = ""

def send_scan(cfg: dict, hole: list, board: list,
              pot: Optional[float], bet: Optional[float]) -> None:
    global _last_key

    payload = {
        "holeCards":  hole,
        "boardCards": board,
        "potSize":    round(pot, 2)  if pot  is not None else 0,
        "betToCall":  round(bet, 2)  if bet  is not None else 0,
        "players":    cfg.get("players", 6),
        "position":   cfg.get("position", "BTN"),
    }

    key = hashlib.md5(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    if key == _last_key:
        return
    _last_key = key

    url = cfg["server_url"]
    try:
        r    = requests.post(url, json=payload, timeout=4)
        data = r.json()
        action = data.get("action", "?")
        equity = round((data.get("equity") or 0) * 100)
        pot_str = f"  банк={pot:.0f}" if pot else ""
        bet_str = f"  колл={bet:.0f}" if bet else ""
        print(f"  → {action}  Win {equity}%  |  {' '.join(hole)} | {' '.join(board)}{pot_str}{bet_str}")
    except requests.exceptions.ConnectionError:
        print(f"  ⚠️  Сервер недоступен ({url[:50]}…)")
    except Exception as e:
        print(f"  ⚠️  Ошибка запроса: {e}")

# ── Основной цикл ─────────────────────────────────────────────────────────────
def main():
    cfg = load_config()

    regions = cfg.get("regions", [])
    if len(regions) < 5:
        print("❌ Меньше 5 карточных регионов. Запусти: python calibrate.py")
        sys.exit(1)

    url = cfg.get("server_url", "")
    if "ТВОЙ_ДОМЕН" in url or not url:
        print("❌ Укажи server_url в config.json")
        sys.exit(1)

    money_regions: dict = cfg.get("money_regions", {})
    has_pot = "pot" in money_regions
    has_bet = "bet" in money_regions

    if has_pot:
        print(f"💰 Банк: OCR по откалиброванной области")
    else:
        print("💰 Банк: не откалиброван (будет 0) — запусти calibrate.py для настройки")

    if has_bet:
        print(f"💰 Колл: OCR по откалиброванной области")
    else:
        print("💰 Колл: не откалиброван (будет 0)")

    hole_regs  = regions[:2]
    board_regs = regions[2:]
    interval   = 1.0 / SCAN_FPS
    card_h_pct = cfg.get("card_height_pct", 9)

    print(f"\nСканирование запущено ({SCAN_FPS} FPS). Ctrl+C для остановки.\n")
    threading.Thread(target=get_ocr, daemon=True).start()

    while True:
        t0 = time.perf_counter()

        frame = capture_screen()
        if frame is None:
            time.sleep(interval)
            continue

        fh, fw = frame.shape[:2]
        card_h = max(10, int(fh * card_h_pct / 100))
        card_w = max(8,  int(card_h * 0.72))

        # ── Карты ──────────────────────────────────────────────────────────────
        hole: list[str] = []
        for r in hole_regs:
            c = recognize_card(frame, r["cx"], r["cy"], card_w, card_h)
            if c:
                hole.append(c)

        if len(hole) < 2:
            time.sleep(max(0, interval - (time.perf_counter() - t0)))
            continue

        board: list[str] = []
        for r in board_regs:
            crop = extract_card_region(frame, r["cx"], r["cy"], card_w, card_h)
            if looks_empty(crop):
                continue
            c = recognize_card(frame, r["cx"], r["cy"], card_w, card_h)
            if c:
                board.append(c)

        if has_duplicates(hole + board):
            time.sleep(max(0, interval - (time.perf_counter() - t0)))
            continue

        # ── Деньги (Этап 3) ────────────────────────────────────────────────────
        pot: Optional[float] = None
        bet: Optional[float] = None

        if has_pot:
            pot = ocr_number(frame, money_regions["pot"])

        if has_bet:
            bet = ocr_number(frame, money_regions["bet"])

        send_scan(cfg, hole, board, pot, bet)

        time.sleep(max(0, interval - (time.perf_counter() - t0)))

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nОстановлено.")
