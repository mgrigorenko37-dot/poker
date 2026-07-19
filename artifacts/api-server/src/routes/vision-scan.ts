/**
 * POST /api/vision/scan
 *
 * Fast path:
 *   1. Start Gemini stream
 *   2. When hole cards appear in the stream (~300 ms) → run quick Monte Carlo,
 *      fire Telegram immediately (fire-and-forget)
 *   3. Finish streaming, parse full JSON (pot/bet), re-run GTO
 *   4. Send updated Telegram only if action changed
 *   5. Return full analysis to browser
 *
 * This gets Telegram ~600 ms earlier than waiting for the full response.
 */

import { Router, type IRouter } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { broadcastAnalysis } from "../lib/live-analysis";
import { isTelegramConfigured, sendTelegramMessage } from "../lib/telegram";
import { buildTelegramText } from "../lib/telegram-format";
import { logger } from "../lib/logger";
import { parseCard, runMonteCarloSim } from "../lib/poker";
import { getFullAdvice } from "../lib/poker-gto";

const router: IRouter = Router();

// ── Dedup ─────────────────────────────────────────────────────────────────────
// Key = hole+board+action  →  prevents duplicate Telegram for same hand state
let lastSentKey: string | null = null;

// ── Gemini client (lazy-init, reused) ─────────────────────────────────────────
let genAI: GoogleGenerativeAI | null = null;
function getGenAI(): GoogleGenerativeAI {
  if (!genAI) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is not set");
    genAI = new GoogleGenerativeAI(key);
  }
  return genAI;
}

// Ultra-short prompt — fewer tokens = faster TTFT (time-to-first-token)
const VISION_PROMPT =
  `Poker screenshot. Return ONLY raw JSON (no markdown):
{"holeCards":["Xr","Yr"],"boardCards":[],"potSize":null,"betToCall":null,"activePlayers":null}
holeCards=player 2 cards at bottom (null if hidden). boardCards=center 0-5.
Ranks: A K Q J T 9-2. Suits: h d c s. E.g. "Ah","Ks","Td","2c".`;

// Models to try in order (fastest first)
const MODELS = ["gemini-3.1-flash-lite", "gemini-3-flash-preview"];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract {"holeCards":["Xr","Yr"]} before stream is complete */
function extractEarlyHole(text: string): [string, string] | null {
  const m = text.match(/"holeCards"\s*:\s*\[\s*"([^"]{2})"\s*,\s*"([^"]{2})"\s*\]/);
  return m ? [m[1], m[2]] : null;
}

function makeSendKey(hole: string[], board: string[], action: string) {
  return JSON.stringify({ hole, board, action });
}

function safeTelegram(payload: any, key: string): boolean {
  if (!isTelegramConfigured()) return false;
  if (key === lastSentKey) return false;
  lastSentKey = key;
  sendTelegramMessage(buildTelegramText(payload)).catch((err) =>
    logger.error({ err }, "vision/scan: Telegram send failed"),
  );
  return true;
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.post("/vision/scan", async (req, res) => {
  const {
    image,
    position = "BTN",
    players = 4,
    potSizeOverride,
    betToCallOverride,
  } = req.body;

  if (!image || typeof image !== "string") {
    res.status(400).json({ error: "image (base64 JPEG string) is required" });
    return;
  }

  // Track whether we already fired Telegram early (cards-only)
  let earlyTelegramFired = false;
  let earlyHoleStrings: string[] | null = null;

  const contents = [
    {
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/jpeg", data: image } },
        { text: VISION_PROMPT },
      ],
    },
  ];

  let accumulated = "";
  let parsed: any = null;

  // Try models with fallback
  for (let attempt = 0; attempt < MODELS.length; attempt++) {
    const modelName = MODELS[attempt];

    // 4-second hard timeout per attempt
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    accumulated = "";
    parsed = null;

    try {
      const model = getGenAI().getGenerativeModel({ model: modelName });
      const stream = await model.generateContentStream(
        { contents },
        { signal: controller.signal } as any,
      );

      // ── Stream loop ────────────────────────────────────────────────────────
      for await (const chunk of stream.stream) {
        accumulated += chunk.text();

        const clean = accumulated
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/```\s*$/, "")
          .trim();

        // ── Early card extraction ──────────────────────────────────────────
        // Fire Telegram the moment hole cards appear in the stream
        // (~200-400 ms before full JSON is ready)
        if (!earlyTelegramFired && !earlyHoleStrings) {
          const early = extractEarlyHole(clean);
          if (early) {
            earlyHoleStrings = early;
            try {
              const hole = early.map(parseCard);
              const quickSim = runMonteCarloSim(hole, [], Math.max(2, Math.min(9, players)), 400);
              const quickAdvice = getFullAdvice(hole, [], 0, 0, players, position, quickSim, 1.0, "");
              const earlyKey = makeSendKey(early, [], quickAdvice.displayText);

              if (safeTelegram(
                {
                  holeCards: early, boardCards: [], action: quickAdvice.action,
                  displayText: quickAdvice.displayText, color: quickAdvice.color,
                  details: quickAdvice.details, equity: quickAdvice.equity,
                  potOdds: null, mdf: null,
                  handCategory: quickAdvice.handCategory, handName: quickAdvice.handName,
                  draws: null, bluffRead: null,
                  potSize: 0, betToCall: 0, players,
                  position, usedRangeVsRange: quickSim.usedRangeVsRange,
                  villainRangePct: quickSim.villainRangePct, ts: Date.now(),
                },
                earlyKey,
              )) {
                earlyTelegramFired = true;
                logger.info({ hole: early }, "vision/scan: early Telegram fired");
              }
            } catch { /* ignore parse errors in early extraction */ }
          }
        }

        // ── Try full JSON parse ────────────────────────────────────────────
        try {
          parsed = JSON.parse(clean);
          break; // complete JSON received — exit stream loop early
        } catch { /* keep accumulating */ }
      }

      clearTimeout(timer);
      break; // success — don't try next model
    } catch (err: any) {
      clearTimeout(timer);
      const status = err?.status ?? 0;
      const isRetryable = status === 503 || status === 429 || err?.name === "AbortError";
      if (isRetryable && attempt < MODELS.length - 1) {
        logger.warn({ model: modelName, status }, "vision/scan: retrying with fallback model");
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      throw err;
    }
  }

  // Final JSON parse if loop didn't succeed (accumulated rest of stream)
  if (!parsed) {
    const clean = accumulated
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
    try {
      parsed = JSON.parse(clean);
    } catch {
      logger.warn({ raw: accumulated.slice(0, 200) }, "vision/scan: non-JSON from Gemini");
      res.status(422).json({ ok: false, error: "Model returned non-JSON", raw: accumulated.slice(0, 200) });
      return;
    }
  }

  // ── Extract fields ─────────────────────────────────────────────────────────
  const holeStrings: string[] =
    Array.isArray(parsed.holeCards) && parsed.holeCards.length === 2
      ? (parsed.holeCards as string[])
      : [];

  const boardStrings: string[] = Array.isArray(parsed.boardCards)
    ? (parsed.boardCards as string[])
    : [];

  const detectedPot: number | null =
    typeof parsed.potSize === "number" ? parsed.potSize : null;
  const detectedBet: number | null =
    typeof parsed.betToCall === "number" ? parsed.betToCall : null;
  const detectedPlayers: number | null =
    typeof parsed.activePlayers === "number" ? parsed.activePlayers : null;

  if (holeStrings.length !== 2) {
    res.json({ ok: false, error: "Hole cards not detected in image", detected: parsed });
    return;
  }

  // ── Parse cards ────────────────────────────────────────────────────────────
  let hole;
  try {
    hole = holeStrings.map(parseCard);
  } catch (e: any) {
    res.json({ ok: false, error: `Invalid hole card format: ${e.message}`, holeStrings });
    return;
  }

  const validBoardStrings: string[] = [];
  const board: ReturnType<typeof parseCard>[] = [];
  for (const s of boardStrings) {
    try { board.push(parseCard(s)); validBoardStrings.push(s); } catch { /* skip */ }
  }

  // ── Final GTO analysis ─────────────────────────────────────────────────────
  const finalPot     = potSizeOverride ?? detectedPot ?? 0;
  const finalBet     = betToCallOverride ?? detectedBet ?? 0;
  const finalPlayers = Math.max(2, Math.min(9, detectedPlayers ?? players));

  const sim    = runMonteCarloSim(hole, board, finalPlayers, 1200);
  const advice = getFullAdvice(hole, board, finalPot, finalBet, finalPlayers, position, sim, 1.0, "");

  const output = {
    holeCards: holeStrings,
    boardCards: validBoardStrings,
    action: advice.action,
    displayText: advice.displayText,
    color: advice.color,
    details: advice.details,
    equity: advice.equity,
    potOdds: advice.potOdds,
    mdf: advice.mdf,
    handCategory: advice.handCategory,
    handName: advice.handName,
    draws: advice.draws,
    sizing: advice.sizing,
    ev: advice.ev,
    bluffRead: advice.bluffRead,
    potSize: finalPot,
    betToCall: finalBet,
    players: finalPlayers,
    position,
    usedRangeVsRange: sim.usedRangeVsRange,
    villainRangePct: sim.villainRangePct,
    ts: Date.now(),
  };

  // ── Broadcast to WebSocket ─────────────────────────────────────────────────
  broadcastAnalysis(output as any);

  // ── Telegram (full analysis — only if action changed since early fire) ─────
  const finalKey = makeSendKey(holeStrings, validBoardStrings, advice.displayText);
  safeTelegram(output, finalKey);

  logger.info(
    { action: advice.displayText, equity: Math.round(advice.equity * 100), hole: holeStrings, board: validBoardStrings, earlyFired: earlyTelegramFired },
    "vision/scan: analysis complete",
  );

  res.json({ ok: true, ...output });
});

export default router;
