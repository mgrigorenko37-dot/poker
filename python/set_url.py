"""
set_url.py — смена server_url в config.json.

Запуск:
    python set_url.py
"""

from __future__ import annotations

import json
import os

CONFIG_PATH  = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
EXAMPLE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.example.json")
DIVIDER      = "─" * 52


def _load() -> dict:
    for p in (CONFIG_PATH, EXAMPLE_PATH):
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                return json.load(f)
    return {}


def _save(cfg: dict) -> None:
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def main() -> None:
    print()
    print(DIVIDER)
    print("  🔗 Изменить server URL")
    print(DIVIDER)
    print()

    cfg = _load()
    current = cfg.get("server_url", "")

    if current and "ТВОЙ_ДОМЕН" not in current:
        print(f"  Текущий URL: {current}")
    else:
        print("  URL не задан.")
    print()
    print("  Открой Replit → скопируй ссылку вида:")
    print("  https://xxxxx.replit.dev/api/python/scan")
    print()

    new_url = input("  Вставь новый URL (Enter = отмена): ").strip()

    if not new_url:
        print("  — Отменено, URL не изменён.")
        return

    cfg["server_url"] = new_url
    _save(cfg)

    print()
    print(DIVIDER)
    print(f"  ✅ URL сохранён: {new_url}")
    print(DIVIDER)
    print()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nОтменено.")
