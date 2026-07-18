"""
link_telegram.py — привязка Telegram одной командой.

Запуск:
    python link_telegram.py

Что делает:
  1. Читает server_url из config.json
  2. Просит тебя написать /start боту в Telegram
  3. Вызывает /api/telegram/link на сервере — тот сам находит твой chat_id
  4. Отправляет тестовое сообщение чтобы убедиться что всё работает
"""

import json
import os
import sys
import time
import requests

CONFIG_PATH = os.path.join(os.path.dirname(__file__), "config.json")


def load_server_url() -> str:
    if not os.path.exists(CONFIG_PATH):
        print("❌ config.json не найден.")
        print("   Создай его: скопируй config.example.json → config.json")
        print("   и укажи server_url (адрес твоего Replit-проекта).")
        sys.exit(1)
    with open(CONFIG_PATH, encoding="utf-8") as f:
        cfg = json.load(f)
    url = cfg.get("server_url", "")
    if not url or "ТВОЙ_ДОМЕН" in url:
        print("❌ server_url не задан в config.json.")
        print('   Пример: "server_url": "https://poker-advisor.ИМЯ.replit.app/api/python/scan"')
        sys.exit(1)
    # Извлекаем базовый URL (убираем /api/python/scan)
    base = url.split("/api/")[0]
    return base


def link(base_url: str) -> dict | None:
    endpoint = f"{base_url}/api/telegram/link"
    try:
        r = requests.post(endpoint, timeout=15)
        if r.status_code == 200:
            return r.json()
        print(f"❌ Сервер вернул {r.status_code}: {r.text[:200]}")
        return None
    except requests.exceptions.ConnectionError:
        print(f"❌ Не могу подключиться к серверу: {base_url}")
        print("   Убедись что Replit-проект запущен (вкладка Deployments или Run).")
        return None
    except Exception as e:
        print(f"❌ Ошибка: {e}")
        return None


def send_test(base_url: str) -> bool:
    endpoint = f"{base_url}/api/telegram/test"
    try:
        r = requests.post(endpoint, timeout=10)
        return r.status_code == 200
    except Exception:
        return False


def main():
    print("=" * 50)
    print("  Привязка Telegram к Poker Advisor")
    print("=" * 50)

    base_url = load_server_url()
    print(f"\n🌐 Сервер: {base_url}\n")

    # Шаг 1 — инструкция пользователю
    print("Шаг 1. Найди своего Telegram-бота.")
    print("       (имя бота ты задал когда создавал его через @BotFather)")
    print()
    print("Шаг 2. Напиши боту: /start")
    print("       Это нужно чтобы сервер смог найти твой аккаунт.")
    print()
    input("✅ Написал /start? Нажми Enter чтобы продолжить...")

    # Шаг 2 — линковка
    print("\n⏳ Привязываю аккаунт...")

    result = None
    for attempt in range(3):
        result = link(base_url)
        if result and result.get("ok"):
            break
        if attempt < 2:
            print(f"   Попытка {attempt + 1}/3 не удалась, пробую снова через 3 сек...")
            time.sleep(3)

    if not result or not result.get("ok"):
        print("\n❌ Не удалось привязать аккаунт.")
        print("   Проверь:")
        print("   1. Ты точно написал боту /start?")
        print("   2. Replit-сервер запущен?")
        print("   3. TELEGRAM_BOT_TOKEN задан в Secrets на Replit?")
        sys.exit(1)

    # Успех
    username = result.get("username", "")
    chat_id  = result.get("chatId", "?")
    name_str = f" (@{username})" if username else ""
    print(f"\n✅ Аккаунт привязан!{name_str}  chat_id={chat_id}")

    # Тест
    print("\n📨 Отправляю тестовое сообщение...")
    ok = send_test(base_url)
    if ok:
        print("✅ Тестовое сообщение отправлено — проверь Telegram!")
    else:
        print("⚠️  Тест не прошёл — но привязка сохранена.")
        print("   Советы всё равно будут приходить во время игры.")

    print()
    print("Готово! Запускай сканер:")
    print("   python poker_scanner.py")
    print()


if __name__ == "__main__":
    main()
