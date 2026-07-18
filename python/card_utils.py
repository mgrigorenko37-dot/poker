"""
card_utils.py — общие утилиты распознавания карт.
Импортируется из poker_scanner.py и collect_templates.py.

Двухфазное определение масти:
  Фаза 1: насыщенные пиксели → цветные масти (синий/зелёный/красный) + красные на белом фоне
  Фаза 2: тёмные пиксели в центре → чёрные масти на БЕЛОМ фоне (Ton Poker, PokerStars, GGPoker и др.)

Различение ♣ vs ♠:
  ♠ (пика): острый верх — горизонтальный span верхней четверти < 35% ширины карты
  ♣ (трефа): две круглые доли вверху — span > 40%
"""

from typing import Optional
import cv2
import numpy as np


def detect_suit(crop: np.ndarray) -> Optional[str]:
    """
    Возвращает 'h', 'd', 'c', 's' или None (пустой слот / не удалось).

    Работает для:
      • Цветных румов (пики синие, трефы зелёные и т.п.) — фаза 1
      • Белый фон + красные масти (♥♦) — фаза 1
      • Белый фон + чёрные масти (♣♠, Ton Poker) — фаза 2
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
        if med < 15 or med > 160:
            return "h"   # красный — уточнится в refine_red_suit()
        if med < 50:
            return "d"   # жёлто-оранжевый → бубны (некоторые румы)
        if med < 140:
            return "c"   # зелёный → трефы
        return "s"        # синий/фиолетовый → пики

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
    # Бубны чуть более оранжевые (hue 5–20), червы ближе к 0/180
    return "d" if 5 < med < 20 else "h"


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
