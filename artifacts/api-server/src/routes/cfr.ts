/**
 * POST /api/cfr/solve
 *
 * Проксирует запрос в постоянно живущий Python MCCFR-сервер (cfr_server.py).
 * Принимает карты строками ("Ah", "Kd"), возвращает action + frequencies + EV.
 *
 * Body:
 * {
 *   holeCards:       ["Ah", "Kd"],           // обязательно — 2 карты
 *   boardCards:      ["2c", "7h", "Qd"],     // опционально — 0/3/4/5 карт
 *   pot:             100,                     // банк в $
 *   stack:           300,                     // эффективный стек в $
 *   villainRange:    ["AA","KK","AKs"],       // опционально
 *   villainProfile:  { vpip, pfr, af, fold_to_cbet, cbet },  // опционально
 *   heroActsFirst:   true,                   // OOP = true (ходит первым)
 *   mcIterations:    200,
 *   cfrIterations:   150,
 * }
 *
 * Response:
 * {
 *   action:      "bet75",                    // рекомендуемое действие
 *   frequencies: { check: 0.27, bet75: 0.73 },
 *   ev:          12.4,
 *   equity:      0.681,
 *   mc_equity:   68.1,
 *   elapsed_ms:  145,
 *   used_range:  true,
 *   villain_range_pct: 38.2,
 * }
 */

import { Router, type IRouter } from "express";
import http from "node:http";
import { isCFRReady, waitForCFR, getCFRPort } from "../lib/cfr-process";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const PROXY_TIMEOUT_MS = 15_000;  // 15с — с запасом на CFR 150 итераций

/** Синхронный HTTP-запрос к Python CFR-серверу. */
function proxyToPython(body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port:     getCFRPort(),
        path:     "/solve",
        method:   "POST",
        headers:  {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: PROXY_TIMEOUT_MS,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`CFR server returned invalid JSON: ${data.slice(0, 200)}`));
          }
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`CFR server request timed out after ${PROXY_TIMEOUT_MS}ms`));
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── POST /api/cfr/solve ────────────────────────────────────────────────────────

router.post("/cfr/solve", async (req, res) => {
  const { holeCards } = req.body ?? {};

  if (!Array.isArray(holeCards) || holeCards.length !== 2) {
    res.status(400).json({ error: "holeCards must be array of 2 strings" });
    return;
  }

  // Если Python-сервер ещё не поднялся — ждём до 10 секунд
  if (!isCFRReady()) {
    logger.info("cfr/solve: Python server not ready, waiting up to 10s");
    try {
      await Promise.race([
        waitForCFR(),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("CFR server startup timeout (10s)")), 10_000),
        ),
      ]);
    } catch (e: any) {
      res.status(503).json({ error: `CFR server unavailable: ${e.message}` });
      return;
    }
  }

  try {
    const result = await proxyToPython(req.body);
    res.json(result);
  } catch (e: any) {
    logger.error({ err: e }, "cfr/solve: Python proxy failed");
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/cfr/status ────────────────────────────────────────────────────────
// Фронтенд может проверить готовность Python-сервера перед первым запросом.

router.get("/cfr/status", (_req, res) => {
  res.json({ ready: isCFRReady(), port: getCFRPort() });
});

export default router;
