/**
 * POST /api/vision/scan-cards
 *
 * Accepts pre-parsed card strings from the browser YOLO detector (ScreenScan).
 * Runs full GTO analysis, broadcasts over WebSocket, fires Telegram on real game events.
 *
 * POST /api/vision/reset
 * Resets the hand state machine (called when ScreenScan session starts/stops).
 */

import { Router, type IRouter } from "express";
import { broadcastAnalysis } from "../lib/live-analysis";
import { isTelegramConfigured, sendTelegramMessage } from "../lib/telegram";
import { buildTelegramText } from "../lib/telegram-format";
import { logger } from "../lib/logger";
import { parseCard, runMonteCarloSim } from "../lib/poker";
import { getFullAdvice } from "../lib/poker-gto";
import { updateHandState, resetHandState, getHandHistory, isValidBoardCount, type TelegramTrigger } from "../lib/hand-state";
import { narrowVillainRange } from "../lib/range-narrower";
import { getOpponentSummary } from "../lib/opponent-profile";
import { getSPRAdvice } from "../lib/spr-advice";
import { getBoardTexture } from "../lib/board-texture";

const router: IRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Send Telegram if configured, tagged with the trigger reason for logging.
 * Fire-and-forget — never blocks the HTTP response.
 */
function fireTelegram(payload: Parameters<typeof buildTelegramText>[0], trigger: TelegramTrigger): void {
  if (!isTelegramConfigured()) return;
  const text = buildTelegramText(payload);
  sendTelegramMessage(text).catch((err) =>
    logger.error({ err }, "vision/scan: Telegram send failed"),
  );
  logger.info({ reason: trigger.reason }, "vision/scan: Telegram fired");
}

// ── /api/vision/scan-cards ────────────────────────────────────────────────────
// Card data supplied by the browser YOLO detector — no AI call needed.
// Runs the full GTO pipeline on pre-parsed card strings.
router.post("/vision/scan-cards", (req, res) => {
  const {
    holeCards,
    boardCards = [],
    potSize: clientPot,
    betToCall: clientBet,
    players = 4,
    position = "BTN",
    lastAction = null,
    minConfidence = 1.0,   // minimum YOLO detection confidence across all detected cards
  } = req.body;

  // ── Confidence gate ───────────────────────────────────────────────────────
  // Below this threshold the model is too unsure — run analysis for the UI but
  // suppress Telegram so shaky detections (rank confusion, partial occlusion)
  // don't produce noisy push notifications.
  const TELEGRAM_MIN_CONF = 0.40;

  if (!Array.isArray(holeCards) || holeCards.length !== 2) {
    res.status(400).json({ ok: false, error: "holeCards must be array of 2 strings" });
    return;
  }

  const holeStrings = holeCards as string[];
  const boardStrings = (boardCards as string[]);

  // ── Board count validation ────────────────────────────────────────────────
  // Texas Hold'em only ever has 0 (preflop), 3 (flop), 4 (turn), or 5 (river)
  // community cards. A count of 1 or 2 means YOLO caught the animation mid-deal
  // and the detection is unreliable — reject silently to avoid firing Telegram
  // with wrong board state.
  if (!isValidBoardCount(boardStrings.length)) {
    logger.warn({ boardCount: boardStrings.length }, "scan-cards: invalid board count, ignoring");
    res.json({ ok: false, error: `invalid board count ${boardStrings.length} (expected 0,3,4,5)` });
    return;
  }

  // ── Hole ∩ board duplicate check ─────────────────────────────────────────
  // A card cannot appear in both hero's hand and the community cards.
  // If YOLO assigned the same card to both zones the detection is corrupt.
  const holeLower  = new Set(holeStrings.map(s => s.toLowerCase()));
  const boardLower = boardStrings.map(s => s.toLowerCase());
  const hasDup     = boardLower.some(s => holeLower.has(s));
  if (hasDup) {
    logger.warn({ holeStrings, boardStrings }, "scan-cards: duplicate card in hole+board, ignoring");
    res.json({ ok: false, error: "duplicate card in hole and board" });
    return;
  }

  let hole;
  try {
    hole = holeStrings.map(parseCard);
  } catch (e: any) {
    res.json({ ok: false, error: `Invalid hole card: ${e.message}` });
    return;
  }

  const validBoardStrings: string[] = [];
  const board: ReturnType<typeof parseCard>[] = [];
  for (const s of boardStrings) {
    try { board.push(parseCard(s)); validBoardStrings.push(s); } catch { /* skip */ }
  }

  const finalPot     = clientPot  ?? 0;
  const finalBet     = clientBet  ?? 0;
  const finalPlayers = Math.max(2, Math.min(9, players));
  const isPreflop    = board.length === 0;

  const sprAdvice    = getSPRAdvice(null, finalPot, null, isPreflop);
  const betSizePct   = finalPot > 0 && finalBet > 0 ? Math.round((finalBet / finalPot) * 100) : null;
  const boardTexture = !isPreflop ? getBoardTexture(board, hole, betSizePct) : null;
  const currentHistory = getHandHistory();
  const narrowed     = narrowVillainRange(currentHistory.actions, currentHistory.street);
  const sim          = runMonteCarloSim(hole, board, finalPlayers, 1200, narrowed.rangeKeys);
  const advice       = getFullAdvice(hole, board, finalPot, finalBet, finalPlayers, position, sim, 1.0, sprAdvice?.stackBBs ?? 100, "");

  const output: any = {
    ok: true,
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
    bluffRead: advice.bluffRead,
    potSize: finalPot,
    betToCall: finalBet,
    players: finalPlayers,
    position,
    usedRangeVsRange: sim.usedRangeVsRange,
    villainRangePct: narrowed.rangePct,
    boardTexture: boardTexture ? {
      wetness: boardTexture.wetness, label: boardTexture.label,
      heroConnectionNote: boardTexture.heroConnectionNote,
      heroStrategyNote: boardTexture.heroStrategyNote,
    } : null,
    ts: Date.now(),
  };

  broadcastAnalysis(output);

  const trigger = updateHandState(holeStrings, validBoardStrings, advice.displayText, finalPot, finalBet, lastAction);
  const handHistory = getHandHistory();
  const opponentProfile = getOpponentSummary();
  if (trigger) {
    if (minConfidence >= TELEGRAM_MIN_CONF) {
      fireTelegram({ ...output, handHistory, opponentProfile }, trigger);
    } else {
      logger.warn({ minConfidence, trigger: trigger.reason }, "scan-cards: Telegram suppressed (low confidence)");
    }
  }

  logger.info(
    { action: advice.displayText, equity: Math.round(advice.equity * 100), hole: holeStrings, board: validBoardStrings },
    "scan-cards: analysis complete",
  );
  res.json(output);
});

// ── Fold signal ────────────────────────────────────────────────────────────────
// Called by ScreenScan when YOLO sees cards on the table but no hole cards
// for 3+ consecutive frames — meaning the hero folded or the hand ended.
// Triggers the hand-state machine fold path (Telegram "рука закончена") then
// resets state so the next hand starts clean.
router.post("/vision/fold", (_req, res) => {
  const trigger = updateHandState(null, [], "");
  if (trigger?.reason === "fold" && isTelegramConfigured()) {
    sendTelegramMessage("🔻 <b>Рука закончена</b>\nКарты убраны — фолд или шоудаун").catch(() => {});
  }
  resetHandState();
  res.json({ ok: true });
});

// ── Reset state machine ────────────────────────────────────────────────────────
// Called by ScreenScan when the session starts/stops so the state is clean.
router.post("/vision/reset", (_req, res) => {
  resetHandState();
  res.json({ ok: true });
});

export default router;
