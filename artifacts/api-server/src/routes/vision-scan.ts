/**
 * POST /api/vision/scan
 *
 * Accepts a base64-encoded JPEG crop of the poker table, sends it to
 * Gemini Flash vision, parses the detected cards/amounts, runs GTO analysis,
 * broadcasts to WebSocket clients, and pushes a Telegram notification.
 *
 * Body:
 * {
 *   image:            string   — base64 JPEG (table crop, no data: prefix)
 *   position?:        string   — UTG/MP/HJ/CO/BTN/SB/BB (default "BTN")
 *   players?:         number   — active players hint (default 4)
 *   potSizeOverride?: number   — manual pot override (skips OCR value)
 *   betToCallOverride?:number  — manual call override
 * }
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

let lastSentKey: string | null = null;

// Lazy-init — reuse across requests
let genAI: GoogleGenerativeAI | null = null;
function getGenAI(): GoogleGenerativeAI {
  if (!genAI) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is not set");
    genAI = new GoogleGenerativeAI(key);
  }
  return genAI;
}

// Short prompt = fewer input tokens = faster response
const VISION_PROMPT = `Poker screenshot. Return ONLY JSON, no markdown:
{"holeCards":["Xr","Yr"],"boardCards":[],"potSize":null,"betToCall":null,"activePlayers":null}
holeCards=player's 2 face-up cards at bottom of screen (null if hidden).
boardCards=community cards in center (0-5 cards, empty array if none).
Card format: rank(A K Q J T 9-2)+suit(h d c s). Examples: "Ah","Ks","Td","2c".
potSize=chips in pot (number or null). betToCall=call amount (number or null).`;

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

  try {
    // Try fast model first, fall back to preview on 503
    const MODELS = ["gemini-3.1-flash-lite", "gemini-3-flash-preview"];
    let raw = "";

    for (let attempt = 0; attempt < MODELS.length; attempt++) {
      const modelName = MODELS[attempt];
      const model = getGenAI().getGenerativeModel({ model: modelName });

      // Hard 8-second timeout — drop slow responses rather than let them pile up
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);

      try {
        const geminiResult = await model.generateContent(
          {
            contents: [
              {
                role: "user",
                parts: [
                  { inlineData: { mimeType: "image/jpeg", data: image } },
                  { text: VISION_PROMPT },
                ],
              },
            ],
          },
          { signal: controller.signal } as any,
        );
        clearTimeout(timer);
        raw = geminiResult.response
          .text()
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/```\s*$/, "")
          .trim();
        break; // success
      } catch (err: any) {
        clearTimeout(timer);
        const status = err?.status ?? 0;
        const isRetryable = status === 503 || status === 429 || err?.name === "AbortError";
        if (isRetryable && attempt < MODELS.length - 1) {
          logger.warn({ model: modelName, status, attempt }, "vision/scan: retrying with fallback model");
          await new Promise(r => setTimeout(r, 300));
          continue;
        }
        throw err;
      }
    }

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn({ raw }, "vision/scan: Gemini returned non-JSON");
      res.status(422).json({ ok: false, error: "Model returned non-JSON", raw });
      return;
    }

    // ── Extract & validate ─────────────────────────────────────────────────
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
      res.json({
        ok: false,
        error: "Hole cards not detected in image",
        detected: parsed,
      });
      return;
    }

    // ── Parse cards ────────────────────────────────────────────────────────
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
      try {
        board.push(parseCard(s));
        validBoardStrings.push(s);
      } catch { /* skip unreadable board card */ }
    }

    // ── Resolve final values (manual override wins over OCR) ───────────────
    const finalPot = potSizeOverride ?? detectedPot ?? 0;
    const finalBet = betToCallOverride ?? detectedBet ?? 0;
    const finalPlayers = Math.max(2, Math.min(9, detectedPlayers ?? players));

    // ── GTO analysis ───────────────────────────────────────────────────────
    const sim = runMonteCarloSim(hole, board, finalPlayers, 1200);
    const advice = getFullAdvice(
      hole,
      board,
      finalPot,
      finalBet,
      finalPlayers,
      position,
      sim,
      1.0,
      "",
    );

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

    // ── Broadcast to phone WebSocket ───────────────────────────────────────
    broadcastAnalysis(output as any);

    // ── Telegram (dedup: only when decision changes) ───────────────────────
    if (isTelegramConfigured()) {
      const key = JSON.stringify({
        hole: holeStrings,
        board: boardStrings,
        action: advice.displayText,
      });
      if (key !== lastSentKey) {
        lastSentKey = key;
        sendTelegramMessage(buildTelegramText(output as any)).catch((err) =>
          logger.error({ err }, "vision/scan: Telegram send failed"),
        );
      }
    }

    logger.info(
      {
        action: advice.displayText,
        equity: Math.round(advice.equity * 100),
        hole: holeStrings,
        board: boardStrings,
      },
      "vision/scan: analysis complete",
    );

    res.json({ ok: true, ...output });
  } catch (err: any) {
    logger.error({ err }, "vision/scan: error");
    res.status(500).json({ error: err?.message ?? "Vision scan failed" });
  }
});

export default router;
