"""
gen_suit_templates.py — авто-генерация шаблонов мастей из скриншота Ton Poker.

Как работает:
  1. Делает скриншот экрана (или читает переданный файл)
  2. Находит белые прямоугольники карт на зелёном фоне
  3. Вырезает область масти (нижние 55% карты, центр)
  4. Определяет цвет (красный/чёрный) и форму (шаблонное сравнение)
  5. Сохраняет suit_h.png / suit_d.png / suit_c.png / suit_s.png
     в папку templates/suits/

Запусти пока на столе видны карты. За одну сессию нужно увидеть все 4 масти.
Повторный запуск добавляет недостающие.
"""

from __future__ import annotations

import os
import sys
import json
import time
import cv2
import numpy as np
from cv2_unicode import imread as _cv2_imread, imwrite as _cv2_imwrite

try:
    import mss
    HAS_MSS = True
except ImportError:
    HAS_MSS = False

# ── Пути ─────────────────────────────────────────────────────────────────────
BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
SUITS_DIR    = os.path.join(BASE_DIR, "templates", "suits")
CONFIG_PATH  = os.path.join(BASE_DIR, "config.json")

SUIT_NAMES   = {"h": "♥  (червы/hearts)",
                "d": "♦  (бубны/diamonds)",
                "c": "♣  (трефы/clubs)",
                "s": "♠  (пики/spades)"}

DIVIDER = "─" * 52


# ── Захват экрана ──────────────────────────────────────────────────────────
def capture() -> np.ndarray:
    if HAS_MSS:
        with mss.MSS() as sct:
            mon = sct.monitors[0]
            img = np.array(sct.grab(mon))
            return cv2.cvtColor(img, cv2.COLOR_BGRA2RGB)
    return None


def load_image(path: str) -> np.ndarray:
    img = _cv2_imread(path)
    if img is None:
        return None
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


# ── Найти карты (белые прямоугольники на зелёном фоне) ──────────────────────
def find_cards(frame: np.ndarray,
               min_w: int = 25, min_h: int = 35,
               max_w: int = 400, max_h: int = 400) -> list[tuple[int,int,int,int]]:
    """
    Возвращает список (x, y, w, h) найденных карт.
    Ищет белые прямоугольники — порог V > 200, S < 40 в HSV.
    Если несколько карт слиплись в один широкий контур — делит по ширине.
    """
    hsv   = cv2.cvtColor(frame, cv2.COLOR_RGB2HSV)
    mask  = cv2.inRange(hsv, (0, 0, 200), (180, 40, 255))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    mask   = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=3)
    mask   = cv2.morphologyEx(mask, cv2.MORPH_OPEN,  kernel, iterations=2)

    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cards = []
    for c in cnts:
        x, y, w, h = cv2.boundingRect(c)
        if h < min_h or h > max_h:
            continue
        ratio = w / max(1, h)
        if 0.45 <= ratio <= 0.95 and min_w <= w <= max_w:
            # Одиночная карта
            cards.append((x, y, w, h))
        elif ratio > 0.95 and w >= min_w * 2:
            # Несколько карт рядом — делим горизонтально
            # Типичное соотношение карты ~0.70
            n = max(2, min(8, round(ratio / 0.70)))
            card_w = w // n
            for i in range(n):
                cards.append((x + i * card_w, y, card_w, h))

    # Убираем дубли (вложенные боксы)
    cards.sort(key=lambda r: r[2] * r[3], reverse=True)
    filtered: list[tuple[int,int,int,int]] = []
    for box in cards:
        bx, by, bw, bh = box
        cx, cy = bx + bw // 2, by + bh // 2
        dominated = any(
            fx <= cx <= fx + fw and fy <= cy <= fy + fh
            for fx, fy, fw, fh in filtered
        )
        if not dominated:
            filtered.append(box)

    return filtered


# ── Вырезать область масти ───────────────────────────────────────────────────
def crop_suit_area(card_img: np.ndarray) -> np.ndarray:
    """
    Берёт нижние 60% карты (исключая ранг в углу) — там масть.
    """
    h, w = card_img.shape[:2]
    y0 = int(h * 0.30)
    x0 = int(w * 0.10)
    x1 = int(w * 0.90)
    return card_img[y0:, x0:x1]


# ── Определить цвет масти ────────────────────────────────────────────────────
def suit_color(suit_crop: np.ndarray) -> str:
    """'red' или 'black'."""
    hsv = cv2.cvtColor(suit_crop, cv2.COLOR_RGB2HSV)
    # Красные пиксели: H < 20 или H > 155, S > 80, V > 80
    red_mask = (
        ((hsv[:,:,0] < 20) | (hsv[:,:,0] > 155)) &
        (hsv[:,:,1].astype(int) > 80) &
        (hsv[:,:,2].astype(int) > 80)
    )
    return "red" if np.sum(red_mask) > 20 else "black"


# ── Определить форму (♥ vs ♦, ♣ vs ♠) ──────────────────────────────────────
def suit_shape(suit_crop: np.ndarray, color: str) -> str:
    """
    Для красных: ♥ vs ♦ по соотношению высоты к ширине контура.
      ♥ вытянут вертикально (aspect > 1.0)
      ♦ вытянут вертикально тоже, но верхняя часть острее → span верха шире
    Для чёрных: ♠ vs ♣ по span верхней четверти.
    """
    gray = cv2.cvtColor(suit_crop, cv2.COLOR_RGB2GRAY)

    if color == "red":
        # Маска красных пикселей
        hsv = cv2.cvtColor(suit_crop, cv2.COLOR_RGB2HSV)
        mask = (
            ((hsv[:,:,0] < 20) | (hsv[:,:,0] > 155)) &
            (hsv[:,:,1].astype(int) > 60) &
            (hsv[:,:,2].astype(int) > 60)
        ).astype(np.uint8) * 255
    else:
        # Маска тёмных пикселей (инвертированный белый фон)
        _, mask = cv2.threshold(gray, 100, 255, cv2.THRESH_BINARY_INV)

    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN,
                            np.ones((3,3), np.uint8), iterations=1)

    h, w = mask.shape
    if h == 0 or w == 0 or np.sum(mask) == 0:
        return "h" if color == "red" else "c"

    # Span верхней четверти
    top = mask[: h // 4, :]
    if np.sum(top) > 0:
        cols = np.where(top.any(axis=0))[0]
        if len(cols) >= 2:
            span = (cols[-1] - cols[0]) / max(1, w)
            if color == "red":
                # ♦ ромб: верх острый → span < 0.55
                # ♥ сердце: вверху два горба → span > 0.55
                return "d" if span < 0.55 else "h"
            else:
                # ♠ пика: острый верх → span < 0.38
                # ♣ трефа: два лепестка → span > 0.38
                return "s" if span < 0.38 else "c"

    return "h" if color == "red" else "c"


# ── Сохранить шаблон ─────────────────────────────────────────────────────────
def save_template(suit: str, crop: np.ndarray) -> str:
    os.makedirs(SUITS_DIR, exist_ok=True)
    path = os.path.join(SUITS_DIR, f"suit_{suit}.png")
    _cv2_imwrite(path, cv2.cvtColor(crop, cv2.COLOR_RGB2BGR))
    return path


# ── Показать превью (необязательно) ──────────────────────────────────────────
def show_preview(cards_found: list, frame: np.ndarray,
                 results: dict[str, str]) -> None:
    vis = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
    for (x, y, w, h) in cards_found:
        suit_key = results.get(f"{x}_{y}")
        color = (0, 200, 0) if suit_key else (100, 100, 100)
        label = suit_key.upper() if suit_key else "?"
        cv2.rectangle(vis, (x, y), (x+w, y+h), color, 2)
        cv2.putText(vis, label, (x+4, y+20),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
    cv2.imshow("gen_suit_templates — найденные карты (ESC = закрыть)", vis)
    cv2.waitKey(3000)
    cv2.destroyAllWindows()


# ── Основной цикл ─────────────────────────────────────────────────────────────
def load_existing() -> set[str]:
    existing = set()
    for s in ("h", "d", "c", "s"):
        if os.path.exists(os.path.join(SUITS_DIR, f"suit_{s}.png")):
            existing.add(s)
    return existing


def run_once(frame: np.ndarray) -> dict[str, np.ndarray]:
    """Обрабатывает один кадр. Возвращает {suit: crop}."""
    cards = find_cards(frame)
    found: dict[str, np.ndarray] = {}

    for (x, y, w, h) in cards:
        card_img  = frame[y:y+h, x:x+w]
        suit_area = crop_suit_area(card_img)
        if suit_area.size == 0:
            continue
        color = suit_color(suit_area)
        shape = suit_shape(suit_area, color)
        if shape not in found:
            found[shape] = suit_area

    return found


def main() -> None:
    print()
    print(DIVIDER)
    print("  🃏 Генератор шаблонов мастей — Ton Poker")
    print(DIVIDER)

    # Можно передать файл аргументом: python gen_suit_templates.py screenshot.png
    img_path = sys.argv[1] if len(sys.argv) > 1 else None

    if img_path:
        frame = load_image(img_path)
        if frame is None:
            print(f"  ❌ Не удалось загрузить: {img_path}")
            return
        frames = [frame]
        live_mode = False
    elif HAS_MSS:
        live_mode = True
        frames = []
    else:
        print("  ❌ mss не установлен и файл не передан.")
        print("     pip install mss")
        return

    existing  = load_existing()
    collected: dict[str, np.ndarray] = {}

    print()
    if existing:
        print(f"  Уже есть: {', '.join(existing)}")
    needed = set("hdcs") - existing
    if not needed:
        print("  ✅ Все 4 масти уже собраны! Шаблоны актуальны.")
        return

    print(f"  Ищем: {', '.join(needed)}")
    print()

    if not live_mode:
        # Режим одного файла
        found = run_once(frames[0])
        for suit, crop in found.items():
            if suit in needed and suit not in collected:
                collected[suit] = crop
                print(f"  ✅ Найдена масть: {SUIT_NAMES.get(suit, suit)}")
    else:
        print("  Разверни покер на экране и запусти раздачу.")
        print("  Скрипт сам найдёт карты. Нужно увидеть все 4 масти.")
        print()
        print("  [Enter] — сканировать  |  [q + Enter] — выход")
        print()

        scan_count = 0
        while needed - set(collected.keys()):
            cmd = ""
            try:
                cmd = input("  > ").strip().lower()
            except EOFError:
                break
            if cmd == "q":
                break

            frame = capture()
            if frame is None:
                print("  ⚠️  Не удалось сделать скриншот")
                continue

            scan_count += 1
            found = run_once(frame)
            new_this_scan = []
            for suit, crop in found.items():
                if suit in needed and suit not in collected:
                    collected[suit] = crop
                    new_this_scan.append(suit)

            still_need = needed - set(collected.keys())
            if new_this_scan:
                for s in new_this_scan:
                    print(f"  ✅ Найдена масть: {SUIT_NAMES.get(s, s)}")
            else:
                print(f"  Скан #{scan_count}: карт не найдено. Ещё нужно: "
                      f"{', '.join(still_need)}")

    # Сохранить собранные
    saved = []
    for suit, crop in collected.items():
        if suit in needed:
            path = save_template(suit, crop)
            saved.append(suit)
            print(f"  💾 Сохранено: {os.path.basename(path)}")

    print()
    total = existing | set(saved)
    if len(total) == 4:
        print(DIVIDER)
        print("  ✅ Все 4 шаблона готовы!")
        print("  Сканер теперь использует template matching для мастей.")
        print(DIVIDER)
    else:
        missing = set("hdcs") - total
        print(f"  ⚠️  Не хватает: {', '.join(SUIT_NAMES.get(s,s) for s in missing)}")
        print("  Запусти скрипт снова когда эти масти появятся на столе.")

    print()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nОстановлено.")
