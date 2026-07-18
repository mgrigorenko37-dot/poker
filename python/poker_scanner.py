"""
poker_scanner.py — локальный Python-агент для World Poker Club и других браузерных румов.

Что делает:
  1. Захватывает экран через mss (~60 FPS, почти 0% CPU)
  2. Распознаёт карты через template matching (cv2) если шаблоны собраны,
     иначе падает на EasyOCR (автоматически, без ручного переключения)
  3. Читает банк и ставку/колл через OCR откалиброванных прямоугольников
  4. Шлёт JSON на /api/python/scan → GTO расчёт → Telegram

Запуск:
    python poker_scanner.py

Порядок подготовки:
  1. pip install -r requirements.txt
  2. python calibrate.py        ← карты + деньги
  3. python collect_templates.py   ← собрать 52 шаблона (играя как обычно)
  4. python poker_scanner.py
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

from card_utils import detect_suit, refine_red_suit, extract_card_region, looks_empty

# ── EasyOCR — fallback когда нет шаблона ────────────────────────────────────
_ocr_reader = None
_ocr_lock   = threading.Lock()

def get_ocr():
    global _ocr_reader
    if _ocr_reader is None:
        with _ocr_lock:
            if _ocr_reader is None:
                print("Инициализация EasyOCR (fallback, первый запуск ~10 сек)...")
                import easyocr
                _ocr_reader = easyocr.Reader(["en"], gpu=False, verbose=False)
                print("EasyOCR готов.\n")
    return _ocr_reader

# ── Константы ─────────────────────────────────────────────────────────────────
CONFIG_PATH    = os.path.join(os.path.dirname(__file__), "config.json")
TEMPLATES_DIR  = os.path.join(os.path.dirname(__file__), "templates")

RANK_MAP = {
    "a":"A","k":"K","q":"Q","j":"J","10":"T","t":"T",
    "9":"9","8":"8","7":"7","6":"6","5":"5","4":"4","3":"3","2":"2",
    "i":"J","l":"J","1":"A",
}
VALID_RANKS     = set("A K Q J T 9 8 7 6 5 4 3 2".split())
SCAN_FPS        = 5
MIN_RANK_CONF   = 0.3
MIN_MONEY_CONF  = 0.2
TMPL_THRESHOLD  = 0.82   # минимальный TM_CCOEFF_NORMED для принятия шаблона

# ── Конфиг ────────────────────────────────────────────────────────────────────
def load_config() -> dict:
    if not os.path.exists(CONFIG_PATH):
        print("❌ config.json не найден. Запусти: python calibrate.py")
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        return json.load(f)

# ── Template matching ─────────────────────────────────────────────────────────
# Шаблоны загружаются один раз при старте.
# Структура: { "Ah": <grayscale ndarray>, "Kd": ..., … }
_templates: dict[str, np.ndarray] = {}

def load_templates() -> dict[str, np.ndarray]:
    """Загрузить все PNG из папки templates/ и вернуть словарь карта→оттенки."""
    tmpl: dict[str, np.ndarray] = {}
    if not os.path.isdir(TEMPLATES_DIR):
        return tmpl
    for fn in sorted(os.listdir(TEMPLATES_DIR)):
        if not fn.endswith(".png"):
            continue
        key = fn[:-4]  # "Ah", "Kd" …
        img = cv2.imread(os.path.join(TEMPLATES_DIR, fn), cv2.IMREAD_GRAYSCALE)
        if img is not None:
            tmpl[key] = img
    return tmpl

def match_template(crop_rgb: np.ndarray) -> tuple[Optional[str], float]:
    """
    Сравнивает crop со всеми загруженными шаблонами.
    Шаблон и crop масштабируются к одному размеру (размер шаблона).
    Возвращает (лучший_ключ, score) или (None, 0).
    """
    if not _templates or crop_rgb.size == 0:
        return None, 0.0

    gray = cv2.cvtColor(crop_rgb, cv2.COLOR_RGB2GRAY)

    best_key   = None
    best_score = 0.0

    for key, tmpl in _templates.items():
        # масштабируем crop до размера шаблона
        if gray.shape != tmpl.shape:
            resized = cv2.resize(gray, (tmpl.shape[1], tmpl.shape[0]),
                                 interpolation=cv2.INTER_AREA)
        else:
            resized = gray

        result = cv2.matchTemplate(resized, tmpl, cv2.TM_CCOEFF_NORMED)
        score  = float(result.max())
        if score > best_score:
            best_score = score
            best_key   = key

    if best_score >= TMPL_THRESHOLD:
        return best_key, best_score
    return None, best_score

# ── Захват экрана ─────────────────────────────────────────────────────────────
def capture_screen() -> Optional[np.ndarray]:
    try:
        import mss
        with mss.mss() as sct:
            mon = sct.monitors[1]
            raw = sct.grab(mon)
            return np.frombuffer(raw.rgb, dtype=np.uint8)\
                     .reshape(raw.height, raw.width, 3).copy()
    except Exception as e:
        print(f"Ошибка захвата: {e}")
        return None

# ── Вырезка денежного региона ────────────────────────────────────────────────
def extract_money_region(frame, region: dict) -> np.ndarray:
    fh, fw = frame.shape[:2]
    x1 = int(region["x1"] * fw); y1 = int(region["y1"] * fh)
    x2 = int(region["x2"] * fw); y2 = int(region["y2"] * fh)
    return frame[max(0,y1):min(fh,y2), max(0,x1):min(fw,x2)]

# ── OCR ранга (fallback) ──────────────────────────────────────────────────────
def ocr_rank(crop: np.ndarray) -> Optional[str]:
    if crop.size == 0:
        return None
    h, w = crop.shape[:2]
    rc = crop[:max(1,int(h*.38)), :max(1,int(w*.55))]
    sc = max(1, int(60 / max(1, rc.shape[0])))
    big = cv2.resize(rc, None, fx=sc*2, fy=sc*2, interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(big, cv2.COLOR_RGB2GRAY)
    _, bin_ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    try:
        results = get_ocr().readtext(bin_, detail=1,
                                     allowlist="AKQJTakqjt23456789 10")
    except Exception:
        return None
    for (_, text, conf) in results:
        if conf < MIN_RANK_CONF:
            continue
        t = text.strip().lower().replace(" ","")
        if "10" in t: return "T"
        if t:
            m = RANK_MAP.get(t[0], t[0].upper())
            if m in VALID_RANKS:
                return m
    return None

# ── Распознать одну карту ─────────────────────────────────────────────────────
_tmpl_hits  = 0   # счётчики для статистики в терминале
_ocr_hits   = 0
_misses     = 0

def recognize_card(frame, cx, cy, cw, ch) -> Optional[str]:
    global _tmpl_hits, _ocr_hits, _misses
    crop = extract_card_region(frame, cx, cy, cw, ch)
    if crop.size == 0:
        return None

    # ── Сначала пробуем template matching ────────────────────────────────────
    card, score = match_template(crop)
    if card:
        _tmpl_hits += 1
        return card

    # ── Fallback: EasyOCR ────────────────────────────────────────────────────
    rank = ocr_rank(crop)
    if not rank:
        _misses += 1
        return None
    suit = detect_suit(crop)
    if not suit:
        _misses += 1
        return None
    if suit == "h":
        suit = refine_red_suit(crop)
    _ocr_hits += 1
    return f"{rank}{suit}"

# ── OCR числа (банк/ставка) ───────────────────────────────────────────────────
def parse_number(text: str) -> Optional[float]:
    """
    Разбирает OCR-строку в число.
    Примеры: "40 413", "10K", "1.5M", "$3.50", "10 / 20", "1,5" (евро), "1.234,56" (евро)
    """
    text = text.strip()
    if not text: return None
    # Если формат "ставка / банк" — берём первую часть
    if "/" in text: text = text.split("/")[0].strip()
    # Убираем знак доллара
    text = text.replace("$", "")
    # Суффикс K/M определяем ДО обработки разделителей
    multiplier = 1.0
    if text:
        s = text[-1].lower()
        if s in ("k", "к"):    multiplier = 1_000;     text = text[:-1]
        elif s in ("m", "м"):  multiplier = 1_000_000; text = text[:-1]
    # Обработка разделителей:
    # Если одновременно есть и точки и запятые — европейский формат "1.234,56"
    if "." in text and "," in text:
        text = text.replace(".", "").replace(",", ".")   # убрать тыс. разд., десят. → точка
    else:
        # Только запятые (европейская десятичная: "1,5") → точка
        # Только точки (стандарт: "1.5" или тыс. разд. "1.234") → оставить
        text = text.replace(",", ".")
    # Убираем пробелы (тысячные разделители: "40 413")
    text = text.replace(" ", "")
    try:
        return float(text) * multiplier
    except ValueError:
        return None

def ocr_number(frame: np.ndarray, region: dict) -> Optional[float]:
    crop = extract_money_region(frame, region)
    if crop.size == 0 or crop.shape[0] < 4 or crop.shape[1] < 4:
        return None
    scale = max(1, int(40 / max(1, crop.shape[0])))
    big   = cv2.resize(crop, None, fx=scale*3, fy=scale*3,
                       interpolation=cv2.INTER_CUBIC)
    gray  = cv2.cvtColor(big, cv2.COLOR_RGB2GRAY)
    if float(np.mean(gray)) < 128:
        gray = cv2.bitwise_not(gray)
    binarized = cv2.adaptiveThreshold(gray, 255,
                    cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 15, 8)
    try:
        results = get_ocr().readtext(binarized, detail=1,
                                     allowlist="0123456789.,KkMmКкМм $/",
                                     paragraph=False)
    except Exception:
        return None
    best_conf = 0.0; best_val: Optional[float] = None
    for (_, text, conf) in results:
        if conf < MIN_MONEY_CONF: continue
        val = parse_number(text)
        if val is not None and val > 0 and conf > best_conf:
            best_conf = conf; best_val = val
    return best_val

# ── Дубли ────────────────────────────────────────────────────────────────────
def has_duplicates(cards: list) -> bool:
    return len(cards) != len(set(cards))

# ── Отправка ─────────────────────────────────────────────────────────────────
_last_key = ""

def send_scan(cfg, hole, board, pot, bet) -> None:
    global _last_key
    payload = {
        "holeCards":  hole,
        "boardCards": board,
        "potSize":    round(pot, 2) if pot is not None else 0,
        "betToCall":  round(bet, 2) if bet is not None else 0,
        "players":    cfg.get("players", 6),
        "position":   cfg.get("position", "BTN"),
    }
    key = hashlib.md5(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    if key == _last_key: return
    _last_key = key
    url = cfg["server_url"]
    try:
        r    = requests.post(url, json=payload, timeout=4)
        data = r.json()
        action = data.get("action", "?")
        equity = round((data.get("equity") or 0) * 100)
        pot_s  = f"  банк={pot:.0f}" if pot else ""
        bet_s  = f"  колл={bet:.0f}" if bet else ""
        print(f"  → {action}  Win {equity}%  |  {' '.join(hole)} | {' '.join(board)}{pot_s}{bet_s}")
    except requests.exceptions.ConnectionError:
        print(f"  ⚠️  Сервер недоступен ({url[:50]}…)")
    except Exception as e:
        print(f"  ⚠️  Ошибка: {e}")

# ── Основной цикл ─────────────────────────────────────────────────────────────
def main():
    global _tmpl_hits, _ocr_hits, _misses

    cfg     = load_config()
    regions = cfg.get("regions", [])
    if len(regions) < 5:
        print("❌ Меньше 5 регионов — запусти: python calibrate.py")
        sys.exit(1)
    url = cfg.get("server_url", "")
    if "ТВОЙ_ДОМЕН" in url or not url:
        print("❌ Укажи server_url в config.json")
        sys.exit(1)

    # ── Шаблоны ──────────────────────────────────────────────────────────────
    _templates.update(load_templates())
    n_tmpl = len(_templates)
    if n_tmpl > 0:
        print(f"🃏 Template matching: загружено {n_tmpl}/52 шаблонов")
        if n_tmpl < 52:
            missing = 52 - n_tmpl
            print(f"   (не хватает {missing} карт — fallback на EasyOCR для них)")
    else:
        print("🃏 Шаблоны не найдены → только EasyOCR")
        print("   Для точности 99.9% запусти: python collect_templates.py")

    # ── Деньги ───────────────────────────────────────────────────────────────
    money_regions: dict = cfg.get("money_regions", {})
    has_pot = "pot" in money_regions
    has_bet = "bet" in money_regions
    if has_pot: print("💰 Банк: OCR")
    if has_bet: print("💰 Колл: OCR")
    if not has_pot and not has_bet:
        print("💰 Деньги не откалиброваны — запусти calibrate.py (Фаза 2)")

    hole_regs  = regions[:2]
    board_regs = regions[2:]
    interval   = 1.0 / SCAN_FPS
    card_h_pct = cfg.get("card_height_pct", 9)

    # Прогрев OCR в фоне:
    # — если шаблонов не хватает (нужен для карт)
    # — если настроены денежные регионы (нужен для банка/ставки)
    needs_ocr = n_tmpl < 52 or has_pot or has_bet
    if needs_ocr:
        threading.Thread(target=get_ocr, daemon=True).start()

    print(f"\nСканирование запущено ({SCAN_FPS} FPS). Ctrl+C для остановки.\n")

    stat_tick = 0
    while True:
        t0 = time.perf_counter()

        frame = capture_screen()
        if frame is None:
            time.sleep(interval)
            continue

        fh, fw = frame.shape[:2]
        ch = max(10, int(fh * card_h_pct / 100))
        cw = max(8,  int(ch * 0.72))

        # ── Карты ──────────────────────────────────────────────────────────
        hole: list[str] = []
        for r in hole_regs:
            c = recognize_card(frame, r["cx"], r["cy"], cw, ch)
            if c: hole.append(c)

        if len(hole) < 2:
            time.sleep(max(0, interval - (time.perf_counter() - t0)))
            continue

        board: list[str] = []
        for r in board_regs:
            crop = extract_card_region(frame, r["cx"], r["cy"], cw, ch)
            if looks_empty(crop): continue
            c = recognize_card(frame, r["cx"], r["cy"], cw, ch)
            if c: board.append(c)

        if has_duplicates(hole + board):
            time.sleep(max(0, interval - (time.perf_counter() - t0)))
            continue

        # ── Деньги ─────────────────────────────────────────────────────────
        pot: Optional[float] = ocr_number(frame, money_regions["pot"]) if has_pot else None
        bet: Optional[float] = ocr_number(frame, money_regions["bet"]) if has_bet else None

        send_scan(cfg, hole, board, pot, bet)

        # ── Статистика раз в 60 тиков (~12 сек) ────────────────────────────
        stat_tick += 1
        if stat_tick % 60 == 0 and (_tmpl_hits + _ocr_hits + _misses) > 0:
            total = _tmpl_hits + _ocr_hits + _misses
            print(f"  [stat] tmpl={_tmpl_hits} ocr={_ocr_hits} miss={_misses}"
                  f"  tmpl-rate={_tmpl_hits/total*100:.0f}%")

        time.sleep(max(0, interval - (time.perf_counter() - t0)))

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nОстановлено.")
