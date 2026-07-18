"""
cv2_unicode.py — замена cv2.imread/imwrite для путей с кириллицей и Unicode.

cv2.imread на Windows не поддерживает non-ASCII пути.
Используем np.fromfile + cv2.imdecode как обходной путь.
"""
import cv2
import numpy as np


def imread(path: str, flags: int = cv2.IMREAD_COLOR) -> "np.ndarray | None":
    """Читает изображение по любому пути (включая кириллицу на Windows)."""
    try:
        buf = np.fromfile(path, dtype=np.uint8)
        if buf.size == 0:
            return None
        img = cv2.imdecode(buf, flags)
        return img
    except Exception:
        return None


def imwrite(path: str, img: np.ndarray, params=None) -> bool:
    """Записывает изображение по любому пути (включая кириллицу на Windows)."""
    try:
        ext = "." + path.rsplit(".", 1)[-1].lower() if "." in path else ".png"
        ok, buf = cv2.imencode(ext, img, params or [])
        if not ok:
            return False
        buf.tofile(path)
        return True
    except Exception:
        return False
