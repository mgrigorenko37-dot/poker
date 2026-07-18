/**
 * Telegram bot routes:
 *
 * POST /api/telegram/link
 *   Calls Telegram getUpdates to find the latest message from the user,
 *   extracts their chat_id and persists it. The user must have sent /start
 *   to the bot first.
 *
 * POST /api/telegram/test
 *   Sends a test message to the linked chat to confirm everything works.
 *
 * GET /api/telegram/status
 *   Returns whether the bot is fully configured (token + chat_id).
 */

import { Router, type IRouter } from "express";
import {
  fetchLatestChatId,
  isTelegramConfigured,
  sendTelegramMessage,
} from "../lib/telegram";

const router: IRouter = Router();

router.post("/telegram/link", async (_req, res) => {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    res.status(503).json({
      ok: false,
      error: "TELEGRAM_BOT_TOKEN не задан в Secrets. Добавь его на Replit и перезапусти сервер.",
    });
    return;
  }

  try {
    const result = await fetchLatestChatId();
    if (!result) {
      res.status(404).json({
        ok: false,
        error: "Не найдено сообщений от пользователя. Убедись что написал /start боту в Telegram.",
      });
      return;
    }
    res.json({ ok: true, chatId: result.chatId, username: result.username ?? null });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message ?? "Ошибка при обращении к Telegram API" });
  }
});

router.post("/telegram/test", async (_req, res) => {
  if (!isTelegramConfigured()) {
    res.status(503).json({
      ok: false,
      error: "Telegram не настроен. Сначала вызови /api/telegram/link.",
    });
    return;
  }

  await sendTelegramMessage(
    "✅ <b>Poker Advisor подключён!</b>\n\nТеперь советы будут приходить сюда в реальном времени.\n\nПример:\n🔺 <b>RAISE</b>  33% pot\nA♥ K♦  ·  префлоп\nWin 67%",
  );
  res.json({ ok: true });
});

router.get("/telegram/status", (_req, res) => {
  const hasToken = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  const configured = isTelegramConfigured();
  res.json({
    hasToken,
    hasChatId: configured,
    ready: configured,
  });
});

export default router;
