/**
 * Telegram message formatter — максимально информативно за минимум строк.
 *
 * Игрок должен понять что делать за < 1 секунды. Формат:
 *
 *   🔺 RAISE  2.5BB
 *   A♥ K♦  ·  префлоп  ·  BTN  4p
 *   Win 67%
 *   Агрессор: UTG (~15% рук)
 *
 *   🟢 CALL  (колл ≈1.20)
 *   A♥ K♦  ·  J♥ 4♠ 2♣ 10♥  ·  CO  3p
 *   Win 58%  ·  пот-оддс 24%
 *   Flush draw — 9 аутов (37% до ривера)
 *
 *   🔻 FOLD
 *   7♥ 2♦  ·  J♥ 4♠ 2♣ 10♥ 9♦  ·  BB  5p
 *   Win 14%  ·  пот-оддс 33%
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
  // расширенные поля — передаются из полного результата анализа
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
  const action  = body.displayText ?? body.action ?? "?";
  const emoji   = ACTION_EMOJI[action] ?? "❓";
  const winPct  = Math.round((body.equity ?? 0) * 100);
  const board   = body.boardCards ?? [];
  const isPreflop = board.length === 0;

  // ── Строка 1: действие + сайзинг ────────────────────────────────────────────
  let sizingStr = "";
  if (body.sizing) {
    sizingStr = `  ${body.sizing}`;
  }
  // Для колла добавляем сумму в $ если известна
  if ((action === "CALL") && body.betToCall && body.betToCall > 0) {
    sizingStr += `  (колл ≈${body.betToCall.toFixed(2)})`;
  }
  const line1 = `${emoji} <b>${action}</b>${sizingStr}`;

  // ── Строка 2: карты + позиция + число игроков ────────────────────────────────
  const holeStr  = body.holeCards.map(fmtCard).join(" ");
  const boardStr = isPreflop ? "префлоп" : board.map(fmtCard).join(" ");
  const posStr   = body.position ? `  ·  ${body.position}` : "";
  const playersStr = body.players && body.players > 1 ? `  ${body.players}p` : "";
  const line2 = `${holeStr}  ·  ${boardStr}${posStr}${playersStr}`;

  // ── Строка 3: win% + пот-оддс ────────────────────────────────────────────────
  const winStr   = `Win ${winPct}%`;
  const oddsStr  = (body.potOdds && body.potOdds > 0)
    ? `  ·  пот-оддс ${Math.round(body.potOdds * 100)}%`
    : "";
  const line3 = `${winStr}${oddsStr}`;

  // ── Строка 4 (опционально): ключевая инфо ────────────────────────────────────
  // Приоритет: дро → агрессор (из details) → пусто
  let line4 = "";

  if (body.draws) {
    const d = body.draws;
    if (d.flushDraw && (d.oesd || d.gutshot)) {
      line4 = `Комбо-дро — ${d.totalOuts} аутов (${Math.round(d.equityRiver)}% до ривера)`;
    } else if (d.flushDraw) {
      line4 = `Flush draw — ${d.totalOuts} аутов (${Math.round(d.equityRiver)}% до ривера)`;
    } else if (d.oesd) {
      line4 = `OESD — ${d.totalOuts} аутов (${Math.round(d.equityRiver)}% до ривера)`;
    } else if (d.gutshot) {
      line4 = `Gutshot — ${d.totalOuts} аутов (${Math.round(d.equityRiver)}% до ривера)`;
    }
  }

  // Если нет дро — ищем строку об агрессоре или первую деталь из preflopа
  if (!line4 && body.details?.length) {
    const aggNote = body.details.find(d => d.startsWith("Агрессор:"));
    if (aggNote) line4 = aggNote;
  }

  const lines = [line1, line2, line3];
  if (line4) lines.push(line4);

  // ── История руки (этап 2) ─────────────────────────────────────────────────
  if (body.handHistory?.actions && body.handHistory.actions.length > 0) {
    const streetOrder = ['preflop', 'flop', 'turn', 'river'];
    const streetLabel: Record<string, string> = {
      preflop: 'преф', flop: 'флоп', turn: 'тёрн', river: 'ривер',
    };
    const byStreet = new Map<string, string>();
    for (const a of body.handHistory.actions) {
      byStreet.set(a.street, a.description);
    }
    const historyParts: string[] = [];
    for (const s of streetOrder) {
      const desc = byStreet.get(s);
      if (desc) historyParts.push(`${streetLabel[s] ?? s}: ${desc}`);
    }
    if (historyParts.length > 0) {
      lines.push(`📋 <i>${historyParts.join('  ·  ')}</i>`);
    }
  }

  // ── Диапазон оппонента (этап 3 + профиль этап 4) ─────────────────────────
  if (body.villainRange && body.villainRange.rangePct > 0) {
    const vr = body.villainRange;
    const confEmoji = vr.confidence === 'high' ? '🎯' : vr.confidence === 'medium' ? '🔍' : '❓';
    lines.push(`${confEmoji} ${vr.description}`);
    if (vr.tendencyNote) {
      lines.push(`💡 <i>${vr.tendencyNote}</i>`);
    }
    // Surface when session profile meaningfully shifted the range vs. action-only
    if (vr.profileNote) {
      lines.push(`🧠 <i>${vr.profileNote}</i>`);
    }
  }

  // ── SPR (этап 5) ──────────────────────────────────────────────────────────
  if (body.sprAdvice) {
    const sp = body.sprAdvice;
    const stackStr = sp.stackBBs ? ` · стэк ${sp.stackBBs}BB` : '';
    const sprLabel  = sp.spr > 0 ? `SPR ${sp.spr}` : '';
    lines.push(`${sp.emoji} ${sprLabel}${stackStr} — ${sp.commitment}`);
  }

  // ── HUD оппонента (этап 4) ────────────────────────────────────────────────
  // Показываем только когда накоплено достаточно рук и это смена улицы/новая рука.
  if (body.opponentProfile && body.opponentProfile.handsPlayed >= 3) {
    const op = body.opponentProfile;
    const reliable = op.confidence === 'high';
    const prefix = reliable ? '' : '~';
    // HUD строка: VPIP/PFR  AF  CB/FtCB
    const hudLine = `📊 <b>${op.playerType}</b>  (${op.handsPlayed}р) · VPIP ${prefix}${op.vpip}% · PFR ${prefix}${op.pfr}% · AF ${prefix}${op.af}`;
    const cbLine  = op.cbet > 0
      ? `   CB ${prefix}${op.cbet}%  FtCB ${prefix}${op.ftCbet}%`
      : '';
    lines.push(hudLine + cbLine);
    lines.push(`⚡ <i>${op.exploitNote}</i>`);
  }

  // ── Текстура доски (этап 6) ────────────────────────────────────────────────
  if (body.boardTexture) {
    const bt = body.boardTexture;
    lines.push(`🎴 ${bt.telegramLine}`);
    // Show c-bet interpretation only when villain is betting (betToCall > 0)
    if (body.betToCall && body.betToCall > 0 && bt.cbetInterpretation) {
      lines.push(`↪ <i>${bt.cbetInterpretation}</i>`);
    }
    // Show hero connection note when it's informative
    if (bt.heroConnectionNote && bt.heroConnection >= 2) {
      lines.push(`✅ <i>${bt.heroConnectionNote}</i>`);
    } else if (bt.heroConnectionNote && bt.heroConnection === 0) {
      lines.push(`⚠️ <i>${bt.heroConnectionNote}</i>`);
    }
  }

  return lines.join("\n");
}
