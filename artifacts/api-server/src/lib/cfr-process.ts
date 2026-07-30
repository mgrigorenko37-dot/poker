/**
 * cfr-process.ts — менеджер Python CFR-сервера.
 *
 * Запускает cfr_server.py один раз при старте api-server, мониторит процесс
 * и перезапускает при падении (с экспоненциальной задержкой).
 *
 * Экспортирует:
 *   startCFRServer()   — вызвать из index.ts при старте
 *   isCFRReady()       — синхронная проверка готовности
 *   waitForCFR()       — Promise, который резолвится когда сервер готов
 *   getCFRPort()       — порт Python-сервера (для проксирования)
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { logger } from "./logger";

const CFR_PORT = 8765;
// __dirname задаётся баннером esbuild → указывает на artifacts/api-server/dist/
// Python-скрипты живут в ../src/lib/python/ относительно dist/
const PYTHON_SCRIPT = path.resolve(__dirname, "../src/lib/python/cfr_server.py");
const READY_SIGNAL  = `CFR_SERVER_READY port=${CFR_PORT}`;
const MAX_RETRIES   = 5;

let proc:          ChildProcess | null = null;
let ready          = false;
let retries        = 0;

// --- Promise-механизм готовности ------------------------------------------------

type ResolveVoid = () => void;
type RejectError = (e: Error) => void;

let readyPromise:   Promise<void>;
let resolveReady:   ResolveVoid;
let rejectReady:    RejectError;

function resetReadyPromise(): void {
  readyPromise = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady  = rej;
  });
}
resetReadyPromise();

// --- Public API -----------------------------------------------------------------

export function getCFRPort(): number   { return CFR_PORT; }
export function isCFRReady(): boolean  { return ready; }
export function waitForCFR(): Promise<void> { return readyPromise; }

// --- Process management ---------------------------------------------------------

function startProcess(): void {
  if (retries >= MAX_RETRIES) {
    const err = new Error(`CFR Python server failed after ${MAX_RETRIES} retries`);
    logger.error({ err }, "cfr-process: giving up");
    rejectReady(err);
    return;
  }

  const delay = retries === 0 ? 0 : Math.min(1000 * 2 ** (retries - 1), 30_000);
  retries++;

  setTimeout(() => {
    logger.info({ script: PYTHON_SCRIPT, attempt: retries }, "cfr-process: spawning Python server");

    proc = spawn("python3", [PYTHON_SCRIPT], {
      env:   { ...process.env, CFR_PORT: String(CFR_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line.includes(READY_SIGNAL)) {
        ready   = true;
        retries = 0;           // сбросить счётчик после успешного старта
        logger.info({ port: CFR_PORT }, "cfr-process: Python CFR server ready");
        resolveReady();
      } else if (line) {
        logger.info({ msg: line }, "cfr-server");
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) logger.warn({ msg: line }, "cfr-server stderr");
    });

    proc.on("error", (err) => {
      logger.error({ err }, "cfr-process: spawn error");
    });

    proc.on("exit", (code, signal) => {
      ready = false;
      logger.warn({ code, signal, retriesLeft: MAX_RETRIES - retries },
        "cfr-process: Python server exited — scheduling restart");
      resetReadyPromise();
      startProcess();
    });
  }, delay);
}

export function startCFRServer(): void {
  startProcess();
}
