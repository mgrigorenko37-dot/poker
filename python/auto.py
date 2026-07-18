"""
auto.py — полностью автоматический запуск сканера.

Запуск:
    python auto.py

Что делает без единого клика:
  1. Находит открытое окно покер-рума (World Poker Club / Ton Poker)
  2. Настраивает HSV-детект стола под найденный рум
  3. Подключает Telegram — без нажатия Enter (авто-поллинг 90 сек)
  4. Собирает шаблоны карт в фоне пока ты играешь
  5. Запускает основной сканер

Единственное что нужно сделать вручную один раз:
  - Вставить server_url (URL твоего Replit) при первом запуске
  - Написать /start боту в Telegram при первом запуске
"""

from __future__ import annotations

import json
import os
import sys
import time
import threading
from typing import Optional

import numpy as np
import requests

# ── Пути ──────────────────────────────────────────────────────────────────────
HERE          = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH   = os.path.join(HERE, "config.json")
EXAMPLE_PATH  = os.path.join(HERE, "config.example.json")
TEMPLATES_DIR = os.path.join(HERE, "templates")
PRESETS_DIR   = os.path.join(HERE, "presets")

# ── Профили румов ─────────────────────────────────────────────────────────────
# keywords    — слова в заголовке окна (lower-case, любое совпадает)
# table_hsv_* — диапазон фетра стола в OpenCV HSV (H: 0-180, S/V: 0-255)
# chip_hsv_*  — диапазон ставочных чипов
# preset      — файл пресета в папке presets/
GAME_PROFILES = [
    {
        "name":         "World Poker Club",
        "keywords":     ["world poker club", "poker club", "s1aime"],
        "table_hsv_lo": [90,  60,  40],
        "table_hsv_hi": [145, 255, 185],
        "chip_hsv_lo":  [15,  80, 120],
        "chip_hsv_hi":  [45, 255, 255],
        "preset":       "world_poker_club_desktop_6max.json",
    },
    {
        "name":         "Ton Poker",
        "keywords":     ["ton poker"],
        "table_hsv_lo": [55,  20,  75],
        "table_hsv_hi": [95, 110, 175],
        "chip_hsv_lo":  [15,  80, 120],
        "chip_hsv_hi":  [45, 255, 255],
        "preset":       "ton_poker_desktop_6max.json",
    },
]

DIVIDER = "─" * 52


# ══════════════════════════════════════════════════════════════════════════════
#  1. Поиск окна игры
# ══════════════════════════════════════════════════════════════════════════════

def find_game_window() -> Optional[dict]:
    """Возвращает профиль первого найденного покер-рума или None."""
    if sys.platform != "win32":
        return None
    try:
        import win32gui
    except ImportError:
        return None

    found: Optional[dict] = None

    def _cb(hwnd, _):
        nonlocal found
        if found:
            return
        if not win32gui.IsWindowVisible(hwnd):
            return
        title = win32gui.GetWindowText(hwnd).lower()
        for profile in GAME_PROFILES:
            for kw in profile["keywords"]:
                if kw in title:
                    found = profile
                    return

    win32gui.EnumWindows(_cb, None)
    return found


# ══════════════════════════════════════════════════════════════════════════════
#  2. Конфиг — загрузка / создание
# ══════════════════════════════════════════════════════════════════════════════

def ensure_config(profile: Optional[dict]) -> dict:
    """
    Загружает config.json (или создаёт из примера).
    Если server_url не задан — запрашивает один раз и сохраняет.
    Если регионы пустые и есть профиль — применяет пресет.
    """
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg = json.load(f)
    elif os.path.exists(EXAMPLE_PATH):
        with open(EXAMPLE_PATH, encoding="utf-8") as f:
            cfg = json.load(f)
        for k in list(cfg.keys()):
            if k.startswith("_"):
                cfg.pop(k)
        # Сохраняем сразу — poker_scanner.load_config() читает с диска
        _save_config(cfg)
    else:
        cfg = {
            "server_url": "",
            "position":   "BTN",
            "players":    6,
            "card_height_pct": 10,
            "regions":    [],
            "money_regions": {},
        }

    # ── server_url ────────────────────────────────────────────────────────
    url = cfg.get("server_url", "")
    if not url or "ТВОЙ_ДОМЕН" in url:
        # Первый запуск — URL не задан
        print()
        print(DIVIDER)
        print("  Первый запуск — нужен server_url")
        print(DIVIDER)
        print()
        print("  Открой Replit → скопируй ссылку вида:")
        print("  https://xxxxx.replit.dev/api/python/scan")
        print()
        url = input("  Вставь URL: ").strip()
        cfg["server_url"] = url
        _save_config(cfg)
        print("  ✅ Сохранено\n")
    else:
        # URL уже есть — показываем и даём сменить
        print(f"🔗 URL: {url}")
        print("   Сменить? [y/N]: ", end="", flush=True)

        ans_holder: list[str] = [""]

        def _read_url_ans() -> None:
            try:
                ans_holder[0] = input().strip().lower()
            except Exception:
                pass

        t = threading.Thread(target=_read_url_ans, daemon=True)
        t.start()
        t.join(timeout=5)

        if ans_holder[0] == "y":
            print()
            print("  Открой Replit → скопируй ссылку вида:")
            print("  https://xxxxx.replit.dev/api/python/scan")
            print()
            new_url = input("  Вставь новый URL: ").strip()
            if new_url:
                cfg["server_url"] = new_url
                url = new_url
                _save_config(cfg)
                print("  ✅ URL обновлён\n")
            else:
                print("  — Пусто, оставляю старый\n")
        else:
            print("(без изменений)")

    # ── Пресет — если регионы пустые ИЛИ сменился профиль игры ──────────
    active = cfg.get("active_preset", "")
    preset_changed = profile and (profile["preset"] != active)
    no_regions     = not cfg.get("regions")
    if profile and (no_regions or preset_changed):
        preset_path = os.path.join(PRESETS_DIR, profile["preset"])
        if os.path.exists(preset_path):
            with open(preset_path, encoding="utf-8") as f:
                preset = json.load(f)
            for key in ("regions", "money_regions", "card_height_pct"):
                if key in preset:
                    cfg[key] = preset[key]
            cfg["active_preset"] = profile["preset"]
            _save_config(cfg)
            if preset_changed and not no_regions:
                print(f"  🔄 Профиль сменился → пресет обновлён: {profile['name']}")
            else:
                print(f"  📦 Пресет применён: {profile['name']}")

    return cfg


def _save_config(cfg: dict) -> None:
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


# ══════════════════════════════════════════════════════════════════════════════
#  3.5. Ручная область стола
# ══════════════════════════════════════════════════════════════════════════════

def _setup_manual_bbox(cfg: dict) -> None:
    """
    Если в config.json есть manual_table_bbox — загружает его в table_detector,
    HSV-поиск при этом отключается.

    Если bbox не сохранён — предлагает выделить стол вручную прямо сейчас
    (5-секундный таймаут, по умолчанию «нет» → авто-детект).
    """
    import table_detector as _td

    saved = cfg.get("manual_table_bbox")

    if saved:
        # Загружаем сохранённую область
        bbox = (saved["x"], saved["y"], saved["w"], saved["h"])
        _td.set_manual_bbox(bbox)
        print(
            f"📐 Стол: ручная область ({bbox[0]},{bbox[1]}) "
            f"{bbox[2]}×{bbox[3]} px  "
            f"[для смены запусти пункт 8 в меню]"
        )
        return

    # Bbox не сохранён — предложить выделить вручную
    print()
    print("📐 Выделить стол вручную? [y/N]: ", end="", flush=True)

    ans_holder: list[str] = [""]

    def _read_input() -> None:
        try:
            ans_holder[0] = input().strip().lower()
        except Exception:
            pass

    t = threading.Thread(target=_read_input, daemon=True)
    t.start()
    t.join(timeout=5)

    if ans_holder[0] != "y":
        print("(авто-детект HSV)")
        return

    # Пользователь согласился — запускаем интерактивный выбор
    try:
        from select_region import select_region, capture_screen as _cap
    except ImportError:
        print("  ⚠️  select_region.py не найден — используется авто-детект")
        return

    print()
    print("  Разверни игру на весь экран, потом нажми Enter...")
    try:
        input()
    except EOFError:
        pass

    frame = _cap()
    print(f"  Захвачен экран: {frame.shape[1]}×{frame.shape[0]} px")
    print()

    bbox = select_region(frame)
    if bbox is None:
        print("  — Отменено, используется авто-детект")
        return

    x, y, w, h = bbox
    cfg["manual_table_bbox"] = {"x": x, "y": y, "w": w, "h": h}
    _save_config(cfg)
    _td.set_manual_bbox(bbox)
    print(f"  ✅ Сохранено и активировано: ({x},{y}) {w}×{h} px")


# ══════════════════════════════════════════════════════════════════════════════
#  3. Проверка доступности сервера
# ══════════════════════════════════════════════════════════════════════════════

def _check_server(cfg: dict) -> None:
    """Проверяет что Replit-сервер доступен. Если нет — даёт инструкцию."""
    url  = cfg.get("server_url", "")
    base = url.split("/api/")[0] if "/api/" in url else url.rstrip("/")
    if not base:
        return

    print("🌐 Проверяю сервер...", end=" ", flush=True)
    try:
        r = requests.get(f"{base}/api/healthz", timeout=5)
        if r.status_code == 200:
            print("доступен ✅")
            return
    except Exception:
        pass

    print("недоступен ⚠️")
    print()
    print(DIVIDER)
    print("  Сервер Replit не отвечает!")
    print(DIVIDER)
    print()
    print(f"  URL в config.json: {base}")
    print()
    print("  Если URL старый — замени server_url в config.json на:")
    print(f"  {base}/api/python/scan")
    print()
    print("  Если URL правильный — открой Replit и нажми Run (▶)")
    print()
    print("  Сканер продолжит работу, но советы в Telegram")
    print("  не придут пока сервер не запущен.")
    print()


# ══════════════════════════════════════════════════════════════════════════════
#  4. Telegram — авто-привязка без Enter
# ══════════════════════════════════════════════════════════════════════════════

def auto_link_telegram(cfg: dict) -> None:
    """
    Привязывает Telegram автоматически.
    Вместо нажатия Enter — поллинг /api/telegram/link каждые 2 секунды.
    Ждёт 90 секунд, затем продолжает без Telegram.
    """
    url  = cfg.get("server_url", "")
    base = url.split("/api/")[0] if "/api/" in url else url.rstrip("/")
    if not base:
        return

    try:
        r      = requests.get(f"{base}/api/telegram/status", timeout=5)
        status = r.json()
    except Exception:
        print("⚠️  Telegram: сервер недоступен, пропускаю")
        return

    if status.get("ready") or status.get("hasChatId") or status.get("configured"):
        print("📱 Telegram: уже подключён ✅")
        return

    if not status.get("hasToken"):
        print("⚠️  Telegram: TELEGRAM_BOT_TOKEN не задан в Replit Secrets")
        return

    print()
    print(DIVIDER)
    print("  Подключение Telegram (только первый раз)")
    print(DIVIDER)
    print()
    print("  1. Открой Telegram")
    print("  2. Найди своего бота и напиши: /start")
    print()
    print("  ⏳ Жду /start автоматически (90 сек)...\n")

    deadline = time.time() + 90
    while time.time() < deadline:
        remaining = int(deadline - time.time())
        print(f"\r  ⏳ {remaining} сек...  ", end="", flush=True)
        try:
            r    = requests.post(f"{base}/api/telegram/link", timeout=10)
            data = r.json()
            if r.status_code == 200 and data.get("ok"):
                name = data.get("username", "")
                tag  = f" (@{name})" if name else ""
                print(f"\r  ✅ Telegram подключён!{tag}              ")
                try:
                    requests.post(f"{base}/api/telegram/test", timeout=10)
                except Exception:
                    pass
                print()
                return
        except Exception:
            pass
        time.sleep(2)

    print(f"\r  ⚠️  Не дождался /start — продолжаю без Telegram.       ")
    print()


# ══════════════════════════════════════════════════════════════════════════════
#  4. Фоновый сбор шаблонов карт
# ══════════════════════════════════════════════════════════════════════════════

def _count_templates() -> int:
    if not os.path.isdir(TEMPLATES_DIR):
        return 0
    return sum(
        1 for f in os.listdir(TEMPLATES_DIR)
        if f.endswith(".png") and len(f) <= 7  # "Ah.png" = 6 символов
    )


def _template_collector(cfg: dict) -> None:
    """Фоновый поток: собирает шаблоны карт пока идёт сканирование."""
    try:
        import cv2
        import easyocr
        import mss
        from collect_templates import ocr_card_full, extract_card, loaded_cards, ALL_CARDS
        from card_utils import configure_suits
        import table_detector

        configure_suits(cfg)
        card_h_pct = cfg.get("card_height_pct", 9)
        manual_regions = cfg.get("regions", [])

        os.makedirs(TEMPLATES_DIR, exist_ok=True)
        reader     = easyocr.Reader(["en"], gpu=False, verbose=False)
        last_count = _count_templates()

        with mss.MSS() as sct:
            while True:
                missing = ALL_CARDS - loaded_cards()
                if not missing:
                    done = 52 - len(missing)
                    if done > last_count:
                        print(f"\n  🎉 [фон] Все 52 шаблона собраны!")
                    break

                done = 52 - len(missing)
                if done > last_count and done % 4 == 0:
                    print(f"\n  🃏 [фон] Шаблоны: {done}/52")
                    last_count = done

                mon   = sct.monitors[1]
                raw   = sct.grab(mon)
                frame = np.frombuffer(raw.rgb, dtype=np.uint8)\
                            .reshape(raw.height, raw.width, 3).copy()
                fh, fw = frame.shape[:2]

                regions_dict, dbg = table_detector.get_table_state(frame)
                if regions_dict is not None and dbg.get("bbox"):
                    regions = regions_dict["regions"]
                    _, _, _, bh = dbg["bbox"]
                    ch = max(10, int(bh * 0.095))
                elif manual_regions:
                    regions = manual_regions
                    ch = max(10, int(fh * card_h_pct / 100))
                else:
                    time.sleep(0.5)
                    continue

                cw = max(8, int(ch * 0.72))

                for r in regions:
                    crop = extract_card(frame, r["cx"], r["cy"], cw, ch)
                    if crop.size == 0:
                        continue
                    rank, suit, conf = ocr_card_full(reader, crop)
                    if rank is None or suit is None or conf < 0.75:
                        continue
                    key = f"{rank}{suit}"
                    if key not in missing:
                        continue
                    path = os.path.join(TEMPLATES_DIR, f"{key}.png")
                    bgr  = cv2.cvtColor(crop, cv2.COLOR_RGB2BGR)
                    cv2.imwrite(path, bgr)
                    missing.discard(key)
                    print(f"\n  💾 [фон] Сохранён шаблон: {key}  (уверенность {conf:.2f})")

                time.sleep(0.3)

    except Exception as e:
        print(f"\n  ⚠️  [фон] Сборщик шаблонов завершился: {e}")


# ══════════════════════════════════════════════════════════════════════════════
#  Главная точка входа
# ══════════════════════════════════════════════════════════════════════════════

def main() -> None:
    print()
    print(DIVIDER)
    print("  ♠  POKER SCANNER — авто-режим")
    print(DIVIDER)
    print()

    # ── 1. Ищем окно игры ─────────────────────────────────────────────────
    print("🔍 Ищу окно покер-рума...", end=" ", flush=True)
    profile = find_game_window()

    if profile:
        print(f"найдено: {profile['name']} ✅")
    else:
        print("не найдено")
        print("  Открой игру и попробуй снова, или продолжаю с текущим конфигом.\n")

    # ── 2. Настраиваем HSV стола ──────────────────────────────────────────
    if profile:
        import table_detector
        table_detector.configure_table_detection(
            profile["table_hsv_lo"],
            profile["table_hsv_hi"],
            profile["chip_hsv_lo"],
            profile["chip_hsv_hi"],
        )
        print(f"🎨 Детект стола: настроен под {profile['name']}")

    # ── 3. Конфиг ─────────────────────────────────────────────────────────
    cfg = ensure_config(profile)

    # ── 3.5 Ручная область стола ──────────────────────────────────────────
    _setup_manual_bbox(cfg)

    # ── 4. Проверяем доступность сервера ─────────────────────────────────
    _check_server(cfg)

    # ── 5. Telegram (без Enter) ───────────────────────────────────────────
    auto_link_telegram(cfg)

    # ── 5. Фоновый сбор шаблонов ─────────────────────────────────────────
    n = _count_templates()
    if n >= 52:
        print(f"🃏 Шаблоны: {n}/52 — все готовы ✅")
    else:
        print(f"🃏 Шаблоны: {n}/52 — запускаю сборку в фоне (просто играй)")
        t = threading.Thread(target=_template_collector, args=(cfg,), daemon=True)
        t.start()

    print()
    print(f"🚀 Запускаю сканер...")
    print()

    # ── 6. Запускаем сканер ───────────────────────────────────────────────
    # Monkey-patch setup_telegram: мы уже всё настроили выше,
    # пусть scanner пропустит свой интерактивный вопрос.
    import poker_scanner
    poker_scanner.setup_telegram = lambda cfg: (
        print("📱 Telegram: проверка пропущена (уже выполнена auto.py)")
    )
    poker_scanner.main()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nОстановлено.")
