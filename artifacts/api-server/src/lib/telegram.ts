import { logger } from "./logger";
import fs from "node:fs";
import path from "node:path";

/**
 * Minimal Telegram Bot API client — no SDK needed, just fetch.
 * Requires TELEGRAM_BOT_TOKEN (secret). The destination chat_id is discovered
 * automatically the first time the user messages the bot (see /api/telegram/link)
 * and persisted to a small local config file (chat_id is not sensitive).
 */

const API_BASE = "https://api.telegram.org";
const CONFIG_PATH = path.join(process.cwd(), "data", "telegram-config.json");

function readChatId(): string | null {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw)?.chatId ?? null;
  } catch {
    return null;
  }
}

function writeChatId(chatId: string): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ chatId }, null, 2));
}

export function isTelegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && readChatId());
}

export async function sendTelegramMessage(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = readChatId();
  if (!token || !chatId) return;

  try {
    const res = await fetch(`${API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, body }, "Telegram sendMessage failed");
    }
  } catch (err) {
    logger.error({ err }, "Telegram sendMessage error");
  }
}

// One-time discovery: the user sends /start to their bot, then we call this to
// find their chat_id from Telegram's getUpdates and persist it locally.
export async function fetchLatestChatId(): Promise<{ chatId: string; username?: string } | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;

  const res = await fetch(`${API_BASE}/bot${token}/getUpdates?limit=5`);
  if (!res.ok) return null;
  const data = (await res.json()) as { result?: Array<{ message?: { chat?: { id?: number; username?: string } } }> };
  const updates = data?.result ?? [];
  for (let i = updates.length - 1; i >= 0; i--) {
    const msg = updates[i]?.message;
    if (msg?.chat?.id) {
      const chatId = String(msg.chat.id);
      writeChatId(chatId);
      return { chatId, username: msg.chat.username };
    }
  }
  return null;
}
