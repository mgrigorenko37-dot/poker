#!/usr/bin/env python3
"""
cfr_server.py — Этап 3: постоянно живущий HTTP-сервер (stdlib only).
Слушает на CFR_PORT (дефолт 8765), принимает POST /solve, возвращает JSON.
Нет внешних зависимостей — только stdlib + numpy (уже установлен через uv).

Сигнал готовности: печатает "CFR_SERVER_READY port=<PORT>" в stdout —
Node.js (cfr-process.ts) ждёт эту строку перед отправкой запросов.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer

# Добавляем папку со скриптами в sys.path, чтобы найти mc_equity и cfr_solver
_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _DIR)

# Импортируем после правки sys.path
from mc_equity import parse_card          # noqa: E402
from cfr_solver import solve_spot         # noqa: E402

PORT = int(os.environ.get("CFR_PORT", "8765"))


# ---------------------------------------------------------------------------
# HTTP Handler
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    """Минимальный JSON HTTP-сервер без внешних зависимостей."""

    def log_message(self, fmt: str, *args: object) -> None:
        # Подавляем стандартные access-логи — Node.js видит только нужные строки
        pass

    def _send_json(self, status: int, data: dict) -> None:
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ── GET /healthz ──────────────────────────────────────────────────────────
    def do_GET(self) -> None:
        if self.path == "/healthz":
            self._send_json(200, {"ok": True})
        else:
            self._send_json(404, {"error": "not found"})

    # ── POST /solve ───────────────────────────────────────────────────────────
    def do_POST(self) -> None:
        if self.path != "/solve":
            self._send_json(404, {"error": "not found"})
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            body: dict = json.loads(self.rfile.read(length))

            # ── Обязательное поле ─────────────────────────────────────────────
            raw_hole = body.get("holeCards", [])
            if not isinstance(raw_hole, list) or len(raw_hole) != 2:
                self._send_json(400, {"error": "holeCards must be array of 2 strings"})
                return

            hole_cards  = [parse_card(c) for c in raw_hole]
            board_cards = [parse_card(c) for c in body.get("boardCards", [])]

            pot              = float(body.get("pot", 100))
            stack            = float(body.get("stack", 300))
            villain_range    = body.get("villainRange") or None
            villain_profile  = body.get("villainProfile") or None
            hero_acts_first  = bool(body.get("heroActsFirst", True))
            mc_iter          = int(body.get("mcIterations", 200))
            cfr_iter         = int(body.get("cfrIterations", 150))

            result = solve_spot(
                hole_cards, board_cards,
                pot=pot,
                stack=stack,
                villain_range=villain_range,
                villain_profile=villain_profile,
                hero_acts_first=hero_acts_first,
                mc_iterations=mc_iter,
                cfr_iterations=cfr_iter,
            )
            self._send_json(200, result)

        except Exception as exc:
            self._send_json(500, {
                "error": str(exc),
                "trace": traceback.format_exc(),
            })


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    # Node.js ждёт эту строку в stdout перед отправкой первого запроса
    print(f"CFR_SERVER_READY port={PORT}", flush=True)
    server.serve_forever()
