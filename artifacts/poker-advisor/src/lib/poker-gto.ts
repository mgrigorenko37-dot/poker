/**
 * GTO Poker Engine — advanced analysis layer
 * Extends base poker.ts with GTO ranges, draw detection, MDF, EV calculations
 */
import {
  type Card, type Suit, type Rank,
  evaluateHand, HandRank, runMonteCarloSim, getPreflopEquity,
  createDeck, RANK_CHARS,
  type SimulationResult,
} from './poker';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Position = 'UTG' | 'MP' | 'HJ' | 'CO' | 'BTN' | 'SB' | 'BB';

export interface DrawInfo {
  flushDraw: boolean;
  oesd: boolean;           // open-ended straight draw (8 outs)
  gutshot: boolean;        // gutshot straight draw (4 outs)
  backdoorFlush: boolean;  // 3 to a flush (backdoor)
  overCards: number;       // overcards to board
  comboDraws: boolean;     // flush + straight draw
  totalOuts: number;
  equityTurn: number;      // rule of 2 (1 card to come) %
  equityRiver: number;     // rule of 4 (2 cards to come) %
  description: string;
}

export interface FullAdvice {
  action: 'FOLD' | 'CHECK' | 'CALL' | 'RAISE' | 'ALL_IN';
  displayText: string;
  color: string;
  details: string[];
  equity: number;
  potOdds: number | null;
  mdf: number | null;
  handCategory: string;
  handName: string | null;
  draws: DrawInfo | null;
  sizing: string | null;   // e.g. "75% pot"
  ev: number | null;       // expected value in BB (if pot info available)
  bluffRead: BluffRead | null;
}

export interface BluffRead {
  label: 'Вероятно блеф' | 'Похоже на вэлью' | 'Неопределённо' | 'Поляризовано';
  score: number;       // 0..1, higher = more likely a bluff
  reasons: string[];
}

// ─── Bluff heuristic ──────────────────────────────────────────────────────────
// IMPORTANT: this is a population-tendency heuristic based on bet sizing, board
// texture and street — it cannot read an opponent's actual cards or intent.
// Treat it as one extra input, never as certainty.
export function getBluffRead(
  betToCall: number,
  potBeforeBet: number,
  boardCards: Card[],
  players: number,
  street: 'flop' | 'turn' | 'river',
): BluffRead | null {
  if (betToCall <= 0 || potBeforeBet <= 0) return null;

  const sizeRatio = betToCall / potBeforeBet; // bet as % of pot
  const reasons: string[] = [];
  let score = 0.5; // start neutral

  // Overbets are polarized — either very strong or a pure bluff, rarely medium
  if (sizeRatio >= 1.2) {
    score += 0.15;
    reasons.push(`Овербет (${(sizeRatio * 100).toFixed(0)}% пота) — диапазон поляризован: монстр или блеф, редко середина`);
  } else if (sizeRatio <= 0.35) {
    score -= 0.1;
    reasons.push(`Маленькая ставка (${(sizeRatio * 100).toFixed(0)}% пота) — чаще вэлью/контроль пота, реже блеф`);
  } else {
    reasons.push(`Стандартный размер (${(sizeRatio * 100).toFixed(0)}% пота) — не даёт явного сигнала`);
  }

  // Scare cards (flush/straight completing cards, high cards on later streets) invite more bluffs
  const suitCount: Record<string, number> = {};
  for (const c of boardCards) suitCount[c.suit] = (suitCount[c.suit] || 0) + 1;
  const monotoneOrFlush = Math.max(0, ...Object.values(suitCount)) >= 3;
  if (monotoneOrFlush && street !== 'flop') {
    score += 0.1;
    reasons.push('Флеш-возможный борд на позднем стрите — чаще провоцирует блефы полукартами');
  }

  // More players in the pot = less credible bluffs (harder for a bluff to get through many ranges)
  if (players >= 4) {
    score -= 0.1;
    reasons.push(`${players} игроков в раздаче — блефовать через многих сложнее, вероятнее вэлью`);
  } else if (players === 2) {
    score += 0.05;
    reasons.push('Один на один — блефы гораздо чаще, чем в мультипоте');
  }

  // River is where bluffs either get through or die — sizing tells matter most here
  if (street === 'river') {
    reasons.push('Ривер — решающая улица для блефа, доверяй в первую очередь размеру ставки');
  }

  score = Math.max(0.05, Math.min(0.95, score));

  let label: BluffRead['label'];
  if (sizeRatio >= 1.2) label = 'Поляризовано';
  else if (score >= 0.62) label = 'Вероятно блеф';
  else if (score <= 0.4) label = 'Похоже на вэлью';
  else label = 'Неопределённо';

  return { label, score, reasons };
}

// ─── GTO Preflop Ranges ───────────────────────────────────────────────────────
// Equity thresholds to open raise first-in (RFI) by position
// Based on 6-max GTO opening frequencies
const RFI_EQUITY: Record<Position, number> = {
  UTG: 63.0,  // ~13% range
  MP:  61.5,  // ~17% range
  HJ:  59.0,  // ~22% range
  CO:  56.5,  // ~30% range
  BTN: 53.0,  // ~45% range
  SB:  55.0,  // ~35% range vs BB
  BB:  0,     // BB always acts last preflop
};

// Min pair rank to open RFI by position (pairs have lower equity but are openable)
const RFI_MIN_PAIR: Record<Position, Rank> = {
  UTG: 8 as Rank,  // 88+
  MP:  7 as Rank,  // 77+
  HJ:  6 as Rank,  // 66+
  CO:  2 as Rank,  // 22+
  BTN: 2 as Rank,  // 22+
  SB:  2 as Rank,  // 22+
  BB:  2 as Rank,
};

// 3bet equity thresholds (value 3bets)
const THREBET_VALUE_EQUITY = 73;  // TT+, AQs+, AKo
// 3bet range when facing raise
const CALL_FACING_RAISE: Record<Position, number> = {
  UTG: 65, MP: 63, HJ: 61, CO: 59, BTN: 57, SB: 60, BB: 56,
};

// ─── Preflop advice ───────────────────────────────────────────────────────────

export function getGTOPreflopAdvice(
  holeCards: Card[],
  position: Position,
  facingRaise = false,
  stackBBs = 100,
): { action: 'RAISE' | '3BET' | 'CALL' | 'FOLD'; reason: string; strength: string } {
  if (holeCards.length !== 2) return { action: 'FOLD', reason: 'Нет карт', strength: 'Unknown' };

  const equity = getPreflopEquity(holeCards);
  const isPair = holeCards[0].rank === holeCards[1].rank;
  const pairRank = isPair ? holeCards[0].rank : 0;

  // Hand strength label
  let strength = 'Weak';
  if (equity >= 78) strength = 'Premium';
  else if (equity >= 67) strength = 'Strong';
  else if (equity >= 60) strength = 'Medium';
  else if (equity >= 54) strength = 'Speculative';

  if (facingRaise) {
    // Value 3bet: AA, KK, QQ, JJ (77+/TT+), AKs, AKo, AQs
    if (equity >= THREBET_VALUE_EQUITY || (isPair && pairRank >= 10)) {
      return { action: '3BET', reason: `Топ-диапазон → 3bet ценность (${equity.toFixed(0)}% equity)`, strength };
    }
    // Light 3bet: BTN/CO suited connectors (semi-bluff)
    const isSuited = holeCards[0].suit === holeCards[1].suit;
    if ((position === 'BTN' || position === 'CO') && isSuited && equity >= 56 && equity < 61) {
      return { action: '3BET', reason: `Suited ${position} → 3bet блеф (поляризация)`, strength };
    }
    const callThreshold = CALL_FACING_RAISE[position];
    if (equity >= callThreshold || (isPair && pairRank >= 5 && position !== 'UTG')) {
      return { action: 'CALL', reason: `Колл против рейза (${equity.toFixed(0)}% equity, ${position})`, strength };
    }
    return { action: 'FOLD', reason: `Вне диапазона колла для ${position} против рейза`, strength };
  }

  // RFI (raise first in)
  const threshold = RFI_EQUITY[position];
  const minPair = RFI_MIN_PAIR[position];
  const canOpen = isPair ? pairRank >= minPair : equity >= threshold;

  if (canOpen) {
    const sizing = stackBBs <= 20 ? 'ALL-IN' : stackBBs <= 40 ? '3BB' : '2.5BB';
    return { action: 'RAISE', reason: `${position} RFI → ${sizing} (${equity.toFixed(0)}% equity)`, strength };
  }
  return { action: 'FOLD', reason: `Вне диапазона открытия для ${position} (${equity.toFixed(0)}% equity)`, strength };
}

// ─── Draw Detection ───────────────────────────────────────────────────────────

export function detectDraws(holeCards: Card[], boardCards: Card[]): DrawInfo | null {
  if (boardCards.length === 0 || boardCards.length >= 5) return null;

  const allCards = [...holeCards, ...boardCards];

  // ── Flush draw ──────────────────────────────────────────────────────────────
  const suitCount: Record<string, number> = {};
  for (const c of allCards) suitCount[c.suit] = (suitCount[c.suit] || 0) + 1;
  const maxSuit = Math.max(...Object.values(suitCount));
  const flushDraw = maxSuit === 4;
  const backdoorFlush = maxSuit === 3;

  // ── Straight draw ───────────────────────────────────────────────────────────
  const rankSet = new Set(allCards.map(c => c.rank));
  // Add low ace
  if (rankSet.has(14)) rankSet.add(1 as Rank);
  const ranks = [...rankSet].sort((a, b) => a - b);

  let oesd = false;
  let gutshot = false;

  // Check every 5-rank window
  for (let lo = 1; lo <= 10; lo++) {
    const hi = lo + 4;
    const inWindow = ranks.filter(r => r >= lo && r <= hi);
    if (inWindow.length === 4) {
      const span = inWindow[inWindow.length - 1] - inWindow[0];
      if (span === 4) {
        // All 4 are consecutive → open-ended (missing 1 end)
        const missingLow  = !rankSet.has(lo as Rank);
        const missingHigh = !rankSet.has(hi as Rank);
        if (missingLow || missingHigh) oesd = true;
      } else {
        // Gap in the middle → gutshot
        gutshot = true;
      }
    }
  }

  // ── Over cards ──────────────────────────────────────────────────────────────
  const maxBoard = Math.max(...boardCards.map(c => c.rank));
  const overCards = holeCards.filter(c => c.rank > maxBoard).length;

  // ── Out count ───────────────────────────────────────────────────────────────
  let outs = 0;
  const descriptions: string[] = [];

  if (flushDraw)  { outs += 9; descriptions.push('Flush draw (9 outs)'); }
  if (oesd)       { outs += 8; descriptions.push('OESD (8 outs)'); }
  else if (gutshot) { outs += 4; descriptions.push('Gutshot (4 outs)'); }

  // Combo draw bonus already counted — cap at real outs
  if (flushDraw && oesd) outs = 15;  // overlap: ~15 unique outs

  // Over cards (if no pair yet)
  const myHandRank = evaluateHand(holeCards, boardCards)?.handRank ?? -1;
  if (myHandRank < HandRank.PAIR && overCards > 0 && !flushDraw && !oesd && !gutshot) {
    outs += overCards * 3;
    descriptions.push(`${overCards} overcards (~${overCards * 3} outs)`);
  }

  const cardsToGo = 5 - boardCards.length;
  const equityTurn   = Math.min(outs * 2, 99);  // rule of 2
  const equityRiver  = Math.min(outs * 4, 99);  // rule of 4

  return {
    flushDraw, oesd, gutshot, backdoorFlush,
    overCards,
    comboDraws: flushDraw && (oesd || gutshot),
    totalOuts: outs,
    equityTurn,
    equityRiver: cardsToGo === 2 ? equityRiver : equityTurn,
    description: descriptions.join(' + ') || 'No draw',
  };
}

// ─── MDF (Minimum Defense Frequency) ─────────────────────────────────────────
// How often you need to continue (call/raise) to make villain's bluffs 0 EV

export function getMDF(betSize: number, potBeforeBet: number): number {
  if (potBeforeBet <= 0 || betSize <= 0) return 0;
  return 1 - betSize / (potBeforeBet + betSize * 2);
}

// ─── Hand category ────────────────────────────────────────────────────────────

export function getHandCategory(
  handRank: number | null,
  winProb: number,
  draws: DrawInfo | null,
): string {
  if (handRank !== null) {
    if (handRank >= HandRank.STRAIGHT_FLUSH) return 'Монстр 🔥';
    if (handRank >= HandRank.FULL_HOUSE) return 'Монстр';
    if (handRank >= HandRank.FLUSH) return 'Очень сильная';
    if (handRank >= HandRank.STRAIGHT) return 'Сильная';
    if (handRank >= HandRank.THREE_OF_A_KIND) return 'Сильная';
    if (handRank >= HandRank.TWO_PAIR) {
      return winProb > 0.55 ? 'Средняя' : 'Средняя-слабая';
    }
    if (handRank >= HandRank.PAIR) {
      return winProb > 0.55 ? 'Средняя' : 'Слабая';
    }
  }
  if (draws?.comboDraws) return 'Комбо-дроу';
  if (draws?.flushDraw || draws?.oesd) return 'Дроу';
  if (draws?.gutshot) return 'Гатшот';
  return winProb > 0.42 ? 'Слабая' : 'Воздух';
}

// ─── EV Calculation ───────────────────────────────────────────────────────────

export function getCallEV(
  winProb: number,
  potSize: number,
  betToCall: number,
): number {
  // EV of call = winProb * (pot + betToCall) - betToCall
  return winProb * (potSize + betToCall) - betToCall;
}

export function getRaiseEV(
  winProb: number,
  potSize: number,
  raiseSize: number,
  foldEquity = 0.3, // estimated % villain folds
): number {
  // EV raise = foldEquity * pot + (1-foldEquity) * [winProb * (pot + raiseSize*2) - raiseSize]
  const evIfCalled = winProb * (potSize + raiseSize * 2) - raiseSize;
  return foldEquity * potSize + (1 - foldEquity) * evIfCalled;
}

// ─── Master Advice Function ───────────────────────────────────────────────────

export function getFullAdvice(
  holeCards: Card[],
  boardCards: Card[],
  potSize: number,
  betToCall: number,
  players: number,
  position: string,
  simResult: SimulationResult,
): FullAdvice {
  const w = simResult.winProb;
  const isPreflop = boardCards.length === 0;

  const ev = evaluateHand(holeCards, boardCards);
  const handRank = ev?.handRank ?? null;
  const handName = ev?.handName ?? null;

  const draws = !isPreflop ? detectDraws(holeCards, boardCards) : null;

  const potOdds = (betToCall > 0 && potSize >= 0)
    ? betToCall / (potSize + betToCall)
    : null;

  const mdf = (betToCall > 0 && potSize > 0)
    ? getMDF(betToCall, potSize)
    : null;

  const handCategory = getHandCategory(handRank, w, draws);

  let callEV: number | null = null;
  let evResult: number | null = null;
  if (potOdds !== null && potSize >= 0) {
    callEV = getCallEV(w, potSize, betToCall);
    evResult = callEV;
  }

  const details: string[] = [];
  let action: FullAdvice['action'];
  let displayText: string;
  let color: string;
  let sizing: string | null = null;

  const street: 'flop' | 'turn' | 'river' =
    boardCards.length === 3 ? 'flop' : boardCards.length === 4 ? 'turn' : 'river';
  const bluffRead = !isPreflop
    ? getBluffRead(betToCall, potSize, boardCards, players, street)
    : null;

  // ── MONSTER: shove ──────────────────────────────────────────────────────────
  if (handRank !== null && handRank >= HandRank.FULL_HOUSE) {
    action = 'ALL_IN';
    displayText = 'ALL-IN';
    color = 'bg-amber-500';
    details.push(`${handName} — максимизируй пот`);
    details.push(`Вероятность победы: ${(w * 100).toFixed(0)}%`);
    if (mdf) details.push(`Вилланту нужно защищать ${(mdf * 100).toFixed(0)}% рук`);
    return { action, displayText, color, details, equity: w, potOdds, mdf, handCategory, handName, draws, sizing, ev: evResult, bluffRead };
  }

  // ── PREFLOP ─────────────────────────────────────────────────────────────────
  if (isPreflop) {
    const pos = position as Position;
    const preflopAdvice = getGTOPreflopAdvice(holeCards, pos, betToCall > 0, 100);

    if (preflopAdvice.action === '3BET') {
      action = 'RAISE'; displayText = '3BET'; color = 'bg-purple-600';
      details.push(preflopAdvice.reason);
      details.push(`Сила руки: ${preflopAdvice.strength}`);
    } else if (preflopAdvice.action === 'RAISE') {
      action = 'RAISE'; displayText = 'RAISE'; color = 'bg-emerald-600';
      sizing = '2.5BB';
      details.push(preflopAdvice.reason);
    } else if (preflopAdvice.action === 'CALL') {
      action = 'CALL'; displayText = 'CALL'; color = 'bg-blue-600';
      details.push(preflopAdvice.reason);
      if (potOdds) details.push(`Пот-оддс: ${(potOdds * 100).toFixed(0)}%`);
    } else {
      action = 'FOLD'; displayText = 'FOLD'; color = 'bg-red-700';
      details.push(preflopAdvice.reason);
    }
    details.push(`Equity: ${getPreflopEquity(holeCards).toFixed(0)}% vs случайной`);
    return { action, displayText, color, details, equity: w, potOdds, mdf, handCategory: preflopAdvice.strength, handName: null, draws: null, sizing, ev: evResult, bluffRead: null };
  }

  // ── POST-FLOP ───────────────────────────────────────────────────────────────
  const hasNoBet = !betToCall || betToCall === 0;
  const drawEquity = draws ? draws.equityRiver / 100 : 0;
  const effectiveEquity = Math.max(w, drawEquity);
  const isStrong  = handRank !== null && handRank >= HandRank.FLUSH;
  const isMedium  = handRank !== null && handRank >= HandRank.TWO_PAIR;
  const hasGoodDraw = draws && (draws.flushDraw || draws.oesd || draws.comboDraws);

  if (hasNoBet) {
    // ── No bet facing — we act first (check or bet) ──
    if (isStrong || w > 0.72) {
      action = 'RAISE'; displayText = 'BET'; color = 'bg-emerald-600';
      sizing = w > 0.80 ? '75% pot' : '50% pot';
      details.push(`Win ${(w * 100).toFixed(0)}% — строй пот`);
      if (handName) details.push(handName);
    } else if (isMedium && w > 0.55) {
      action = 'RAISE'; displayText = 'BET'; color = 'bg-emerald-600';
      sizing = '33% pot';
      details.push(`${handName} (${(w * 100).toFixed(0)}%) — защищай средней ставкой`);
    } else if (hasGoodDraw) {
      // Semi-bluff with draw
      action = 'RAISE'; displayText = 'BET (полублеф)'; color = 'bg-teal-600';
      sizing = '50% pot';
      details.push(draws!.description);
      details.push(`~${draws!.equityRiver}% equity на дроу — полублеф`);
    } else if (w > 0.50) {
      action = 'CHECK'; displayText = 'CHECK'; color = 'bg-zinc-600';
      details.push(`Win ${(w * 100).toFixed(0)}% — контролируй пот`);
      if (draws) details.push(`${draws.totalOuts} outs, смотри бесплатно`);
    } else {
      action = 'CHECK'; displayText = 'CHECK'; color = 'bg-zinc-700';
      details.push(`Win ${(w * 100).toFixed(0)}% — пасс`);
      if (draws) details.push(draws.description);
    }
  } else {
    // ── Facing a bet ──
    const shouldRaise = (
      (handRank !== null && handRank >= HandRank.FLUSH) ||
      (potOdds !== null && w > potOdds + 0.20)
    );
    const shouldCall = potOdds !== null && (
      w > potOdds + 0.01 ||
      (hasGoodDraw && drawEquity > potOdds)
    );

    if (shouldRaise) {
      action = 'RAISE'; displayText = 'RAISE'; color = 'bg-emerald-600';
      sizing = '2.5× bet';
      details.push(`Win ${(w * 100).toFixed(0)}% >> pot odds ${(potOdds! * 100).toFixed(0)}%`);
      if (handName) details.push(handName);
      if (mdf) details.push(`Вилланту защищать ≥ ${(mdf * 100).toFixed(0)}% — давим`);
      if (bluffRead) details.push(`Read виллана: ${bluffRead.label.toLowerCase()}`);
    } else if (shouldCall) {
      action = 'CALL'; displayText = 'CALL'; color = 'bg-blue-600';
      details.push(`Win ${(w * 100).toFixed(0)}% > pot odds ${(potOdds! * 100).toFixed(0)}%`);
      if (hasGoodDraw && draws) {
        details.push(`Дроу: ${draws.description} = ${draws.equityRiver}% equity`);
      }
      if (callEV !== null) {
        details.push(`EV колла: ${callEV > 0 ? '+' : ''}${callEV.toFixed(1)} BB`);
      }
      if (mdf) details.push(`MDF: защищаем ${(mdf * 100).toFixed(0)}% диапазона`);
      if (bluffRead) details.push(`Read: ${bluffRead.label.toLowerCase()}`);
    } else {
      action = 'FOLD'; displayText = 'FOLD'; color = 'bg-red-700';
      details.push(`Win ${(w * 100).toFixed(0)}% < pot odds ${potOdds !== null ? (potOdds * 100).toFixed(0) + '%' : '?'}`);
      if (draws) details.push(`Дроу: ${draws.totalOuts} outs (${draws.equityRiver}%) — недостаточно`);
      if (callEV !== null) details.push(`EV: ${callEV.toFixed(1)} BB (отрицательный)`);
      if (bluffRead && bluffRead.label === 'Вероятно блеф') details.push(`Read: ${bluffRead.label.toLowerCase()} — но математика важнее ощущений`);
    }
  }

  return { action, displayText, color, details, equity: w, potOdds, mdf, handCategory, handName, draws, sizing, ev: evResult, bluffRead };
}
