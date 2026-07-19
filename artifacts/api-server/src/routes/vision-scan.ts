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

const VISION_PROMPT = `You are a poker card recognition system. Analyze this poker game screenshot.

HOLE CARDS: the 2 face-up cards belonging to the player — usually at the bottom center or bottom-right of the screen.
BOARD CARDS: community cards in the center of the table (flop/turn/river), 0 to 5 cards total.

Return ONLY valid JSON (no markdown, no explanation, no code fences):
{
  "holeCards": ["Xr","Yr"],
  "boardCards": [],
  "potSize": null,
  "betToCall": null,
  "activePlayers": null
}

Card format: rank letter + suit letter.
  Ranks: A K Q J T 9 8 7 6 5 4 3 2
  Suits: h (hearts ♥)  d (diamonds ♦)  c (clubs ♣)  s (spades ♠)
Examples: "Ah"=Ace♥  "Ks"=King♠  "Td"=Ten♦  "2c"=Two♣

Rules:
- holeCards must be exactly 2 cards, or null if face-down/not visible
- boardCards: list 3, 4, or 5 visible board cards (empty array [] if none)
- potSize: total chips/money shown in the pot area (number), null if not visible
- betToCall: the call/check amount shown near action buttons (number), null if not visible
- activePlayers: count of players still in the hand (number), null if uncertain`;

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
    const model = getGenAI().getGenerativeModel({ model: "gemini-3-flash-preview" });

    const geminiResult = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: image } },
            { text: VISION_PROMPT },
          ],
        },
      ],
    });

    // Strip any accidental markdown fences from the response
    const raw = geminiResult.response
      .text()
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();

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
