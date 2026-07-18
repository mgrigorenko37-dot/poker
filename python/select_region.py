"""
select_region.py — ручное выделение области стола на экране.

Запуск:
    python select_region.py

Когда использовать:
    - Авто-детект не находит стол (полный экран, нестандартный рум)
    - После смены разрешения или перемещения окна игры

Что делает:
    Делает скриншот → открывает окно.
    Зажми ЛКМ и обведи покерный стол → нажми S → координаты сохраняются
    в config.json. При следующем запуске авто-режима применятся автоматически.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Optional

import cv2
import numpy as np

try:
    import mss as mss_lib
except ImportError:
    print("Установи зависимости: pip install mss")
    sys.exit(1)

CONFIG_PATH  = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
EXAMPLE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.example.json")
WIN_NAME     = "Выделение стола — ЛКМ: обвести стол,  S: сохранить,  R: сброс,  ESC: отмена"
DIVIDER      = "─" * 52


# ── Конфиг ────────────────────────────────────────────────────────────────────

def _load_config() -> dict:
    for p in (CONFIG_PATH, EXAMPLE_PATH):
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                return json.load(f)
    return {}


def _save_config(cfg: dict) -> None:
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


# ── Захват экрана ──────────────────────────────────────────────────────────────

def capture_screen() -> np.ndarray:
    with mss_lib.mss() as sct:
        mon = sct.monitors[1]
        raw = sct.grab(mon)
        return np.frombuffer(raw.rgb, dtype=np.uint8) \
                   .reshape(raw.height, raw.width, 3).copy()


# ── Интерактивный выбор прямоугольника ────────────────────────────────────────

def select_region(frame: np.ndarray) -> Optional[tuple[int, int, int, int]]:
    """
    Показывает frame в окне OpenCV, пользователь рисует прямоугольник мышью.

    Управление:
      ЛКМ (зажать и провести) — обвести область
      S                        — подтвердить и вернуть
      R                        — сброс, нарисовать заново
      ESC                      — отмена (вернёт None)

    Возвращает (x, y, w, h) в пикселях или None.
    """
    rect_start: list[Optional[tuple[int, int]]] = [None]
    rect_cur:   list[Optional[tuple[int, int]]] = [None]
    confirmed:  list[Optional[tuple[int, int, int, int]]] = [None]

    def _draw() -> None:
        vis = frame.copy()
        cv2.putText(
            vis,
            "Зажми ЛКМ и обведи стол.  S = сохранить   R = сброс   ESC = отмена",
            (16, 36), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 220, 0), 2,
        )
        # Активное рисование
        if rect_start[0] and rect_cur[0]:
            cv2.rectangle(vis, rect_start[0], rect_cur[0], (0, 200, 255), 2)
        # Подтверждённая область
        if confirmed[0]:
            x, y, w, h = confirmed[0]
            cv2.rectangle(vis, (x, y), (x + w, y + h), (0, 255, 80), 2)
            label = f"{w}x{h} px — нажми S чтобы сохранить"
            cv2.putText(vis, label, (16, 68),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 255, 80), 2)
        cv2.imshow(WIN_NAME, vis)

    def _mouse(event: int, x: int, y: int, flags: int, param: object) -> None:
        if event == cv2.EVENT_LBUTTONDOWN:
            rect_start[0] = (x, y)
            rect_cur[0]   = (x, y)
            confirmed[0]  = None

        elif event == cv2.EVENT_MOUSEMOVE and rect_start[0]:
            rect_cur[0] = (x, y)
            _draw()

        elif event == cv2.EVENT_LBUTTONUP and rect_start[0]:
            x1 = min(rect_start[0][0], x)
            y1 = min(rect_start[0][1], y)
            x2 = max(rect_start[0][0], x)
            y2 = max(rect_start[0][1], y)
            w, h = x2 - x1, y2 - y1
            if w < 50 or h < 30:
                print("  ⚠️  Слишком маленькая область, попробуй снова")
            else:
                confirmed[0] = (x1, y1, w, h)
                print(f"  ✓ Выделено: ({x1},{y1}) {w}×{h} px  →  нажми S чтобы сохранить")
            rect_start[0] = None
            rect_cur[0]   = None
            _draw()

    cv2.namedWindow(WIN_NAME, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(WIN_NAME, 1280, 720)
    cv2.setMouseCallback(WIN_NAME, _mouse)
    _draw()

    while True:
        key = cv2.waitKey(50) & 0xFF
        if key == ord("s"):
            if confirmed[0]:
                cv2.destroyAllWindows()
                return confirmed[0]
            print("  ⚠️  Сначала обведи область мышью")
        elif key == ord("r"):
            confirmed[0]  = None
            rect_start[0] = None
            rect_cur[0]   = None
            _draw()
            print("  ↺ Сброс — рисуй заново")
        elif key == 27:   # ESC
            cv2.destroyAllWindows()
            return None
        _draw()


# ── Главная точка входа ────────────────────────────────────────────────────────

def main() -> None:
    print()
    print(DIVIDER)
    print("  📐 Выделение области стола вручную")
    print(DIVIDER)
    print()

    cfg   = _load_config()
    saved = cfg.get("manual_table_bbox")
    if saved:
        print(f"  Текущая область: ({saved['x']},{saved['y']}) "
              f"{saved['w']}×{saved['h']} px")
        print()

    print("  Разверни игру на весь экран, потом нажми Enter...")
    try:
        input()
    except EOFError:
        pass

    frame = capture_screen()
    print(f"  Захвачен экран: {frame.shape[1]}×{frame.shape[0]} px")
    print()
    print("  Зажми левую кнопку мыши и обведи покерный стол.")
    print()

    bbox = select_region(frame)

    if bbox is None:
        print()
        print("  — Отменено. Область не сохранена.")
        return

    x, y, w, h = bbox
    cfg["manual_table_bbox"] = {"x": x, "y": y, "w": w, "h": h}
    _save_config(cfg)

    print()
    print(DIVIDER)
    print(f"  ✅ Сохранено: ({x},{y}) {w}×{h} px → config.json")
    print(DIVIDER)
    print()
    print("  При следующем запуске [1] Авто-режим")
    print("  эта область применится автоматически.")
    print()
    print("  ⚠️  Если переместишь или изменишь размер окна игры —")
    print("  запусти этот пункт снова чтобы перевыбрать.")
    print()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nОтменено.")
