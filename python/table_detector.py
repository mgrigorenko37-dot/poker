"""
table_detector.py — автоматический поиск стола Ton Poker на экране.

Принцип:
  1. HSV-маска выделяет характерный серо-зелёный цвет стола.
  2. findContours → наибольший контур = овал стола → bounding box.
  3. EMA (alpha=0.7) сглаживает bbox — убирает джиттер на 1-2 пикселя.
  4. Все координаты карт/денег вычисляются как фиксированные пропорции
     от размера и центра bbox → работает при любом разрешении.
  5. Ленивое обновление: пересчёт только когда стол не найден на месте.

Экспортируемые функции:
  find_table(frame)                 → (x, y, w, h) | None
  compute_regions(bbox, frame)      → dict с cx/cy и money_regions
  get_table_state(frame)            → (regions | None, debug_info)
"""

from __future__ import annotations

import cv2
import numpy as np
from typing import Optional

# ── HSV-диапазон серо-зелёного стола Ton Poker ────────────────────────────────
# Цвет стола: приглушённый sage/olive-green (~#8FAF8A).
# В OpenCV HSV: H 0-180, S 0-255, V 0-255.
# Нижняя граница чуть шире чтобы поймать тени от анимации.
_HSV_LO = np.array([ 55,  20,  75], dtype=np.uint8)
_HSV_HI = np.array([ 95, 110, 175], dtype=np.uint8)

# Минимальная площадь контура чтобы не принять мелкий мусор за стол.
# 5% площади экрана — стол всегда больше.
_MIN_TABLE_AREA_FRAC = 0.05

# ── EMA (Exponential Moving Average) ─────────────────────────────────────────
# alpha=0.7: новое значение весит 30%, старое — 70%.
# При сдвиге окна сходится за ~5 тиков (1 сек при 5 FPS).
_EMA_ALPHA = 0.7
_ema_bbox: Optional[np.ndarray] = None   # [x, y, w, h] float


def _update_ema(new_bbox: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    global _ema_bbox
    nb = np.array(new_bbox, dtype=float)
    if _ema_bbox is None:
        _ema_bbox = nb
    else:
        _ema_bbox = _EMA_ALPHA * _ema_bbox + (1 - _EMA_ALPHA) * nb
    return tuple(int(v) for v in _ema_bbox)


# ── Ленивый кэш ───────────────────────────────────────────────────────────────
# Пересчитываем только когда стол не найден на ожидаемом месте.
_cached_bbox: Optional[tuple[int, int, int, int]] = None
_miss_streak = 0          # сколько подряд тиков стол не найден
_MISS_RESET = 8           # после скольки промахов сбрасываем кэш


def find_table(frame: np.ndarray) -> Optional[tuple[int, int, int, int]]:
    """
    Ищет зелёный стол на фрейме.

    Возвращает (x, y, w, h) bounding box с EMA-сглаживанием,
    или None если стол не найден (окно свёрнуто / перекрыто).
    """
    global _cached_bbox, _miss_streak, _ema_bbox  # _ema_bbox нужен для сброса

    hsv  = cv2.cvtColor(frame, cv2.COLOR_RGB2HSV)
    mask = cv2.inRange(hsv, _HSV_LO, _HSV_HI)

    # Морфология: убираем однопиксельный шум
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask   = cv2.morphologyEx(mask, cv2.MORPH_OPEN,  kernel)
    mask   = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    # ── Защита от пустого экрана ─────────────────────────────────────────────
    if not contours:
        _miss_streak += 1
        if _miss_streak >= _MISS_RESET:
            _cached_bbox = None
            _ema_bbox    = None  # теперь реально сбрасывает модульную переменную
        return None

    # Отсекаем контуры меньше порога площади
    frame_area = frame.shape[0] * frame.shape[1]
    big = [c for c in contours
           if cv2.contourArea(c) >= _MIN_TABLE_AREA_FRAC * frame_area]
    if not big:
        _miss_streak += 1
        if _miss_streak >= _MISS_RESET:
            _cached_bbox = None
            _ema_bbox    = None  # сброс EMA и здесь — стол не виден достаточно долго
        return None

    _miss_streak = 0
    best = max(big, key=cv2.contourArea)
    raw  = cv2.boundingRect(best)

    _cached_bbox = _update_ema(raw)
    return _cached_bbox


# ── Пропорции карт относительно стола ────────────────────────────────────────
# Замерены из обоих пресетов (mobile 468×847, desktop 1040×585).
# dx — доля ШИРИНЫ стола от его центра.
# dy — доля ВЫСОТЫ стола от его центра (отрицательное = выше центра).

# Борд одинаковый в обоих форматах:
_BOARD_DX = [-0.310, -0.155,  0.003, +0.155, +0.310]
_BOARD_DY  = -0.036

_LAYOUT = {
    # Портрет (мобильный): ширина < высоты
    "portrait": {
        "hole_dx":    0.114,    # ±dx от центра стола
        "hole_dy":    0.457,
        "pot_dx":     0.020,
        "pot_dy":    -0.152,
        "pot_hw":     0.163,    # half-width зоны банка
        "pot_hh":     0.043,    # half-height зоны банка
        # Зоны карт рубашкой оппонентов (для count_active_players).
        # [dx, dy] от центра стола, приблизительно — уточнить при тестировании.
        "seat_dxy": [
            (-0.38, -0.35),   # верхний левый
            ( 0.00, -0.48),   # верхний центр
            ( 0.38, -0.35),   # верхний правый
            (-0.47,  0.00),   # левый
            ( 0.47,  0.00),   # правый
        ],
    },
    # Ландшафт (десктоп): ширина > высоты
    "landscape": {
        "hole_dx":    0.081,
        "hole_dy":    0.469,
        "pot_dx":     0.023,
        "pot_dy":    -0.114,
        "pot_hw":     0.114,
        "pot_hh":     0.030,
        "seat_dxy": [
            ( 0.00, -0.48),   # верхний центр
            (-0.48,  0.00),   # левый
            ( 0.48,  0.00),   # правый
            (-0.30, -0.38),   # верхний левый
            ( 0.30, -0.38),   # верхний правый
        ],
    },
}


def _layout_key(w: int, h: int) -> str:
    return "landscape" if w >= h else "portrait"


def compute_regions(bbox: tuple[int, int, int, int],
                    frame: np.ndarray) -> dict:
    """
    Вычисляет все регионы карт и денег из bounding box стола.

    Возвращает dict совместимый с форматом config.json:
      {
        "regions": [{"label":…, "cx":…, "cy":…}, …],   # 7 штук (hole×2 + board×5)
        "money_regions": {"pot": {"x1":…,"y1":…,"x2":…,"y2":…}},
        "seat_regions":  [{"cx":…,"cy":…}, …],
        "layout": "portrait"|"landscape",
      }
    """
    bx, by, bw, bh = bbox
    fh, fw = frame.shape[:2]

    # Центр стола в пикселях
    cx_px = bx + bw / 2
    cy_px = by + bh / 2

    layout = _layout_key(bw, bh)
    p      = _LAYOUT[layout]

    def to_screen(dx_tw: float, dy_th: float):
        """Перевод пропорций стола → нормированные координаты экрана (0..1)."""
        return (
            (cx_px + dx_tw * bw) / fw,
            (cy_px + dy_th * bh) / fh,
        )

    # ── Регионы карт ─────────────────────────────────────────────────────────
    regions = []

    # Hole cards
    for label, sign in [("Hole1", -1), ("Hole2", +1)]:
        cx_s, cy_s = to_screen(sign * p["hole_dx"], p["hole_dy"])
        regions.append({"label": label, "cx": round(cx_s, 4), "cy": round(cy_s, 4)})

    # Board cards
    for i, dx in enumerate(_BOARD_DX, 1):
        cx_s, cy_s = to_screen(dx, _BOARD_DY)
        regions.append({"label": f"Board{i}", "cx": round(cx_s, 4), "cy": round(cy_s, 4)})

    # ── Деньги ───────────────────────────────────────────────────────────────
    pot_cx, pot_cy = to_screen(p["pot_dx"], p["pot_dy"])
    pot_hw = p["pot_hw"] * bw / fw
    pot_hh = p["pot_hh"] * bh / fh

    money_regions = {
        "pot": {
            "x1": round(pot_cx - pot_hw, 4),
            "y1": round(pot_cy - pot_hh, 4),
            "x2": round(pot_cx + pot_hw, 4),
            "y2": round(pot_cy + pot_hh, 4),
        }
    }

    # ── Места оппонентов ─────────────────────────────────────────────────────
    seat_regions = []
    for dx, dy in p["seat_dxy"]:
        cx_s, cy_s = to_screen(dx, dy)
        seat_regions.append({"cx": round(cx_s, 4), "cy": round(cy_s, 4)})

    return {
        "regions":       regions,
        "money_regions": money_regions,
        "seat_regions":  seat_regions,
        "layout":        layout,
    }


# ── Главная точка входа для сканера ──────────────────────────────────────────

def get_table_state(frame: np.ndarray) -> tuple[Optional[dict], dict]:
    """
    Объединяет find_table + compute_regions.
    Возвращает (regions_dict | None, debug).

    regions_dict == None → стол не обнаружен, пропустить тик.
    debug — словарь для диагностики (bbox, layout, miss_streak).
    """
    bbox = find_table(frame)
    if bbox is None:
        return None, {"bbox": None, "miss_streak": _miss_streak}

    regions_dict = compute_regions(bbox, frame)
    debug = {
        "bbox":   bbox,
        "layout": regions_dict["layout"],
        "miss_streak": _miss_streak,
    }
    return regions_dict, debug
