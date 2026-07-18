"""
calibrate.py — интерактивная калибровка позиций карт.

Запуск:
    python calibrate.py

Что делает:
1. Находит окно браузера с игрой (или даёт выбрать)
2. Делает скриншот окна и показывает его в cv2
3. Ты кликаешь по центру каждой карты (сначала 2 своих, потом 3-5 борда)
4. Сохраняет координаты в config.json

После калибровки запускай poker_scanner.py — он подхватит config.json.
"""

import json
import os
import sys
import time

import cv2
import numpy as np

try:
    import mss
except ImportError:
    print("Установи зависимости: pip install -r requirements.txt")
    sys.exit(1)

CONFIG_PATH = os.path.join(os.path.dirname(__file__), "config.json")
EXAMPLE_PATH = os.path.join(os.path.dirname(__file__), "config.example.json")

# ── Загрузить / создать конфиг ────────────────────────────────────────────────
def load_config() -> dict:
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH) as f:
            return json.load(f)
    if os.path.exists(EXAMPLE_PATH):
        with open(EXAMPLE_PATH) as f:
            return json.load(f)
    return {
        "server_url": "https://ТВОЙ_ДОМЕН.replit.dev/api/python/scan",
        "window_title": "",
        "position": "BTN",
        "players": 6,
        "card_height_pct": 9,
        "regions": [],
    }

def save_config(cfg: dict) -> None:
    # убираем комментарий-ключ если есть
    cfg.pop("_comment", None)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    print(f"\n✅ config.json сохранён ({len(cfg.get('regions', []))} регионов)")

# ── Захват экрана ─────────────────────────────────────────────────────────────
def capture_full_screen() -> np.ndarray:
    with mss.mss() as sct:
        mon = sct.monitors[1]  # основной монитор
        raw = sct.grab(mon)
        img = np.frombuffer(raw.rgb, dtype=np.uint8).reshape(raw.height, raw.width, 3)
        return img.copy()

# ── Калибровка кликами ────────────────────────────────────────────────────────
STEPS = [
    ("Hole1",  "Своя карта 1 (левая)"),
    ("Hole2",  "Своя карта 2 (правая)"),
    ("Board1", "Борд карта 1 (флоп-левая)"),
    ("Board2", "Борд карта 2 (флоп-средняя)"),
    ("Board3", "Борд карта 3 (флоп-правая)"),
    ("Board4", "Борд карта 4 (тёрн)  — нажми Q чтобы пропустить"),
    ("Board5", "Борд карта 5 (ривер) — нажми Q чтобы пропустить"),
]

clicked_points: list[dict] = []
frame: np.ndarray = np.zeros((1, 1, 3), dtype=np.uint8)
step_idx = 0

def mouse_cb(event, x, y, flags, param):
    global step_idx, clicked_points
    if event == cv2.EVENT_LBUTTONDOWN and step_idx < len(STEPS):
        label, desc = STEPS[step_idx]
        h, w = frame.shape[:2]
        cx, cy = x / w, y / h
        clicked_points.append({"label": label, "cx": round(cx, 4), "cy": round(cy, 4)})
        print(f"  ✓ {label}: ({cx:.4f}, {cy:.4f})  — {desc}")
        step_idx += 1
        draw_overlay()

def draw_overlay():
    global frame
    vis = frame.copy()
    h, w = vis.shape[:2]

    # нарисовать уже зафиксированные точки
    for p in clicked_points:
        px, py = int(p["cx"] * w), int(p["cy"] * h)
        cv2.circle(vis, (px, py), 10, (0, 255, 80), 2)
        cv2.putText(vis, p["label"], (px + 12, py - 8),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 80), 1)

    # подсказка следующего шага
    if step_idx < len(STEPS):
        label, desc = STEPS[step_idx]
        msg = f"Кликни: {desc}"
        cv2.putText(vis, msg, (16, 32),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 0), 2)
    else:
        cv2.putText(vis, "Готово! Нажми S для сохранения или R для сброса",
                    (16, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)

    cv2.imshow("Poker Calibration — кликай по картам", vis)

def main():
    global frame, step_idx, clicked_points

    cfg = load_config()

    print("\n=== Poker Scanner — Калибровка ===")
    print("Убедись, что окно с игрой видно на экране, потом нажми Enter.")
    input()

    frame = capture_full_screen()
    print(f"Захвачен экран: {frame.shape[1]}×{frame.shape[0]}")

    cv2.namedWindow("Poker Calibration — кликай по картам", cv2.WINDOW_NORMAL)
    cv2.resizeWindow("Poker Calibration — кликай по картам", 1280, 720)
    cv2.setMouseCallback("Poker Calibration — кликай по картам", mouse_cb)

    step_idx = 0
    clicked_points = []
    draw_overlay()

    print("\nКликай по ЦЕНТРУ каждой карты в указанном порядке.")
    print("Клавиши: Q = пропустить (борд4/борд5), R = начать заново, S = сохранить\n")

    while True:
        key = cv2.waitKey(50) & 0xFF

        if key == ord('q') and step_idx in (5, 6):  # пропустить борд4/борд5
            label, _ = STEPS[step_idx]
            print(f"  — {label}: пропущен")
            step_idx += 1
            if step_idx >= len(STEPS):
                draw_overlay()

        elif key == ord('r'):
            step_idx = 0
            clicked_points = []
            frame = capture_full_screen()
            draw_overlay()
            print("  ↺ Сброс — начинай снова")

        elif key == ord('s') or (step_idx >= len(STEPS) and key != 255):
            if len(clicked_points) < 5:  # минимум 2 hole + 3 board
                print(f"  ⚠️  Нужно минимум 5 точек (у тебя {len(clicked_points)})")
                continue
            cfg["regions"] = clicked_points
            save_config(cfg)
            break

        elif key == 27:  # ESC
            print("Отменено.")
            break

    cv2.destroyAllWindows()
    print("\nТеперь запускай: python poker_scanner.py")

if __name__ == "__main__":
    main()
