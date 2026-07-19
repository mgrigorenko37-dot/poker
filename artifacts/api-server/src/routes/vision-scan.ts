/**
 * POST /api/vision/scan
 *
 * Flow:
 *   1. Start Gemini stream, accumulate until full JSON ready
 *   2. Parse hole + board cards, run GTO analysis
 *   3. Feed result into hand state machine → fires Telegram only on real events:
 *        • New hand (hole cards appeared / changed)
 *        • Street change (flop / turn / river)
 *        • Within-street action stable for N scans
 *        • Fold (hole cards disappeared)
 *   4. Broadcast full analysis over WebSocket
 *   5. Return JSON to browser
 *
 * No more early-fire or key-based dedup — the state machine owns all Telegram decisions.
 */

import { Router, type IRouter } from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { broadcastAnalysis } from "../lib/live-analysis";
import { isTelegramConfigured, sendTelegramMessage } from "../lib/telegram";
import { buildTelegramText } from "../lib/telegram-format";
import { logger } from "../lib/logger";
import { parseCard, runMonteCarloSim } from "../lib/poker";
import { getFullAdvice } from "../lib/poker-gto";
import { updateHandState, resetHandState, getHandHistory, type TelegramTrigger } from "../lib/hand-state";
import { narrowVillainRange } from "../lib/range-narrower";
import { getOpponentSummary } from "../lib/opponent-profile";
import { getSPRAdvice } from "../lib/spr-advice";
import { getBoardTexture } from "../lib/board-texture";

const router: IRouter = Router();

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

// Short prompt — fewer tokens = faster TTFT.
// lastAction: most recent visible action text from the HUD/chat (e.g. "raised to 12", "checked", "called 5") — null if not visible.
const VISION_PROMPT =
  `Poker screenshot. Return ONLY raw JSON (no markdown):
{"holeCards":["Xr","Yr"],"boardCards":[],"potSize":null,"betToCall":null,"activePlayers":null,"lastAction":null,"stackSize":null,"bbSize":null}
holeCards=player 2 cards at bottom (null if hidden). boardCards=center 0-5.
Ranks: A K Q J T 9-2. Suits: h d c s. E.g. "Ah","Ks","Td","2c".
lastAction=last visible action text from HUD/chat log (e.g. "raised to 12", "checked", "called 5"), null if absent.
stackSize=hero effective stack in chips (the smaller of the two stacks in play), null if not visible.
bbSize=big blind size in chips (e.g. 5, 10, 25), null if not visible.`;

// Models to try in order (fastest first)
const MODELS = ["gemini-3.1-flash-lite", "gemini-3-flash-preview"];

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
  const lastAction: string | null =
    typeof parsed.lastAction === "string" && parsed.lastAction.length > 0
      ? parsed.lastAction
      : null;
  const detectedStack: number | null =
    typeof parsed.stackSize === "number" && parsed.stackSize > 0 ? parsed.stackSize : null;
  const detectedBB: number | null =
    typeof parsed.bbSize === "number" && parsed.bbSize > 0 ? parsed.bbSize : null;

  if (holeStrings.length !== 2) {
    // Hole cards not visible → player may have folded; notify state machine
    const foldTrigger = updateHandState(null, [], "");
    if (foldTrigger?.reason === "fold" && isTelegramConfigured()) {
      sendTelegramMessage("🔻 <b>Рука закончена</b>\nКарты скрыты — фолд или шоудаун").catch(() => {});
    }
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

  // ── SPR (Phase 5) ──────────────────────────────────────────────────────────
  const isPreflop = board.length === 0;
  const sprAdvice = getSPRAdvice(detectedStack, finalPot, detectedBB, isPreflop);

  // ── Board texture (Phase 6) ────────────────────────────────────────────────
  const betSizePct = finalPot > 0 && finalBet > 0
    ? Math.round((finalBet / finalPot) * 100) : null;
  const boardTexture = !isPreflop ? getBoardTexture(board, hole, betSizePct) : null;

  // ── Range narrowing (Phase 3) ──────────────────────────────────────────────
  const currentHistory = getHandHistory();
  const narrowed = narrowVillainRange(currentHistory.actions, currentHistory.street);

  const sim    = runMonteCarloSim(hole, board, finalPlayers, 1200, narrowed.rangeKeys);
  const advice = getFullAdvice(hole, board, finalPot, finalBet, finalPlayers, position, sim, 1.0, sprAdvice?.stackBBs ?? 100, "");

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
    villainRangePct: narrowed.rangePct,
    // Phase 3+4: narrowed villain range (session-profile-adjusted)
    villainRange: {
      description: narrowed.description,
      categories: narrowed.categories,
      confidence: narrowed.confidence,
      tendencyNote: narrowed.tendencyNote,
      rangePct: narrowed.rangePct,
      profileNote: narrowed.profileNote,
    },
    // Phase 5: SPR
    sprAdvice: sprAdvice
      ? {
          spr: sprAdvice.spr,
          zone: sprAdvice.zone,
          commitment: sprAdvice.commitment,
          strategy: sprAdvice.strategy,
          emoji: sprAdvice.emoji,
          stackBBs: sprAdvice.stackBBs,
        }
      : null,
    // Phase 6: Board texture
    boardTexture: boardTexture
      ? {
          wetness: boardTexture.wetness,
          wetnessScore: boardTexture.wetnessScore,
          label: boardTexture.label,
          isMonotone: boardTexture.isMonotone,
          hasFlushDraw: boardTexture.hasFlushDraw,
          hasOESD: boardTexture.hasOESD,
          hasGutshot: boardTexture.hasGutshot,
          isPaired: boardTexture.isPaired,
          isTripped: boardTexture.isTripped,
          isHighBoard: boardTexture.isHighBoard,
          isLowBoard: boardTexture.isLowBoard,
          heroConnection: boardTexture.heroConnection,
          heroConnectionNote: boardTexture.heroConnectionNote,
          cbetInterpretation: boardTexture.cbetInterpretation,
          heroStrategyNote: boardTexture.heroStrategyNote,
          telegramLine: boardTexture.telegramLine,
        }
      : null,
    ts: Date.now(),
  };

  // ── Broadcast to WebSocket ─────────────────────────────────────────────────
  broadcastAnalysis(output as any);

  // ── Hand state machine + Telegram ─────────────────────────────────────────
  // Only fires on real game events: new hand, street change, stable action shift.
  // OCR noise / Monte Carlo variance will NOT trigger spurious messages.
  const trigger = updateHandState(
    holeStrings,
    validBoardStrings,
    advice.displayText,
    finalPot,
    finalBet,
    lastAction,
  );
  const handHistory = getHandHistory();
  const opponentProfile = getOpponentSummary();
  if (trigger) {
    fireTelegram({ ...output, handHistory, opponentProfile }, trigger);
  }

  logger.info(
    {
      action: advice.displayText,
      equity: Math.round(advice.equity * 100),
      hole: holeStrings,
      board: validBoardStrings,
      telegramTrigger: trigger?.reason ?? null,
    },
    "vision/scan: analysis complete",
  );

  res.json({ ok: true, ...output });
});

// ── Reset state machine ────────────────────────────────────────────────────────
// Called by ScreenScan when the session starts/stops so the state is clean.
router.post("/vision/reset", (_req, res) => {
  resetHandState();
  res.json({ ok: true });
});

export default router;
