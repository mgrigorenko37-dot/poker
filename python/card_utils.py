"""
card_utils.py — общие утилиты распознавания карт.
Импортируется из poker_scanner.py и collect_templates.py.

Двухфазное определение масти:
  Фаза 1: насыщенные пиксели → цветные масти (синий/зелёный/красный) + красные на белом фоне
  Фаза 2: тёмные пиксели в центре → чёрные масти на БЕЛОМ фоне (Ton Poker, PokerStars, GGPoker и др.)

Различение ♣ vs ♠:
  ♠ (пика): острый верх — горизонтальный span верхней четверти < 35% ширины карты
  ♣ (трефа): две круглые доли вверху — span > 40%

Конфигурация масти:
  По умолчанию — стандартная 2-color колода (♥♦ красные, ♣♠ чёрные).
  Для 4-color колод (или нестандартных румов) вызови configure_suits(cfg)
  с секцией "suit_hue_ranges" из config.json.

  Структура "suit_hue_ranges" в config.json:
  {
    "h": [0, 15, 160, 180],   // hue-диапазоны для ♥  (список пар [lo,hi])
    "d": [[0, 50]],            // для ♦
    "c": [[50, 140]],          // для ♣
    "s": [[140, 180]]          // для ♠
  }
  Если секция отсутствует — используются встроенные значения.
"""

from typing import Optional
import cv2
import numpy as np


# ── Конфигурация оттенков масти ───────────────────────────────────────────────
# Каждая масть задаётся как список пар [lo, hi] в OpenCV HSV (H: 0–180).
# Значение считается принадлежащей масти если медиана H попадает хоть в один диапазон.
#
# Стандарт по умолчанию (2-color + жёлтые бубны некоторых румов):
#   h: красный   (H < 15 или H > 160)
#   d: оранжевый (H 15–50)
#   c: зелёный   (H 50–140)
#   s: синий     (H 140–160)
_DEFAULT_HUE_RANGES: dict[str, list[tuple[int, int]]] = {
    "h": [(0, 15), (160, 180)],
    "d": [(15, 50)],
    "c": [(50, 140)],
    "s": [(140, 160)],
}

# Активная конфигурация — изменяется через configure_suits()
_suit_hue_ranges: dict[str, list[tuple[int, int]]] = {k: list(v) for k, v in _DEFAULT_HUE_RANGES.items()}


def configure_suits(cfg: dict) -> None:
    """
    Загружает секцию "suit_hue_ranges" из конфига в активную конфигурацию.

    Ожидаемый формат в config.json:
      "suit_hue_ranges": {
        "h": [[0, 15], [160, 180]],
        "d": [[15, 50]],
        "c": [[50, 140]],
        "s": [[140, 160]]
      }

    Если секции нет — оставляет встроенные значения без изменений.
    Пример для 4-color колоды (PokerStars 4-color):
      "h": [[0, 15], [160, 180]],   ♥ красный
      "d": [[100, 130]],             ♦ синий
      "c": [[55, 95]],               ♣ зелёный
      "s": []                        ♠ чёрный — фаза 2 (shape-based)
    """
    global _suit_hue_ranges
    ranges = cfg.get("suit_hue_ranges")
    if not isinstance(ranges, dict):
        return   # секция отсутствует — оставляем значения по умолчанию

    new: dict[str, list[tuple[int, int]]] = {}
    for suit in ("h", "d", "c", "s"):
        raw = ranges.get(suit, [])
        new[suit] = [(int(lo), int(hi)) for lo, hi in raw]

    _suit_hue_ranges = new
    suits_desc = {s: _suit_hue_ranges[s] for s in "hdcs"}
    print(f"🎨 Настройка мастей загружена из конфига: {suits_desc}")


def _hue_matches(med: float, ranges: list[tuple[int, int]]) -> bool:
    """True если медиана оттенка попадает хоть в один диапазон."""
    return any(lo <= med <= hi for lo, hi in ranges)


def detect_suit(crop: np.ndarray) -> Optional[str]:
    """
    Возвращает 'h', 'd', 'c', 's' или None (пустой слот / не удалось).

    Работает для:
      • Цветных румов — фаза 1 (используются _suit_hue_ranges из конфига)
      • Белый фон + красные масти (♥♦) — фаза 1
      • Белый фон + чёрные масти (♣♠, Ton Poker) — фаза 2 (shape-based)
    """
    if crop.size == 0:
        return None

    fh, fw = crop.shape[:2]
    hsv = cv2.cvtColor(crop, cv2.COLOR_RGB2HSV)
    h_c = hsv[:, :, 0].astype(float)
    s_c = hsv[:, :, 1].astype(float)
    v_c = hsv[:, :, 2].astype(float)

    # ── Фаза 1: насыщенные пиксели ─────────────────────────────────────────────
    mask = (s_c > 40) & (v_c > 50) & (v_c < 240)
    sat  = h_c[mask]
    if len(sat) >= 5:
        med = float(np.median(sat))
        # Перебираем масти в порядке h→d→c→s; первое совпадение выигрывает.
        # Порядок важен: ♥ первой чтобы широкий красный диапазон не съел ♦.
        for suit in ("h", "d", "c", "s"):
            ranges = _suit_hue_ranges.get(suit, [])
            if ranges and _hue_matches(med, ranges):
                return suit
        # Ни один диапазон не совпал — падаем в фазу 2 (чёрные масти)

    # ── Фаза 2: белый фон + чёрная масть (Ton Poker, PokerStars classic и др.) ─
    # Берём центральную зону карты — исключаем ранг в верхнем-левом углу
    cy0 = int(fh * 0.30); cy1 = int(fh * 0.90)
    cx0 = int(fw * 0.10); cx1 = int(fw * 0.90)
    center_v = v_c[cy0:cy1, cx0:cx1]
    if center_v.size == 0:
        return None

    dark_ratio = float(np.mean(center_v < 80))
    if dark_ratio < 0.03:
        return None   # почти нет тёмных пикселей → пустой слот

    # Тёмные пиксели есть → чёрная масть, различаем ♣ vs ♠
    dark_mask = (center_v < 80).astype(np.uint8)
    h_dm      = dark_mask.shape[0]
    w_dm      = dark_mask.shape[1]

    # Горизонтальный span в верхней четверти знака
    top_q = dark_mask[: h_dm // 4, :]
    if top_q.size > 0 and np.sum(top_q) > 0:
        cols = np.where(top_q.any(axis=0))[0]
        if len(cols) >= 2:
            span_ratio = (cols[-1] - cols[0]) / max(1, w_dm)
            # ♠ острый верх → span < 0.35
            # ♣ два круглых лепестка вверху → span > 0.40
            if span_ratio < 0.35:
                return "s"

    return "c"   # по умолчанию трефа (♣) — встречается чаще


def refine_red_suit(crop: np.ndarray) -> str:
    """Различает ♥ и ♦ внутри 'красных' мастей по оттенку."""
    hsv  = cv2.cvtColor(crop, cv2.COLOR_RGB2HSV)
    reds = hsv[:, :, 0].astype(float)[hsv[:, :, 1].astype(float) > 40]
    if len(reds) == 0:
        return "h"
    med = float(np.median(reds))
    # Используем диапазон ♦ из конфига если он задан, иначе встроенный порог
    d_ranges = _suit_hue_ranges.get("d", [(15, 50)])
    return "d" if any(lo <= med <= hi for lo, hi in d_ranges) else "h"


def extract_card_region(frame: np.ndarray, cx: float, cy: float,
                        cw: int, ch: int) -> np.ndarray:
    """Вырезает прямоугольник карты по центру (cx, cy) — координаты 0..1."""
    fh, fw = frame.shape[:2]
    x = int(cx * fw - cw / 2)
    y = int(cy * fh - ch / 2)
    return frame[max(0, y):min(fh, y + ch), max(0, x):min(fw, x + cw)]


def looks_empty(crop: np.ndarray) -> bool:
    """True если регион слишком тёмный или однородный → борд-слот пустой."""
    if crop.size == 0:
        return True
    gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY).astype(float)
    return float(np.mean(gray)) < 30 or float(np.std(gray)) < 8
