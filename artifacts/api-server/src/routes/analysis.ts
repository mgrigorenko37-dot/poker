import { Router, type IRouter } from "express";
import { broadcastAnalysis, getLatestAnalysis } from "../lib/live-analysis";
import { isTelegramConfigured, sendTelegramMessage, fetchLatestChatId } from "../lib/telegram";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const suitSym: Record<string, string> = { h: "♥", d: "♦", c: "♣", s: "♠" };
function fmtCard(c: string): string {
  const rank = c.slice(0, -1);
  const suit = c.slice(-1);
  return `${rank === "T" ? "10" : rank}${suitSym[suit] ?? suit}`;
}

// Dedup key so we don't spam Telegram on every ~700ms scan tick — only send
// when the recommended action actually changes for the current hand.
let lastSentKey: string | null = null;

function buildTelegramText(body: any): string {
  const hole = Array.isArray(body.holeCards) ? body.holeCards.map(fmtCard).join(" ") : "—";
  const board = Array.isArray(body.boardCards) && body.boardCards.length
    ? body.boardCards.map(fmtCard).join(" ")
    : "префлоп";
  const lines = [
    `<b>${body.displayText ?? body.action}</b>${body.sizing ? ` (${body.sizing})` : ""}`,
    `Карты: ${hole} | Борд: ${board}`,
    `Win: ${Math.round((body.equity ?? 0) * 100)}%${body.potOdds != null ? ` · Пот-оддс: ${Math.round(body.potOdds * 100)}%` : ""}`,
  ];
  if (body.bluffRead?.label) lines.push(`Read виллана: ${body.bluffRead.label}`);
  if (Array.isArray(body.details) && body.details.length) {
    lines.push("", ...body.details.slice(0, 4).map((d: string) => `▸ ${d}`));
  }
  return lines.join("\n");
}

// PC posts analysis here → broadcasts to all connected phones (+ Telegram)
router.post("/analysis", (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  broadcastAnalysis(body);

  if (isTelegramConfigured() && Array.isArray(body.holeCards) && body.holeCards.length === 2) {
    const key = JSON.stringify({
      hole: body.holeCards,
      board: body.boardCards,
      action: body.displayText,
    });
    if (key !== lastSentKey) {
      lastSentKey = key;
      sendTelegramMessage(buildTelegramText(body)).catch((err) =>
        logger.error({ err }, "Failed to send Telegram analysis")
      );
    }
  }

  res.json({ ok: true, clients: "broadcast" });
});

// One-time setup: after the user sends /start (or any message) to their bot,
// call this to auto-discover their chat_id and store it.
router.post("/telegram/link", async (_req, res) => {
  const found = await fetchLatestChatId();
  if (!found) {
    res.status(404).json({ error: "No messages found — send /start to your bot first" });
    return;
  }
  res.json(found);
});

router.get("/telegram/status", (_req, res) => {
  res.json({ configured: isTelegramConfigured() });
});

// Phone can poll this if WebSocket isn't available
router.get("/analysis", (req, res) => {
  const latest = getLatestAnalysis();
  if (!latest) {
    res.status(404).json({ error: "No analysis yet — start screen scan on PC" });
    return;
  }
  res.json(latest);
});

export default router;
