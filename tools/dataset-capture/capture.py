"""
GoP3 Dataset Capture Tool
=========================
Делает скриншоты окна игры каждые N секунд и сохраняет в папку dataset/.

Установка:
    pip install mss pillow keyboard pygetwindow

Запуск:
    python capture.py

Горячие клавиши во время захвата:
    SPACE  — пауза / продолжить
    +/-    — изменить интервал на 0.5 сек
    S      — сохранить кадр прямо сейчас (вне расписания)
    Q      — выйти

Аргументы (опционально):
    python capture.py --interval 2.0 --out my_dataset --region
"""

import argparse
import os
import sys
import time
import threading
from datetime import datetime
from pathlib import Path

try:
    import mss
    import mss.tools
    from PIL import Image
    import keyboard
except ImportError:
    print("Устанавливаю зависимости...")
    os.system(f"{sys.executable} -m pip install mss pillow keyboard pygetwindow -q")
    import mss
    import mss.tools
    from PIL import Image
    import keyboard


# ─── Выбор региона ────────────────────────────────────────────────────────────

def pick_window_region():
    """Пробует найти окно GoP3. Если не находит — предлагает выбрать вручную."""
    try:
        import pygetwindow as gw
        windows = gw.getAllTitles()
        candidates = [w for w in windows if any(
            kw in w.lower() for kw in ["governor", "poker", "gop", "bluestacks", "ldplayer", "memu"]
        )]
        if candidates:
            win = gw.getWindowsWithTitle(candidates[0])[0]
            print(f"✅ Найдено окно: «{candidates[0]}»")
            # Небольшой отступ чтобы не захватывать рамку
            return {
                "top":    win.top + 30,
                "left":   win.left + 4,
                "width":  win.width - 8,
                "height": win.height - 34,
            }
    except Exception:
        pass
    return None


def pick_region_interactive():
    """Просит ввести координаты вручную или использовать весь экран."""
    print("\nОкно игры не найдено автоматически.")
    print("Варианты:")
    print("  1) Весь экран")
    print("  2) Ввести координаты вручную (left top width height)")
    choice = input("Выбери [1/2]: ").strip()
    if choice == "2":
        raw = input("Введи: left top width height (например: 0 30 1280 720): ")
        try:
            l, t, w, h = map(int, raw.split())
            return {"top": t, "left": l, "width": w, "height": h}
        except Exception:
            print("Неверный формат, использую весь экран.")
    return None  # None = весь экран


# ─── Захват ───────────────────────────────────────────────────────────────────

class Capturer:
    def __init__(self, out_dir: Path, interval: float, region: dict | None):
        self.out_dir   = out_dir
        self.interval  = interval
        self.region    = region
        self.paused    = False
        self.running   = True
        self.count     = 0
        self.lock      = threading.Lock()
        out_dir.mkdir(parents=True, exist_ok=True)

    def _shot_path(self) -> Path:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]  # ms precision
        return self.out_dir / f"frame_{ts}.jpg"

    def snap(self) -> Path:
        with mss.mss() as sct:
            monitor = self.region or sct.monitors[0]
            raw = sct.grab(monitor)
            img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
            path = self._shot_path()
            img.save(path, "JPEG", quality=92)
        with self.lock:
            self.count += 1
        return path

    def run(self):
        print(f"\n📸 Захват запущен → {self.out_dir}")
        print(f"   Интервал: {self.interval}s  |  SPACE=пауза  +/-=интервал  S=кадр сейчас  Q=выйти\n")

        keyboard.add_hotkey("space",  self._toggle_pause)
        keyboard.add_hotkey("+",      self._faster)
        keyboard.add_hotkey("-",      self._slower)
        keyboard.add_hotkey("=",      self._faster)   # = без Shift на US-раскладке
        keyboard.add_hotkey("s",      self._snap_now)
        keyboard.add_hotkey("q",      self._quit)

        next_tick = time.monotonic()
        while self.running:
            now = time.monotonic()
            if now >= next_tick and not self.paused:
                try:
                    path = self.snap()
                    print(f"  [{self.count:>4}] {path.name}  (интервал {self.interval:.1f}s)", end="\r")
                except Exception as e:
                    print(f"\n⚠️  Ошибка захвата: {e}")
                next_tick = time.monotonic() + self.interval
            time.sleep(0.05)

        keyboard.unhook_all()
        print(f"\n\n✅ Готово. Сохранено кадров: {self.count}  →  {self.out_dir.resolve()}")

    # Hotkey handlers
    def _toggle_pause(self):
        self.paused = not self.paused
        state = "⏸  ПАУЗА" if self.paused else "▶  ПРОДОЛЖАЕМ"
        print(f"\n{state}                    ")

    def _faster(self):
        self.interval = max(0.5, round(self.interval - 0.5, 1))
        print(f"\n⚡ Интервал: {self.interval}s        ")

    def _slower(self):
        self.interval = min(10.0, round(self.interval + 0.5, 1))
        print(f"\n🐢 Интервал: {self.interval}s        ")

    def _snap_now(self):
        try:
            path = self.snap()
            print(f"\n📷 Ручной кадр: {path.name}        ")
        except Exception as e:
            print(f"\n⚠️  {e}")

    def _quit(self):
        self.running = False


# ─── Точка входа ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="GoP3 dataset capturer")
    parser.add_argument("--interval", type=float, default=2.0,
                        help="Секунд между кадрами (по умолч. 2.0)")
    parser.add_argument("--out", type=str, default="dataset",
                        help="Папка для кадров (по умолч. dataset/)")
    parser.add_argument("--region", action="store_true",
                        help="Выбрать регион интерактивно")
    args = parser.parse_args()

    out_dir = Path(args.out)

    # Определяем регион
    if args.region:
        region = pick_region_interactive()
    else:
        region = pick_window_region()
        if region is None:
            print("ℹ️  Окно GoP3 не найдено, захватываю весь экран.")
            print("   Запусти с --region чтобы задать область вручную.\n")

    capturer = Capturer(out_dir=out_dir, interval=args.interval, region=region)
    try:
        capturer.run()
    except KeyboardInterrupt:
        capturer.running = False
        print(f"\n\n✅ Прервано. Кадров: {capturer.count}  →  {out_dir.resolve()}")


if __name__ == "__main__":
    main()
