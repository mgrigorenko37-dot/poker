"""
run.py — единый лаунчер Poker Scanner.

Запуск:
    python run.py
"""

import os
import subprocess
import sys

MENU = [
    ("⚡  Авто-режим (запустить всё само)",   "auto.py"),
    ("🚀  Запустить сканер вручную",           "poker_scanner.py"),
    ("🎯  Калибровка (карты + деньги)",        "calibrate.py"),
    ("🃏  Собрать шаблоны карт",               "collect_templates.py"),
    ("📦  Загрузить пресет",                   "load_preset.py"),
    ("📱  Привязать Telegram",                  "link_telegram.py"),
    ("🔍  Отладка детектора стола",            "debug_detector.py"),
    ("📐  Выбрать область стола вручную",      "select_region.py"),
    ("🔗  Изменить server URL",                "set_url.py"),
]

DIVIDER = "─" * 42

def clear():
    os.system("cls" if os.name == "nt" else "clear")

def main():
    while True:
        clear()
        print(DIVIDER)
        print("   ♠ POKER SCANNER — главное меню")
        print(DIVIDER)
        for i, (label, _) in enumerate(MENU, 1):
            print(f"  [{i}]  {label}")
        print(f"  [0]  Выход")
        print(DIVIDER)

        choice = input("  Введи номер: ").strip()

        if choice == "0":
            print("  Пока!")
            sys.exit(0)

        if not choice.isdigit() or not (1 <= int(choice) <= len(MENU)):
            input("  ⚠️  Неверный номер. Нажми Enter...")
            continue

        idx = int(choice) - 1
        label, script = MENU[idx]
        script_path = os.path.join(os.path.dirname(__file__), script)

        print(f"\n  → Запускаю: {script}\n{DIVIDER}\n")
        try:
            subprocess.run([sys.executable, script_path], check=False)
        except KeyboardInterrupt:
            pass

        print(f"\n{DIVIDER}")
        input("  Нажми Enter чтобы вернуться в меню...")

if __name__ == "__main__":
    main()
