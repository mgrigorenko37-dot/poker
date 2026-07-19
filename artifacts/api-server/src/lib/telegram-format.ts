/**
 * Telegram message formatter — ДЕЙСТВИЕ ПЕРВОЕ.
 *
 * Структура сообщения:
 *
 *   🔺 RAISE  2.5BB          ← главное, жирно, сразу
 *   Win 67%  ·  пот-оддс 24%  ← математика решения
 *   A♥ K♦  ·  J♥ 4♠ 2♣  ·  BTN 4p  ← контекст
 *   🟡 SPR 3.2 — топ-пара = шов      ← одна строка, самый важный довод
 *   📊 TAG(8р) · VPIP20/PFR16 · AF2.4 · ⚡ атакуй его чек
 *   🎴 🌊 влажная · флеш-дро, OESD · ↪ C-bet = блеф/полублеф
 *
 * Не используем многострочные блоки. Каждая строка — одна мысль.
 * История рук и детали диапазона убраны — бот принимает решение за тебя.
 */

const SUIT_SYM: Record<string, string> = { h: "♥", d: "♦", c: "♣", s: "♠" };

const NUM_RANK: Record<string, string> = {
  "14": "A", "13": "K", "12": "Q", "11": "J", "10": "T",
};

function fmtCard(c: string): string {
  const rank = c.slice(0, -1);
  const suit = c.slice(-1);
  const r = NUM_RANK[rank] ?? (rank === "T" ? "10" : rank);
  return `${r}${SUIT_SYM[suit] ?? suit}`;
}

const ACTION_EMOJI: Record<string, string> = {
  RAISE:  "🔺",
  "3BET": "🔺",
  BET:    "🔺",
  "BET (полублеф)":   "🔺",
  "RAISE (полублеф)": "🔺",
  CALL:   "🟢",
  CHECK:  "⚪",
  FOLD:   "🔻",
  "ALL-IN": "🔥",
  ALL_IN:   "🔥",
};

export function buildTelegramText(body: {
  holeCards:    string[];
  boardCards?:  string[];
  displayText?: string;
  action?:      string;
  sizing?:      string | null;
  equity?:      number;
  potOdds?:     number | null;
  position?:    string;
  players?:     number;
  potSize?:     number;
  betToCall?:   number;
  draws?: {
    flushDraw: boolean;
    oesd:      boolean;
    gutshot:   boolean;
    totalOuts: number;
    equityRiver: number;
    equityTurn:  number;
  } | null;
  details?: string[];
  handHistory?: {
    actions: Array<{ street: string; description: string; potSize: number; betToCall: number }>;
  } | null;
  villainRange?: {
    description: string;
    categories: string[];
    confidence: 'high' | 'medium' | 'low';
    tendencyNote: string;
    rangePct: number;
    profileNote?: string | null;
  } | null;
  opponentProfile?: {
    handsPlayed: number;
    vpip: number;
    pfr: number;
    af: number;
    cbet: number;
    ftCbet: number;
    confidence: 'high' | 'medium' | 'low';
    playerType: string;
    exploitNote: string;
  } | null;
  sprAdvice?: {
    spr: number;
    zone: string;
    commitment: string;
    strategy: string;
    emoji: string;
    stackBBs: number | null;
  } | null;
  boardTexture?: {
    wetness: string;
    label: string;
    hasFlushDraw: boolean;
    hasOESD: boolean;
    hasGutshot: boolean;
    isPaired: boolean;
    isTripped: boolean;
    isHighBoard: boolean;
    heroConnection: number;
    heroConnectionNote: string;
    cbetInterpretation: string;
    heroStrategyNote: string;
    telegramLine: string;
  } | null;
}): string {
  const action   = body.displayText ?? body.action ?? "?";
  const emoji    = ACTION_EMOJI[action] ?? "❓";
  const winPct   = Math.round((body.equity ?? 0) * 100);
  const board    = body.boardCards ?? [];
  const isPreflop = board.length === 0;

  // ── Строка 1: ДЕЙСТВИЕ (главное) ─────────────────────────────────────────
  let sizingStr = "";
  if (body.sizing) sizingStr = `  ${body.sizing}`;
  if (action === "CALL" && body.betToCall && body.betToCall > 0) {
    sizingStr += `  (≈${body.betToCall.toFixed(0)})`;
  }
  const line1 = `${emoji} <b>${action}</b>${sizingStr}`;

  // ── Строка 2: математика решения ─────────────────────────────────────────
  const oddsStr = (body.potOdds && body.potOdds > 0)
    ? `  ·  пот-оддс ${Math.round(body.potOdds * 100)}%`
    : "";

  // Для draws — добавляем количество аутов рядом с win%
  let drawStr = "";
  if (body.draws) {
    const d = body.draws;
    if (d.flushDraw && (d.oesd || d.gutshot)) {
      drawStr = `  ·  комбо-дро ${d.totalOuts}аут`;
    } else if (d.flushDraw) {
      drawStr = `  ·  fd ${d.totalOuts}аут`;
    } else if (d.oesd) {
      drawStr = `  ·  OESD ${d.totalOuts}аут`;
    } else if (d.gutshot) {
      drawStr = `  ·  gs ${d.totalOuts}аут`;
    }
  }
  const line2 = `Win ${winPct}%${oddsStr}${drawStr}`;

  // ── Строка 3: карты + позиция (контекст) ─────────────────────────────────
  const holeStr    = body.holeCards.map(fmtCard).join(" ");
  const boardStr   = isPreflop ? "преф" : board.map(fmtCard).join(" ");
  const posStr     = body.position ? `  ·  ${body.position}` : "";
  const playersStr = body.players && body.players > 1 ? `  ${body.players}р` : "";
  const line3      = `${holeStr}  ·  ${boardStr}${posStr}${playersStr}`;

  const lines = [line1, line2, line3];

  // ── Строка 4: SPR — самый важный структурный довод ───────────────────────
  if (body.sprAdvice) {
    const sp = body.sprAdvice;
    const stackStr = sp.stackBBs ? ` · стэк ${sp.stackBBs}BB` : "";
    const sprLabel = sp.spr > 0 ? `SPR ${sp.spr}` : "";
    lines.push(`${sp.emoji} ${sprLabel}${stackStr} — ${sp.commitment}`);
  }

  // ── Строка 5: профиль оппонента (компактно: тип + одна метрика-сигнал) ──
  if (body.opponentProfile && body.opponentProfile.handsPlayed >= 3) {
    const op  = body.opponentProfile;
    const pfx = op.confidence === 'high' ? '' : '~';
    // Компактная строка: тип(руки) · VPIP/PFR · одна ключевая метрика + эксплойт
    const keyMetric = op.cbet > 0
      ? `CB${pfx}${op.cbet}%`
      : `AF${pfx}${op.af}`;
    const hudLine = `📊 ${op.playerType} (${op.handsPlayed}р)  VPIP${pfx}${op.vpip}/PFR${pfx}${op.pfr}  ${keyMetric}`;
    lines.push(hudLine);
    lines.push(`⚡ <i>${op.exploitNote}</i>`);
  }

  // ── Строка 6: текстура доски (одна строка с C-bet интерпретацией) ────────
  if (body.boardTexture) {
    const bt = body.boardTexture;
    // Компактная строка: влажность + дро + главная интерпретация C-bet (коротко)
    const cbetShort = body.betToCall && body.betToCall > 0
      ? `  ↪ ${abbreviateCbet(bt.wetness)}`
      : "";
    lines.push(`🎴 ${bt.telegramLine}${cbetShort}`);
  }

  // ── Профиль-нота (когда сессия сильно сдвинула диапазон) ─────────────────
  if (body.villainRange?.profileNote) {
    lines.push(`🧠 <i>${body.villainRange.profileNote}</i>`);
  }

  return lines.join("\n");
}

/** Сокращает C-bet интерпретацию до одной фразы */
function abbreviateCbet(wetness: string): string {
  switch (wetness) {
    case 'monotone': return 'монотонная — бет = рука или блеф';
    case 'very_wet':
    case 'wet':      return 'влажная — C-bet = блеф/полублеф';
    case 'bone_dry':
    case 'dry':      return 'сухая — C-bet = топ-пара+';
    default:         return 'C-bet = вэлью или полублеф';
  }
}
