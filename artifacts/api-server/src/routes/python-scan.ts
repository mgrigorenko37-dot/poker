/**
 * POST /api/python/scan
 *
 * Entry point for the local Python companion script (OpenCV + PaddleOCR).
 * The script sends a raw JSON payload with the cards/amounts it detected;
 * this route runs the full GTO analysis server-side and then:
 *   1. Broadcasts the result to all connected WebSocket clients (phones)
 *   2. Sends it to Telegram (with dedup — only when the decision changes)
 *
 * Input format (all fields except holeCards are optional):
 * {
 *   holeCards:  ["Ah", "Kd"],          // required — 2 cards
 *   boardCards: ["2c", "7h", "Qd"],    // optional — 0/3/4/5 cards
 *   potSize:    12.5,                  // optional — dollars/chips
 *   betToCall:  3.0,                   // optional — 0 = check
 *   players:    4,                     // optional — active players at table
 *   position:   "BTN"                 // optional — UTG/MP/HJ/CO/BTN/SB/BB
 * }
 */

import { Router, type IRouter } from "express";
import { broadcastAnalysis } from "../lib/live-analysis";
import { isTelegramConfigured, sendTelegramMessage } from "../lib/telegram";
import { logger } from "../lib/logger";
import { parseCard, runMonteCarloSim } from "../lib/poker";
import { getFullAdvice } from "../lib/poker-gto";

const router: IRouter = Router();

// Dedup — same logic as analysis.ts: only Telegram when decision changes
let lastSentKey: string | null = null;

const suitSym: Record<string, string> = { h: "♥", d: "♦", c: "♣", s: "♠" };
function fmtCard(c: string): string {
  const rank = c.slice(0, -1);
  const suit = c.slice(-1);
  return `${rank === "T" ? "10" : rank}${suitSym[suit] ?? suit}`;
}

function buildTelegramText(body: ReturnType<typeof buildResult>): string {
  const hole = body.holeCards.map(fmtCard).join(" ");
  const board = body.boardCards.length ? body.boardCards.map(fmtCard).join(" ") : "префлоп";
  const lines = [
    `<b>${body.displayText}</b>${body.sizing ? ` (${body.sizing})` : ""}`,
    `Карты: ${hole} | Борд: ${board}`,
    `Win: ${Math.round(body.equity * 100)}%${body.potOdds != null ? ` · Пот-оддс: ${Math.round(body.potOdds * 100)}%` : ""}`,
  ];
  if (body.bluffRead?.label) lines.push(`Read виллана: ${body.bluffRead.label}`);
  if (body.details.length) lines.push("", ...body.details.slice(0, 4).map((d) => `▸ ${d}`));
  return lines.join("\n");
}

function buildResult(raw: {
  holeCards: string[];
  boardCards: string[];
  potSize: number;
  betToCall: number;
  players: number;
  position: string;
}) {
  const hole = raw.holeCards.map(parseCard);
  const board = raw.boardCards.map(parseCard);

  // Monte Carlo equity — 1 200 iterations is enough at this table speed
  const sim = runMonteCarloSim(hole, board, raw.players, 1200);

  const advice = getFullAdvice(
    hole,
    board,
    raw.potSize,
    raw.betToCall,
    raw.players,
    raw.position,
    sim,
  );

  return {
    // mirror LiveAnalysis shape so broadcastAnalysis/Telegram work unchanged
    holeCards: raw.holeCards,
    boardCards: raw.boardCards,
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
    potSize: raw.potSize,
    betToCall: raw.betToCall,
    players: raw.players,
    position: raw.position,
    usedRangeVsRange: sim.usedRangeVsRange,
    villainRangePct: sim.villainRangePct,
    ts: Date.now(),
  };
}

router.post("/python/scan", (req, res) => {
  const body = req.body;

  // ── Validate ────────────────────────────────────────────────────────────────
  if (!Array.isArray(body?.holeCards) || body.holeCards.length !== 2) {
    res.status(400).json({ error: "holeCards must be an array of exactly 2 card strings, e.g. [\"Ah\",\"Kd\"]" });
    return;
  }

  // Normalise optional fields
  const raw = {
    holeCards:  body.holeCards  as string[],
    boardCards: Array.isArray(body.boardCards) ? (body.boardCards as string[]) : [],
    potSize:    typeof body.potSize   === "number" ? body.potSize   : 0,
    betToCall:  typeof body.betToCall === "number" ? body.betToCall : 0,
    players:    typeof body.players   === "number" ? Math.max(2, Math.min(9, body.players)) : 2,
    position:   typeof body.position  === "string" ? body.position  : "BTN",
  };

  try {
    const result = buildResult(raw);

    // Broadcast to phone WebSocket clients
    broadcastAnalysis(result as any);

    // Telegram — only when decision changes
    if (isTelegramConfigured()) {
      const key = JSON.stringify({ hole: raw.holeCards, board: raw.boardCards, action: result.displayText });
      if (key !== lastSentKey) {
        lastSentKey = key;
        sendTelegramMessage(buildTelegramText(result)).catch((err) =>
          logger.error({ err }, "python/scan: Telegram send failed"),
        );
      }
    }

    logger.info(
      { action: result.displayText, equity: Math.round(result.equity * 100), hole: raw.holeCards, board: raw.boardCards },
      "python/scan: analysis complete",
    );

    res.json({ ok: true, action: result.displayText, equity: result.equity, details: result.details });
  } catch (err: any) {
    logger.error({ err }, "python/scan: GTO engine error");
    res.status(500).json({ error: err?.message ?? "GTO analysis failed" });
  }
});

export default router;
