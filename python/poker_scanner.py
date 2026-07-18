"""
poker_scanner.py — локальный Python-агент для Ton Poker и других браузерных румов.

Что делает:
  1. Захватывает экран через mss (~60 FPS, почти 0% CPU)
  2. Автоматически находит зелёный стол через HSV-детект (table_detector.py).
     Калибровка НЕ нужна — скрипт запускается сразу.
  3. Распознаёт карты через template matching (cv2) если шаблоны собраны,
     иначе падает на EasyOCR (автоматически, без ручного переключения)
  4. Читает банк и ставку/колл через OCR (зоны вычисляются из размера стола)
  5. Шлёт JSON на /api/python/scan → GTO расчёт → Telegram

Запуск (без калибровки):
    python poker_scanner.py

Если авто-детект не работает (нестандартный клиент):
  1. python calibrate.py        ← ручная калибровка как запасной вариант
  2. python collect_templates.py
  3. python poker_scanner.py
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

from card_utils import detect_suit, refine_red_suit, extract_card_region, looks_empty, configure_suits
from table_detector import get_table_state, detect_bet_chips

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
CONFIG_PATH        = os.path.join(os.path.dirname(__file__), "config.json")
TEMPLATES_DIR      = os.path.join(os.path.dirname(__file__), "templates")
DEALER_TMPL_PATH   = os.path.join(TEMPLATES_DIR, "dealer_button.png")

RANK_MAP = {
    "a":"A","k":"K","q":"Q","j":"J","10":"T","t":"T",
    "9":"9","8":"8","7":"7","6":"6","5":"5","4":"4","3":"3","2":"2",
    "i":"J","l":"J","1":"A",
}
VALID_RANKS     = set("A K Q J T 9 8 7 6 5 4 3 2".split())
SCAN_FPS         = 5
MIN_RANK_CONF    = 0.3
MIN_MONEY_CONF   = 0.2
TMPL_THRESHOLD   = 0.82   # минимальный TM_CCOEFF_NORMED для принятия шаблона
DEALER_THRESHOLD = 0.65   # порог для кнопки D (ниже чем карты — она меньше и может быть частично закрыта)

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
        with mss.MSS() as sct:
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

# ── Фильтр стабильности региона (анти-анимация) ───────────────────────────────
# Хранит grayscale-снимок каждого денежного региона с прошлого тика.
# Если MAD (mean absolute difference) > порога — регион ещё анимируется,
# OCR запускать бессмысленно: вернём последнее известное значение.
_region_prev: dict[str, Optional[np.ndarray]] = {}
_STABLE_MAD_THRESHOLD = 12.0   # пиксельных единиц яркости; 12 ≈ заметное движение

def is_region_stable(key: str, crop: np.ndarray) -> bool:
    """
    True если регион стабилен между текущим и прошлым кадром.
    key — уникальный идентификатор региона ('pot' / 'bet').
    Всегда обновляет кэш независимо от результата.
    """
    gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY).astype(np.float32)
    prev = _region_prev.get(key)
    _region_prev[key] = gray

    if prev is None or prev.shape != gray.shape:
        return True   # первый кадр — считаем стабильным

    mad = float(np.mean(np.abs(gray - prev)))
    return mad <= _STABLE_MAD_THRESHOLD

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

# ── Кнопка дилера — шаблон и поиск ──────────────────────────────────────────
def load_dealer_template() -> Optional[np.ndarray]:
    """Загружает шаблон кнопки D из templates/dealer_button.png (grayscale)."""
    if not os.path.exists(DEALER_TMPL_PATH):
        return None
    tmpl = cv2.imread(DEALER_TMPL_PATH, cv2.IMREAD_GRAYSCALE)
    return tmpl if tmpl is not None and tmpl.size > 0 else None

def find_dealer_button(frame: np.ndarray,
                       dealer_tmpl: np.ndarray) -> Optional[tuple[float, float]]:
    """
    Ищет кнопку D на фрейме через TM_CCOEFF_NORMED.
    Возвращает (cx, cy) нормализованные 0..1 или None если не найдена.
    """
    gray   = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
    result = cv2.matchTemplate(gray, dealer_tmpl, cv2.TM_CCOEFF_NORMED)
    _, max_val, _, max_loc = cv2.minMaxLoc(result)
    if max_val < DEALER_THRESHOLD:
        return None
    fh, fw    = frame.shape[:2]
    th, tw    = dealer_tmpl.shape[:2]
    cx = (max_loc[0] + tw / 2) / fw
    cy = (max_loc[1] + th / 2) / fh
    return cx, cy

# ── Вычисление позиции ────────────────────────────────────────────────────────
# Позиции в порядке: 0 = BTN (дилер), 1 = SB, 2 = BB, 3 = UTG …
_POSITIONS_6 = ["BTN", "SB", "BB", "UTG", "HJ",  "CO"]
_POSITIONS_9 = ["BTN", "SB", "BB", "UTG", "UTG+1", "UTG+2", "MP", "HJ", "CO"]

def compute_position(hero_seat: int, dealer_seat: int, total_seats: int) -> str:
    """
    hero_seat  — индекс места героя (0..total_seats-1)
    dealer_seat — индекс места дилера
    total_seats — число мест за столом
    Возвращает строку позиции: 'BTN', 'SB', 'BB', 'UTG' …
    """
    table  = _POSITIONS_6 if total_seats <= 6 else _POSITIONS_9
    offset = (hero_seat - dealer_seat) % total_seats
    return table[offset] if offset < len(table) else "MP"

def nearest_seat(dealer_cx: float, dealer_cy: float,
                 hero_cx: float,   hero_cy: float,
                 seat_regions: list) -> int:
    """
    Возвращает индекс ближайшего к кнопке D места.
    Индекс 0 = герой, 1..N = оппоненты из seat_regions.
    """
    all_seats = [{"cx": hero_cx, "cy": hero_cy}] + list(seat_regions)
    best_idx, best_dist = 0, float("inf")
    for i, s in enumerate(all_seats):
        d = (dealer_cx - s["cx"]) ** 2 + (dealer_cy - s["cy"]) ** 2
        if d < best_dist:
            best_dist = d
            best_idx  = i
    return best_idx

# ── Активные игроки ───────────────────────────────────────────────────────────
def count_active_players(frame: np.ndarray, seat_regions: list,
                         cw: int, ch: int) -> int:
    """
    Считает число активных игроков в текущей раздаче.
    Проверяет каждую seat_region через looks_empty():
      — если зона НЕ пустая → у игрока есть карты рубашкой → он активен.
    Возвращает число активных оппонентов + 1 (герой всегда активен).
    Если seat_regions не настроены — возвращает None (нет данных).
    """
    if not seat_regions:
        return None
    active = 0
    for r in seat_regions:
        crop = extract_card_region(frame, r["cx"], r["cy"], cw, ch)
        if not looks_empty(crop):
            active += 1
    return active + 1   # +1 за героя


# ── Дубли ────────────────────────────────────────────────────────────────────
def has_duplicates(cards: list) -> bool:
    return len(cards) != len(set(cards))

# ── Кросс-кадровый фильтр денег ───────────────────────────────────────────────
class MoneyFilter:
    """
    Отсекает OCR-галлюцинации при чтении банка / ставки.

    Правила:
    - None → держать последнее известное значение.
    - Подозрительное падение (< 50% от прошлого) или спайк (> 10×) →
      ждём подтверждения в следующем кадре (два кадра подряд должны совпасть
      в пределах ±15%). Пока подтверждения нет — возвращаем старое значение.
    - Разумное изменение → принимаем сразу.

    reset() вызывается при смене hole-карт (новая раздача) чтобы не блокировать
    легитимный сброс банка до нуля между раздачами.
    """
    def __init__(self,
                 max_drop_ratio: float = 0.50,
                 max_spike_ratio: float = 10.0,
                 confirm_tol: float = 0.15):
        self.last: Optional[float] = None
        self._candidate: Optional[float] = None
        self._max_drop  = max_drop_ratio
        self._max_spike = max_spike_ratio
        self._confirm   = confirm_tol

    def reset(self) -> None:
        self.last       = None
        self._candidate = None

    def update(self, new_val: Optional[float]) -> Optional[float]:
        if new_val is None:
            self._candidate = None
            return self.last            # держим последнее хорошее

        if self.last is None:           # первое чтение — принимаем сразу
            self.last = new_val
            self._candidate = None
            return new_val

        is_suspicious = (
            new_val < self.last * self._max_drop or
            new_val > self.last * self._max_spike
        )

        if is_suspicious:
            if (self._candidate is not None and
                    abs(new_val - self._candidate) / max(1.0, self._candidate) < self._confirm):
                # Два кадра подряд согласны — принимаем
                self.last = new_val
                self._candidate = None
                return new_val
            else:
                self._candidate = new_val   # ждём следующего кадра
                return self.last            # пока возвращаем старое
        
        self.last = new_val
        self._candidate = None
        return new_val

# ── Отправка ─────────────────────────────────────────────────────────────────
_last_key = ""

def send_scan(cfg, hole, board, pot, bet, players: int, position: str,
              aggressor_pos: Optional[str]) -> None:
    global _last_key
    payload = {
        "holeCards":        hole,
        "boardCards":       board,
        "potSize":          round(pot, 2) if pot is not None else 0,
        "betToCall":        round(bet, 2) if bet is not None else 0,
        "players":          players,
        "position":         position,
        # Множитель агрессии виллана: 0.5 = пассивный, 1.0 = базовый, 2.0 = гиперагрессивный.
        # Настраивается в config.json → "villain_aggression".
        "villainAggression":  cfg.get("villain_aggression", 1.0),
        # Позиция агрессора (кто поставил/рейзнул) — авто-детект по жёлтому чипу.
        # Пустая строка = неизвестно (советник использует только позицию героя).
        "aggressorPosition":  aggressor_pos or "",
    }
    key = hashlib.md5(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    if key == _last_key: return
    _last_key = key
    url = cfg["server_url"]
    try:
        r    = requests.post(url, json=payload, timeout=4)
        if not r.text.strip():
            print(f"  ⚠️  Сервер вернул пустой ответ (HTTP {r.status_code})")
            print(f"       URL: {url[:80]}")
            print(f"       Проверь server_url в config.json — возможно старый адрес")
            return
        data = r.json()
        if "error" in data and "action" not in data:
            print(f"  ⚠️  Сервер: {data['error']}")
            return
        action = data.get("action", "?")
        equity = round((data.get("equity") or 0) * 100)
        pot_s  = f"  банк={pot:.0f}" if pot else ""
        bet_s  = f"  колл={bet:.0f}" if bet else ""
        agg_s  = f"  agg={aggressor_pos}" if aggressor_pos else ""
        print(f"  → {action}  Win {equity}%  [{position} / {players}p]{agg_s}  |  {' '.join(hole)} | {' '.join(board)}{pot_s}{bet_s}")
    except requests.exceptions.ConnectionError:
        print(f"  ⚠️  Сервер недоступен ({url[:60]}…)")
    except Exception as e:
        print(f"  ⚠️  Ошибка: {e}")
        if 'r' in dir() and hasattr(r, 'text'):
            print(f"       HTTP {r.status_code}: {r.text[:150]}")

# ── Автоподключение Telegram ──────────────────────────────────────────────────

def setup_telegram(cfg: dict) -> None:
    """
    Вызывается один раз при старте poker_scanner.py.

    Логика:
      • Если Telegram уже привязан → сообщаем и идём дальше.
      • Если нет → просим написать боту /start и привязываем автоматически.
      • Привязка сохраняется на сервере — следующий запуск пройдёт без вопросов.
    """
    server_url = cfg.get("server_url", "")
    base = server_url.split("/api/")[0] if "/api/" in server_url else server_url.rstrip("/")
    if not base:
        return

    # 1. Проверяем статус
    try:
        r = requests.get(f"{base}/api/telegram/status", timeout=5)
        status = r.json()
    except Exception:
        print("⚠️  Telegram: сервер недоступен, пропускаю проверку")
        return

    already = status.get("ready") or status.get("configured") or status.get("hasChatId")
    if already:
        print("📱 Telegram: подключён — советы будут приходить в бот")
        return

    if not status.get("hasToken"):
        print("⚠️  Telegram: токен бота не задан на сервере (добавь TELEGRAM_BOT_TOKEN в Replit Secrets)")
        return

    # 2. Привязываем
    print()
    print("=" * 52)
    print("  Подключение Telegram (один раз)")
    print("=" * 52)
    print()
    print("  1. Открой Telegram")
    print("  2. Найди своего бота")
    print('  3. Напиши ему: /start')
    print()
    try:
        input("  ✅ Написал /start? Нажми Enter → ")
    except EOFError:
        pass  # неинтерактивный режим

    print()
    linked = False
    for attempt in range(3):
        try:
            r = requests.post(f"{base}/api/telegram/link", timeout=15)
            data = r.json()
            if r.status_code == 200 and data.get("ok"):
                name = data.get("username", "")
                print(f"  ✅ Telegram подключён!{(' (@' + name + ')') if name else ''}")
                linked = True
                break
            else:
                err = data.get("error", r.text[:80])
                print(f"  Попытка {attempt + 1}/3: {err}")
        except Exception as e:
            print(f"  Попытка {attempt + 1}/3 ошибка: {e}")
        if attempt < 2:
            time.sleep(3)

    if linked:
        # Тестовое сообщение — убеждаемся что всё дошло
        try:
            requests.post(f"{base}/api/telegram/test", timeout=10)
            print("  📨 Тестовое сообщение отправлено — проверь бот!")
        except Exception:
            pass
    else:
        print("  ⚠️  Не удалось подключить Telegram. Сканер запустится без него.")

    print()


# ── Основной цикл ─────────────────────────────────────────────────────────────
def main():
    global _tmpl_hits, _ocr_hits, _misses

    cfg = load_config()
    url = cfg.get("server_url", "")
    if "ТВОЙ_ДОМЕН" in url or not url:
        print("❌ Укажи server_url в config.json")
        sys.exit(1)

    # ── Telegram — автоподключение при старте ─────────────────────────────────
    setup_telegram(cfg)

    # Загружаем конфиг мастей (если задан suit_hue_ranges для нестандартного рума)
    configure_suits(cfg)

    # ── Режим регионов ────────────────────────────────────────────────────────
    # Приоритет:
    #   1. Авто-детект стола (table_detector) — работает без calibrate.py
    #   2. Ручные регионы из config.json       — запасной вариант
    manual_regions  = cfg.get("regions", [])
    use_auto_detect = True   # всегда пробуем авто; фолбек если стол не найден

    if len(manual_regions) >= 5:
        print("📋 Регионы: config.json загружен (запасной вариант если авто не сработает)")
    else:
        print("📋 Регионы: только авто-детект (config.json не откалиброван)")

    print("🔍 Авто-детект стола: включён (table_detector)")

    # ── Шаблоны ──────────────────────────────────────────────────────────────
    _templates.update(load_templates())
    n_tmpl = len(_templates)
    if n_tmpl > 0:
        print(f"🃏 Template matching: загружено {n_tmpl}/52 шаблонов")
        if n_tmpl < 52:
            print(f"   (не хватает {52 - n_tmpl} карт — fallback на EasyOCR для них)")
    else:
        print("🃏 Шаблоны не найдены → только EasyOCR")
        print("   Для точности 99.9% запусти: python collect_templates.py")

    # ── Ручные деньги / места (из config.json если есть) ─────────────────────
    manual_money:  dict = cfg.get("money_regions", {})
    manual_seats:  list = cfg.get("seat_regions", [])
    players_fallback: int = cfg.get("players", 6)

    # ── Кнопка дилера ────────────────────────────────────────────────────────
    dealer_tmpl       = load_dealer_template()
    position_fallback = cfg.get("position", "BTN")
    _last_position    = position_fallback
    _last_d_seat: int = 0       # последний известный индекс места дилера

    # ── Агрессор (авто-детект по жёлтому чипу) ───────────────────────────────
    _last_aggressor: Optional[str] = None  # позиция оппонента который поставил

    if dealer_tmpl is not None:
        print("🎯 Позиция: авто-детект по кнопке D")
    else:
        print(f"🎯 Позиция: фиксировано {position_fallback} (запусти calibrate.py Фазу 4)")

    # ── OCR прогрев ───────────────────────────────────────────────────────────
    # Всегда прогреваем: банк читаем через OCR (из авто-зон стола)
    threading.Thread(target=get_ocr, daemon=True).start()

    interval   = 1.0 / SCAN_FPS
    card_h_pct = cfg.get("card_height_pct", 9)

    # ── Фильтры денег (кросс-кадровая валидация OCR) ─────────────────────────
    pot_filter = MoneyFilter(max_drop_ratio=0.50, max_spike_ratio=10.0)
    bet_filter = MoneyFilter(max_drop_ratio=0.10, max_spike_ratio=20.0)
    _last_hole_key: str = ""   # для детекта смены раздачи

    print(f"\nСканирование запущено ({SCAN_FPS} FPS). Ctrl+C для остановки.\n")
    print("⏳ Открой покер-рум — скрипт найдёт стол автоматически.\n")

    stat_tick  = 0
    table_miss = 0          # счётчик тиков без стола для вывода статуса
    while True:
        t0 = time.perf_counter()

        frame = capture_screen()
        if frame is None:
            time.sleep(interval)
            continue

        fh, fw = frame.shape[:2]

        # ── Авто-детект стола ─────────────────────────────────────────────────
        regions_dict, dbg = get_table_state(frame)

        if regions_dict is not None:
            # Стол найден — используем динамические регионы
            regions      = regions_dict["regions"]
            money_regions = regions_dict["money_regions"]
            seat_regions  = regions_dict["seat_regions"]
            if table_miss > 0:
                print(f"✅ Стол найден ({dbg['layout']})")
                table_miss = 0
        elif len(manual_regions) >= 5:
            # Стол не виден, но есть ручные регионы — фолбек
            regions       = manual_regions
            money_regions = manual_money
            seat_regions  = manual_seats
            table_miss   += 1
            if table_miss == 1:
                print("⚠️  Стол не обнаружен — использую ручные регионы из config.json")
        else:
            # Ни стол не найден, ни ручных регионов нет — ждём
            table_miss += 1
            if table_miss % 25 == 1:   # раз в ~5 сек
                print("⏳ Жду стол... (открой игру на экране)")
            time.sleep(interval)
            continue

        # ── Размер карты (из высоты стола если авто, иначе из конфига) ───────
        if regions_dict is not None and dbg.get("bbox"):
            _, _, _, bh = dbg["bbox"]
            ch = max(10, int(bh * 0.095))   # ~9.5% высоты стола
        else:
            ch = max(10, int(fh * card_h_pct / 100))
        cw = max(8, int(ch * 0.72))

        hole_regs  = regions[:2]
        board_regs = regions[2:]

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

        # ── Сброс фильтров при смене раздачи ──────────────────────────────
        # Hole-карты сменились → новая раздача → банк может легально упасть до 0.
        hole_key = "".join(sorted(hole))
        is_new_hand = (hole_key != _last_hole_key)
        if is_new_hand:
            pot_filter.reset()
            bet_filter.reset()
            _last_hole_key = hole_key
            _last_aggressor = None   # новая раздача — сбрасываем агрессора

        # ── Активные игроки ────────────────────────────────────────────────
        detected = count_active_players(frame, seat_regions, cw, ch)
        players  = detected if detected is not None else players_fallback

        # ── Позиция дилера ─────────────────────────────────────────────────
        hero_cx = (regions[0]["cx"] + regions[1]["cx"]) / 2
        hero_cy = (regions[0]["cy"] + regions[1]["cy"]) / 2
        total_seats = len(seat_regions) + 1
        if dealer_tmpl is not None:
            dealer_pos = find_dealer_button(frame, dealer_tmpl)
            if dealer_pos is not None:
                d_seat = nearest_seat(dealer_pos[0], dealer_pos[1],
                                      hero_cx, hero_cy, seat_regions)
                _last_d_seat  = d_seat
                _last_position = compute_position(0, d_seat, total_seats)
        position = _last_position

        # ── Деньги (фильтр стабильности + кросс-кадровая валидация) ──────────
        # Сначала проверяем что регион не анимируется (MAD < порога).
        # Если анимация идёт — OCR не запускаем, MoneyFilter вернёт последнее
        # хорошее значение. Если регион стабилен — OCR + валидация фильтром.
        if "pot" in money_regions:
            pot_crop = extract_money_region(frame, money_regions["pot"])
            if is_region_stable("pot", pot_crop):
                raw_pot = ocr_number(frame, money_regions["pot"])
            else:
                raw_pot = None   # регион движется, пропускаем OCR
        else:
            raw_pot = None

        bet_region = money_regions.get("bet", {})
        if bet_region:
            bet_crop = extract_money_region(frame, bet_region)
            if is_region_stable("bet", bet_crop):
                raw_bet = ocr_number(frame, bet_region)
            else:
                raw_bet = None
        else:
            raw_bet = None

        pot = pot_filter.update(raw_pot)
        bet = bet_filter.update(raw_bet)

        # ── Агрессор (кто поставил — авто-детект по жёлтому чипу) ────────────
        # Логика:
        #   - нет ставки (bet==0) → сбрасываем (новая улица или начало)
        #   - есть ставка → ищем жёлтый чип у мест оппонентов
        #   - нашли → запоминаем позицию агрессора до конца ставки
        #   - не нашли (чип ещё анимируется) → держим последнее значение
        if not bet:
            _last_aggressor = None
        elif regions_dict is not None and dbg.get("bbox") and seat_regions:
            chips = detect_bet_chips(frame, dbg["bbox"], seat_regions)
            for i, has_chip in enumerate(chips):
                if has_chip:
                    # seat_regions содержит только оппонентов; в all_seats индекс i+1
                    opp_in_all = i + 1
                    table = _POSITIONS_6 if total_seats <= 6 else _POSITIONS_9
                    offset = (opp_in_all - _last_d_seat) % total_seats
                    if offset < len(table):
                        _last_aggressor = table[offset]
                    break

        send_scan(cfg, hole, board, pot, bet, players, position, _last_aggressor)

        # ── Статистика раз в 60 тиков (~12 сек) ────────────────────────────
        stat_tick += 1
        if stat_tick % 60 == 0 and (_tmpl_hits + _ocr_hits + _misses) > 0:
            total_r = _tmpl_hits + _ocr_hits + _misses
            print(f"  [stat] tmpl={_tmpl_hits} ocr={_ocr_hits} miss={_misses}"
                  f"  tmpl-rate={_tmpl_hits/total_r*100:.0f}%")

        time.sleep(max(0, interval - (time.perf_counter() - t0)))

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nОстановлено.")
