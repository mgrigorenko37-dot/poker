"""
calibrate.py — интерактивная калибровка позиций карт И денежных областей.

Запуск:
    python calibrate.py

Фаза 1 — Карты: кликаешь по центру каждой карты (2 своих + 3-5 борда).
Фаза 2 — Деньги: зажимаешь ЛКМ и рисуешь прямоугольник вокруг суммы банка,
          потом то же самое для суммы ставки/колла.
          Нажми Q чтобы пропустить (если рум не показывает колл в нужном месте).
"""

import json
import os
import sys

import cv2
import numpy as np

try:
    import mss
except ImportError:
    print("Установи зависимости: pip install -r requirements.txt")
    sys.exit(1)

CONFIG_PATH  = os.path.join(os.path.dirname(__file__), "config.json")
EXAMPLE_PATH = os.path.join(os.path.dirname(__file__), "config.example.json")

WIN_NAME = "Poker Calibration"

# ── Конфиг ────────────────────────────────────────────────────────────────────
def load_config() -> dict:
    for p in (CONFIG_PATH, EXAMPLE_PATH):
        if os.path.exists(p):
            with open(p) as f:
                return json.load(f)
    return {
        "server_url": "https://ТВОЙ_ДОМЕН.replit.dev/api/python/scan",
        "position": "BTN",
        "players": 6,
        "card_height_pct": 9,
        "regions": [],
        "money_regions": {},
    }

def save_config(cfg: dict) -> None:
    cfg.pop("_comment", None)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    n_cards  = len(cfg.get("regions", []))
    n_money  = len(cfg.get("money_regions", {}))
    print(f"\n✅ config.json сохранён  ({n_cards} карточных регионов, {n_money} денежных)")

# ── Захват экрана ─────────────────────────────────────────────────────────────
def capture_screen() -> np.ndarray:
    with mss.mss() as sct:
        mon = sct.monitors[1]
        raw = sct.grab(mon)
        img = np.frombuffer(raw.rgb, dtype=np.uint8).reshape(raw.height, raw.width, 3)
        return img.copy()

# ═══════════════════════════════════════════════════════════════════════════════
#  ФАЗА 1 — калибровка карт (клики)
# ═══════════════════════════════════════════════════════════════════════════════
CARD_STEPS = [
    ("Hole1",  "Своя карта 1 (левая)"),
    ("Hole2",  "Своя карта 2 (правая)"),
    ("Board1", "Борд 1 — флоп левая"),
    ("Board2", "Борд 2 — флоп средняя"),
    ("Board3", "Борд 3 — флоп правая"),
    ("Board4", "Борд 4 — тёрн  [Q = пропустить]"),
    ("Board5", "Борд 5 — ривер [Q = пропустить]"),
]

_card_points: list[dict] = []
_card_step   = 0
_frame: np.ndarray = np.zeros((100, 100, 3), dtype=np.uint8)

def _card_mouse(event, x, y, flags, param):
    global _card_step
    if event == cv2.EVENT_LBUTTONDOWN and _card_step < len(CARD_STEPS):
        label, desc = CARD_STEPS[_card_step]
        h, w = _frame.shape[:2]
        cx, cy = x / w, y / h
        _card_points.append({"label": label, "cx": round(cx, 4), "cy": round(cy, 4)})
        print(f"  ✓ {label}: ({cx:.4f}, {cy:.4f})  ← {desc}")
        _card_step += 1
        _draw_card_overlay()

def _draw_card_overlay():
    vis = _frame.copy()
    h, w = vis.shape[:2]
    for p in _card_points:
        px, py = int(p["cx"] * w), int(p["cy"] * h)
        cv2.circle(vis, (px, py), 12, (0, 255, 80), 2)
        cv2.putText(vis, p["label"], (px + 14, py - 8),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 80), 1)
    if _card_step < len(CARD_STEPS):
        msg = f"Кликни: {CARD_STEPS[_card_step][1]}"
        cv2.putText(vis, msg, (16, 36), cv2.FONT_HERSHEY_SIMPLEX, 0.85, (255, 220, 0), 2)
    else:
        cv2.putText(vis, "Карты готовы!  Нажми S чтобы перейти к деньгам",
                    (16, 36), cv2.FONT_HERSHEY_SIMPLEX, 0.85, (0, 255, 80), 2)
    cv2.imshow(WIN_NAME, vis)

def run_card_phase() -> list[dict]:
    global _frame, _card_step
    _card_points.clear()
    _card_step = 0

    cv2.namedWindow(WIN_NAME, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(WIN_NAME, 1280, 720)
    cv2.setMouseCallback(WIN_NAME, _card_mouse)
    _draw_card_overlay()

    print("\n▶ Фаза 1 — КАРТЫ")
    print("  Кликай по ЦЕНТРУ карты.  Q = пропустить борд4/5,  R = сброс,  S = готово\n")

    while True:
        key = cv2.waitKey(50) & 0xFF
        if key == ord('q') and _card_step in (5, 6):
            print(f"  — {CARD_STEPS[_card_step][0]}: пропущен")
            _card_step += 1
            _draw_card_overlay()
        elif key == ord('r'):
            _card_points.clear()
            _card_step = 0
            _frame = capture_screen()
            _draw_card_overlay()
            print("  ↺ Сброс")
        elif key == ord('s'):
            if len(_card_points) < 5:
                print(f"  ⚠️  Нужно минимум 5 точек (есть {len(_card_points)})")
            else:
                return list(_card_points)
        elif key == 27:
            return []

# ═══════════════════════════════════════════════════════════════════════════════
#  ФАЗА 2 — денежные области (прямоугольники)
# ═══════════════════════════════════════════════════════════════════════════════
MONEY_STEPS = [
    ("pot", "Банк (pot) — обведи прямоугольником ЦИФРУ суммы банка"),
    ("bet", "Колл/ставка (bet) — обведи ЦИФРУ колла  [Q = пропустить]"),
]

_money_regions: dict[str, dict] = {}
_money_step  = 0
_rect_start  = None   # (x, y) начало drag
_rect_cur    = None   # (x, y) текущее положение при drag

def _money_mouse(event, x, y, flags, param):
    global _rect_start, _rect_cur, _money_step

    if _money_step >= len(MONEY_STEPS):
        return

    if event == cv2.EVENT_LBUTTONDOWN:
        _rect_start = (x, y)
        _rect_cur   = (x, y)

    elif event == cv2.EVENT_MOUSEMOVE and _rect_start:
        _rect_cur = (x, y)
        _draw_money_overlay()

    elif event == cv2.EVENT_LBUTTONUP and _rect_start:
        x1, y1 = min(_rect_start[0], x), min(_rect_start[1], y)
        x2, y2 = max(_rect_start[0], x), max(_rect_start[1], y)
        if (x2 - x1) < 10 or (y2 - y1) < 5:
            print("  ⚠️  Прямоугольник слишком маленький, попробуй снова")
            _rect_start = None
            return
        label = MONEY_STEPS[_money_step][0]
        h, w  = _frame.shape[:2]
        _money_regions[label] = {
            "x1": round(x1 / w, 4), "y1": round(y1 / h, 4),
            "x2": round(x2 / w, 4), "y2": round(y2 / h, 4),
        }
        print(f"  ✓ {label}: ({x1},{y1})→({x2},{y2})")
        _money_step += 1
        _rect_start = None
        _rect_cur   = None
        _draw_money_overlay()

def _draw_money_overlay():
    vis = _frame.copy()
    h, w = vis.shape[:2]

    # уже нарисованные регионы
    colors = {"pot": (0, 200, 255), "bet": (200, 120, 255)}
    for label, r in _money_regions.items():
        pt1 = (int(r["x1"] * w), int(r["y1"] * h))
        pt2 = (int(r["x2"] * w), int(r["y2"] * h))
        cv2.rectangle(vis, pt1, pt2, colors.get(label, (200, 200, 200)), 2)
        cv2.putText(vis, label, (pt1[0] + 4, pt1[1] - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, colors.get(label, (200, 200, 200)), 2)

    # live drag preview
    if _rect_start and _rect_cur:
        cv2.rectangle(vis, _rect_start, _rect_cur, (255, 255, 0), 1)

    if _money_step < len(MONEY_STEPS):
        msg = f"Зажми и обведи: {MONEY_STEPS[_money_step][1]}"
        cv2.putText(vis, msg, (16, 36), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 220, 0), 2)
    else:
        cv2.putText(vis, "Готово! Нажми S для сохранения",
                    (16, 36), cv2.FONT_HERSHEY_SIMPLEX, 0.85, (0, 255, 80), 2)

    cv2.imshow(WIN_NAME, vis)

def run_money_phase() -> dict:
    global _money_step
    _money_regions.clear()
    _money_step = 0

    cv2.setMouseCallback(WIN_NAME, _money_mouse)
    _draw_money_overlay()

    print("\n▶ Фаза 2 — ДЕНЬГИ")
    print("  Зажми ЛКМ и обведи прямоугольником число (банк / колл).")
    print("  Q = пропустить колл,  R = сброс фазы,  S = сохранить и выйти\n")

    while True:
        key = cv2.waitKey(50) & 0xFF
        if key == ord('q') and _money_step == 1:   # пропустить bet
            print("  — bet: пропущен")
            _money_step += 1
            _draw_money_overlay()
        elif key == ord('r'):
            _money_regions.clear()
            _money_step = 0
            _draw_money_overlay()
            print("  ↺ Сброс денежных регионов")
        elif key == ord('s'):
            if "pot" not in _money_regions:
                print("  ⚠️  Нужно обвести хотя бы банк (pot)")
            else:
                return dict(_money_regions)
        elif key == 27:
            return {}

# ═══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════════════════════
def main():
    global _frame

    cfg = load_config()

    print("\n=== Poker Scanner — Калибровка ===")
    print("Разверни окно с игрой, потом нажми Enter.")
    input()

    _frame = capture_screen()
    print(f"Захвачен экран: {_frame.shape[1]}×{_frame.shape[0]}\n")

    # ── Фаза 1: карты ─────────────────────────────────────────────────────────
    card_points = run_card_phase()
    if len(card_points) < 5:
        print("Калибровка отменена.")
        cv2.destroyAllWindows()
        return
    cfg["regions"] = card_points

    # ── Фаза 2: деньги ────────────────────────────────────────────────────────
    print("\nОбнови скриншот (Enter) или сразу переходи к обводке денег (пробел).")
    key = cv2.waitKey(3000) & 0xFF
    if key == 13 or key == 255:   # Enter или таймаут
        _frame = capture_screen()
        print("Скриншот обновлён.")

    money = run_money_phase()
    cfg["money_regions"] = money

    cv2.destroyAllWindows()
    save_config(cfg)
    print("\nТеперь запускай: python poker_scanner.py")

if __name__ == "__main__":
    main()
