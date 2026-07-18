/**
 * Telegram message formatter — ultra-compact, instant-readable at a glance.
 *
 * Goal: player must understand what to do in under 1 second.
 * Format:
 *   🟢 CALL
 *   A♥ K♦  ·  2♣ 7♥ Q♦
 *   Win 24%
 *
 * For a raise the sizing is on the same line as the action.
 * Nothing else — no EV, no MDF, no Read, no details bullet list.
 */

const SUIT_SYM: Record<string, string> = { h: "♥", d: "♦", c: "♣", s: "♠" };

function fmtCard(c: string): string {
  const rank = c.slice(0, -1);
  const suit = c.slice(-1);
  return `${rank === "T" ? "10" : rank}${SUIT_SYM[suit] ?? suit}`;
}

const ACTION_EMOJI: Record<string, string> = {
  RAISE:  "🔺",
  "3BET": "🔺",
  "BET":  "🔺",
  "BET (полублеф)":    "🔺",
  "RAISE (полублеф)":  "🔺",
  CALL:   "🟢",
  CHECK:  "⚪",
  FOLD:   "🔻",
  "ALL-IN": "🔥",
  ALL_IN:   "🔥",
};

export function buildTelegramText(body: {
  holeCards:   string[];
  boardCards:  string[];
  displayText?: string;
  action?:     string;
  sizing?:     string | null;
  equity?:     number;
}): string {
  const action   = body.displayText ?? body.action ?? "?";
  const emoji    = ACTION_EMOJI[action] ?? "❓";
  const sizing   = body.sizing ? `  ${body.sizing}` : "";
  const winPct   = Math.round((body.equity ?? 0) * 100);

  const hole  = body.holeCards.map(fmtCard).join(" ");
  const board = body.boardCards?.length
    ? body.boardCards.map(fmtCard).join(" ")
    : "префлоп";

  return [
    `${emoji} <b>${action}</b>${sizing}`,
    `${hole}  ·  ${board}`,
    `Win ${winPct}%`,
  ].join("\n");
}
