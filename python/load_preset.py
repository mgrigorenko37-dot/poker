"""
load_preset.py — загрузить готовый пресет координат в config.json.

Использование:
    python load_preset.py

Покажет список доступных пресетов, ты выбираешь нужный.
Координаты карт и банка копируются в config.json, остальные поля (server_url, position, players) сохраняются.
"""
import json
import os
import sys
import glob

CONFIG_PATH  = os.path.join(os.path.dirname(__file__), "config.json")
PRESETS_DIR  = os.path.join(os.path.dirname(__file__), "presets")

def load_config() -> dict:
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH) as f:
            return json.load(f)
    return {
        "server_url": "https://ТВОЙ_ДОМЕН.replit.dev/api/python/scan",
        "position": "BTN",
        "players": 6,
    }

def list_presets() -> list[str]:
    if not os.path.isdir(PRESETS_DIR):
        return []
    return sorted(glob.glob(os.path.join(PRESETS_DIR, "*.json")))

def main():
    presets = list_presets()
    if not presets:
        print("❌ Папка presets/ пуста.")
        sys.exit(1)

    print("\n=== Доступные пресеты ===\n")
    for i, p in enumerate(presets):
        with open(p) as f:
            data = json.load(f)
        name = data.get("_name", os.path.basename(p))
        print(f"  [{i+1}] {name}")

    print()
    choice = input("Введи номер пресета (или Enter для отмены): ").strip()
    if not choice:
        print("Отменено.")
        return

    try:
        idx = int(choice) - 1
        assert 0 <= idx < len(presets)
    except (ValueError, AssertionError):
        print("❌ Неверный выбор.")
        sys.exit(1)

    preset_path = presets[idx]
    with open(preset_path) as f:
        preset = json.load(f)

    cfg = load_config()

    # Копируем только координатные поля, не трогаем server_url и т.д.
    for key in ("regions", "money_regions", "card_height_pct"):
        if key in preset:
            cfg[key] = preset[key]

    # Убираем служебные ключи пресета
    for k in list(cfg.keys()):
        if k.startswith("_"):
            cfg.pop(k)

    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

    print(f"\n✅ Пресет загружен: {preset.get('_name', '')}")
    print(f"   {len(cfg.get('regions', []))} карточных регионов")
    print(f"   card_height_pct = {cfg.get('card_height_pct', '?')}")
    print(f"\n⚠️  Пресет даёт СТАРТОВЫЕ координаты.")
    print("   Запусти python calibrate.py чтобы точно подстроить под свой экран.")
    print("   Или сразу запускай python poker_scanner.py — если координаты совпали.")

if __name__ == "__main__":
    main()
