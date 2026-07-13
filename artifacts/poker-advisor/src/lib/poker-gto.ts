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
  discountedOuts: number;  // "clean" outs after discounting anti-outs (board-pairing risk, low-end straights)
  equityTurn: number;      // rule of 2 (1 card to come) % — raw outs
  equityRiver: number;     // rule of 4 (2 cards to come) % — raw outs
  equityTurnClean: number;   // rule of 2 using discounted outs %
  equityRiverClean: number;  // rule of 4 using discounted outs %
  antiOutsNote: string | null; // explains why outs were discounted, if applicable
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
  usedRangeVsRange: boolean;      // equity sim used a villain range, not "Any Two"
  villainRangePct: number | null; // approx % of hands the villain range covers
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

  // ── Board pairing state (used for anti-outs discounting below) ─────────────
  const boardRankCounts: Record<number, number> = {};
  for (const c of boardCards) boardRankCounts[c.rank] = (boardRankCounts[c.rank] || 0) + 1;
  const boardAlreadyPaired = Object.values(boardRankCounts).some(cnt => cnt >= 2);
  // Weight for an out card of a given rank: cards that pair the board make it
  // much more likely a villain holding trips/two pair improves to a full house
  // (or quads) on the very card we're counting as "our" out.
  function boardPairWeight(rank: number): number {
    if (!boardRankCounts[rank]) return 1.0;       // doesn't touch the board
    return boardAlreadyPaired ? 0 : 0.5;          // board already paired → full-house risk; else moderate risk
  }

  // ── Flush draw ──────────────────────────────────────────────────────────────
  const suitCount: Record<string, number> = {};
  for (const c of allCards) suitCount[c.suit] = (suitCount[c.suit] || 0) + 1;
  const maxSuit = Math.max(...Object.values(suitCount));
  const flushDraw = maxSuit === 4;
  const backdoorFlush = maxSuit === 3;

  const flushSuit = flushDraw
    ? (Object.entries(suitCount).find(([, cnt]) => cnt === 4)?.[0] as Suit | undefined)
    : undefined;

  let flushOutsRaw = 0;
  let flushOutsClean = 0;
  if (flushSuit) {
    const usedRanksOfSuit = new Set(allCards.filter(c => c.suit === flushSuit).map(c => c.rank));
    for (let r = 2; r <= 14; r++) {
      if (usedRanksOfSuit.has(r as Rank)) continue;
      flushOutsRaw += 1;
      flushOutsClean += boardPairWeight(r);
    }
  }

  // ── Straight draw ───────────────────────────────────────────────────────────
  const rankSet = new Set(allCards.map(c => c.rank));
  // Add low ace
  if (rankSet.has(14)) rankSet.add(1 as Rank);
  const ranks = [...rankSet].sort((a, b) => a - b);

  let oesd = false;
  let gutshot = false;
  // Distinct ranks that would complete a straight, tagged with whether they're
  // the "low" end of an open-ended draw (discounted — a villain with two cards
  // above ours completes a bigger straight on the same card).
  const straightOutRanks = new Map<number, { lowEnd: boolean }>();

  for (let lo = 1; lo <= 10; lo++) {
    const hi = lo + 4;
    const inWindow = ranks.filter(r => r >= lo && r <= hi);
    if (inWindow.length === 4) {
      const span = inWindow[inWindow.length - 1] - inWindow[0];
      if (span === 4) {
        // All 4 are consecutive → open-ended (missing 1 end)
        const missingLow  = !rankSet.has(lo as Rank);
        const missingHigh = !rankSet.has(hi as Rank);
        if (missingLow) { oesd = true; straightOutRanks.set(((lo === 0 ? 14 : lo)), { lowEnd: true }); }
        if (missingHigh) { oesd = true; straightOutRanks.set(hi, { lowEnd: false }); }
      } else {
        // Gap in the middle → gutshot
        const missingRank = [lo, lo + 1, lo + 2, lo + 3, hi].find(r => !rankSet.has(r as Rank));
        if (missingRank !== undefined) {
          gutshot = true;
          straightOutRanks.set(missingRank === 0 ? 14 : missingRank, { lowEnd: false });
        }
      }
    }
  }

  let straightOutsRaw = 0;
  let straightOutsClean = 0;
  let discountedLowEnd = false;
  for (const [rank, { lowEnd }] of straightOutRanks) {
    straightOutsRaw += 1;
    let weight = boardPairWeight(rank);
    if (lowEnd) { weight *= 0.85; discountedLowEnd = true; } // nut-low discount
    straightOutsClean += weight;
  }

  // ── Over cards ──────────────────────────────────────────────────────────────
  const maxBoard = Math.max(...boardCards.map(c => c.rank));
  const overCards = holeCards.filter(c => c.rank > maxBoard).length;

  // ── Out count (raw, matches the classic "2 and 4" rule) ────────────────────
  let outs = 0;
  let cleanOuts = 0;
  const descriptions: string[] = [];
  const antiOutsReasons: string[] = [];

  if (flushDraw) {
    outs += flushOutsRaw || 9;
    cleanOuts += flushOutsClean || 9;
    descriptions.push(`Flush draw (${flushOutsRaw || 9} outs)`);
  }
  if (oesd) {
    outs += 8;
    cleanOuts += straightOutsClean || 8;
    descriptions.push('OESD (8 outs)');
  } else if (gutshot) {
    outs += 4;
    cleanOuts += straightOutsClean || 4;
    descriptions.push('Gutshot (4 outs)');
  }

  // Combo draw bonus already counted — cap at real outs
  if (flushDraw && oesd) { outs = 15; cleanOuts = Math.min(cleanOuts, 15); }  // overlap: ~15 unique outs

  // Over cards (if no pair yet) — kept undiscounted, already a rough estimate
  const myHandRank = evaluateHand(holeCards, boardCards)?.handRank ?? -1;
  if (myHandRank < HandRank.PAIR && overCards > 0 && !flushDraw && !oesd && !gutshot) {
    outs += overCards * 3;
    cleanOuts += overCards * 3;
    descriptions.push(`${overCards} overcards (~${overCards * 3} outs)`);
  }

  if (boardAlreadyPaired && (flushOutsRaw > flushOutsClean || straightOutsRaw > straightOutsClean)) {
    antiOutsReasons.push('Борд уже спарен — часть аутов может дать вилланту фулл-хаус, они не считаются');
  } else if (flushOutsRaw > flushOutsClean || straightOutsRaw > straightOutsClean) {
    antiOutsReasons.push('Часть аутов спаривает борд — риск сета/двух пар у виллана, вес снижен');
  }
  if (discountedLowEnd) {
    antiOutsReasons.push('Нижний край стрит-дро дисконтирован — виллан может собрать старший стрейт той же картой');
  }

  const cardsToGo = 5 - boardCards.length;
  const equityTurn   = Math.min(outs * 2, 99);  // rule of 2
  const equityRiver  = Math.min(outs * 4, 99);  // rule of 4
  const equityTurnClean  = Math.min(cleanOuts * 2, 99);
  const equityRiverClean = Math.min(cleanOuts * 4, 99);

  return {
    flushDraw, oesd, gutshot, backdoorFlush,
    overCards,
    comboDraws: flushDraw && (oesd || gutshot),
    totalOuts: outs,
    discountedOuts: Math.round(cleanOuts * 10) / 10,
    equityTurn,
    equityRiver: cardsToGo === 2 ? equityRiver : equityTurn,
    equityTurnClean,
    equityRiverClean: cardsToGo === 2 ? equityRiverClean : equityTurnClean,
    antiOutsNote: antiOutsReasons.length ? antiOutsReasons.join('; ') : null,
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
  foldEquity = 0.3, // estimated % that ALL opponents fold to this raise
): number {
  // EV raise = foldEquity * pot + (1-foldEquity) * [winProb * (pot + raiseSize*2) - raiseSize]
  const evIfCalled = winProb * (potSize + raiseSize * 2) - raiseSize;
  return foldEquity * potSize + (1 - foldEquity) * evIfCalled;
}

// ─── Dynamic Fold Equity ────────────────────────────────────────────────────
// Estimates the probability that ALL opponents fold to a raise/bet, based on
// bet sizing, board wetness, street, and number of opponents — rather than a
// single flat constant. This is still a population-level heuristic (no live
// read on any specific villain), but it captures the big, well-known drivers:
//  - bigger bets relative to the pot fold out more of a range
//  - wet/coordinated boards (flush/straight-possible) give villains more
//    equity to continue with, so they fold less even to big bets
//  - paired boards hit fewer draws, so non-pairs fold more easily
//  - every additional opponent must ALSO fold, so fold equity collapses fast
//    in multiway pots — this is the single biggest factor most heuristics miss
export function estimateFoldEquity(
  potSize: number,
  raiseSize: number,
  boardCards: Card[],
  players: number,
  street: 'preflop' | 'flop' | 'turn' | 'river',
): number {
  let perPlayerFold =
    street === 'preflop' ? 0.45 :
    street === 'flop'    ? 0.42 :
    street === 'turn'    ? 0.34 :
    0.26; // river — villains are pot-committed; folds are rarer but sharper

  // Bigger bets/raises relative to the pot fold out more of a range.
  const sizingRatio = potSize > 0 ? raiseSize / potSize : 0.5;
  perPlayerFold += (sizingRatio - 0.5) * 0.3;

  if (street !== 'preflop' && boardCards.length > 0) {
    const suitCounts: Record<string, number> = {};
    const rankCounts: Record<number, number> = {};
    for (const c of boardCards) {
      suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1;
      rankCounts[c.rank] = (rankCounts[c.rank] || 0) + 1;
    }
    const maxSuit = Math.max(0, ...Object.values(suitCounts));
    const ranks = [...new Set(boardCards.map(c => c.rank))].sort((a, b) => a - b);
    let maxGap = 0;
    for (let i = 1; i < ranks.length; i++) maxGap = Math.max(maxGap, ranks[i] - ranks[i - 1]);
    const isConnected = ranks.length >= 2 && maxGap <= 4;
    const isPaired = Object.values(rankCounts).some(n => n >= 2);

    if (maxSuit >= 3) perPlayerFold -= 0.08;  // flush-possible board
    if (isConnected) perPlayerFold -= 0.05;   // straight-possible/coordinated board
    if (isPaired) perPlayerFold += 0.03;      // paired board hits fewer draws
  }

  perPlayerFold = Math.max(0.1, Math.min(0.75, perPlayerFold));

  // Every opponent still in the hand must ALSO fold for the raise to win it
  // uncontested — this is why bluffs/thin raises get through far less often
  // in multiway pots than heads-up.
  const opponents = Math.max(1, players - 1);
  return Math.pow(perPlayerFold, opponents);
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
    return { action, displayText, color, details, equity: w, potOdds, mdf, handCategory, handName, draws, sizing, ev: evResult, bluffRead, usedRangeVsRange: simResult.usedRangeVsRange, villainRangePct: simResult.villainRangePct };
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
    return { action, displayText, color, details, equity: w, potOdds, mdf, handCategory: preflopAdvice.strength, handName: null, draws: null, sizing, ev: evResult, bluffRead: null, usedRangeVsRange: false, villainRangePct: null };
  }

  // ── POST-FLOP ───────────────────────────────────────────────────────────────
  const hasNoBet = !betToCall || betToCall === 0;
  const drawEquity = draws ? draws.equityRiverClean / 100 : 0; // use "clean" (anti-outs discounted) equity for decisions
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
      details.push(`~${draws!.equityRiverClean}% "чистого" equity на дроу (грязных ${draws!.equityRiver}%) — полублеф`);
      if (draws!.antiOutsNote) details.push(draws!.antiOutsNote);
      if (potSize > 0) {
        const betSize = potSize * 0.5;
        const foldEq = estimateFoldEquity(potSize, betSize, boardCards, players, street);
        const betEV = getRaiseEV(effectiveEquity, potSize, betSize, foldEq);
        details.push(`Фолд-эквити ~${(foldEq * 100).toFixed(0)}% (${players} игрок${players === 2 ? '' : 'ов'}) — EV ставки: ${betEV > 0 ? '+' : ''}${betEV.toFixed(1)} BB`);
      }
    } else if (w > 0.50) {
      action = 'CHECK'; displayText = 'CHECK'; color = 'bg-zinc-600';
      details.push(`Win ${(w * 100).toFixed(0)}% — контролируй пот`);
      if (draws) details.push(`${draws.discountedOuts} чистых outs (из ${draws.totalOuts}), смотри бесплатно`);
    } else {
      action = 'CHECK'; displayText = 'CHECK'; color = 'bg-zinc-700';
      details.push(`Win ${(w * 100).toFixed(0)}% — пасс`);
      if (draws) details.push(draws.description);
    }
  } else {
    // ── Facing a bet ──
    // Dynamic fold equity: how likely ALL opponents fold to a raise here,
    // based on sizing, board texture, street and number of opponents —
    // replaces a flat assumed constant.
    const potAfterBet = potSize + betToCall;
    const raiseIncrement = betToCall * 1.5; // "2.5× bet" total = call (1×) + this increment (1.5×)
    const foldEquity = estimateFoldEquity(potAfterBet, raiseIncrement, boardCards, players, street);
    const raiseEV = getRaiseEV(w, potAfterBet, raiseIncrement, foldEquity);

    const shouldRaise = (
      (handRank !== null && handRank >= HandRank.FLUSH) ||
      (potOdds !== null && w > potOdds + 0.20)
    );
    // Profitable semi-bluff raise: not strong enough by raw equity alone, but
    // the combination of draw equity + fold equity makes raising +EV and
    // better than just calling.
    const isProfitableSemiBluffRaise = (
      !shouldRaise && hasGoodDraw &&
      callEV !== null && raiseEV > callEV && raiseEV > 0
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
      details.push(`Фолд-эквити ~${(foldEquity * 100).toFixed(0)}% (${players} игрок${players === 2 ? '' : 'ов'}) — EV рейза: ${raiseEV > 0 ? '+' : ''}${raiseEV.toFixed(1)} BB`);
      if (bluffRead) details.push(`Read виллана: ${bluffRead.label.toLowerCase()}`);
    } else if (isProfitableSemiBluffRaise) {
      action = 'RAISE'; displayText = 'RAISE (полублеф)'; color = 'bg-teal-600';
      sizing = '2.5× bet';
      details.push(draws!.description);
      details.push(`Фолд-эквити ~${(foldEquity * 100).toFixed(0)}% (${players} игрок${players === 2 ? '' : 'ов'}) + дроу — EV рейза ${raiseEV.toFixed(1)} BB > EV колла ${callEV!.toFixed(1)} BB`);
      if (draws!.antiOutsNote) details.push(draws!.antiOutsNote);
      if (bluffRead) details.push(`Read виллана: ${bluffRead.label.toLowerCase()}`);
    } else if (shouldCall) {
      action = 'CALL'; displayText = 'CALL'; color = 'bg-blue-600';
      details.push(`Win ${(w * 100).toFixed(0)}% > pot odds ${(potOdds! * 100).toFixed(0)}%`);
      if (hasGoodDraw && draws) {
        details.push(`Дроу: ${draws.description} = ${draws.equityRiverClean}% "чистого" equity (грязных ${draws.equityRiver}%)`);
        if (draws.antiOutsNote) details.push(draws.antiOutsNote);
      }
      if (callEV !== null) {
        details.push(`EV колла: ${callEV > 0 ? '+' : ''}${callEV.toFixed(1)} BB`);
      }
      if (mdf) details.push(`MDF: защищаем ${(mdf * 100).toFixed(0)}% диапазона`);
      if (bluffRead) details.push(`Read: ${bluffRead.label.toLowerCase()}`);
    } else {
      action = 'FOLD'; displayText = 'FOLD'; color = 'bg-red-700';
      details.push(`Win ${(w * 100).toFixed(0)}% < pot odds ${potOdds !== null ? (potOdds * 100).toFixed(0) + '%' : '?'}`);
      if (draws) details.push(`Дроу: ${draws.discountedOuts} чистых outs из ${draws.totalOuts} (${draws.equityRiverClean}%) — недостаточно`);
      if (callEV !== null) details.push(`EV: ${callEV.toFixed(1)} BB (отрицательный)`);
      if (bluffRead && bluffRead.label === 'Вероятно блеф') details.push(`Read: ${bluffRead.label.toLowerCase()} — но математика важнее ощущений`);
    }
  }

  return { action, displayText, color, details, equity: w, potOdds, mdf, handCategory, handName, draws, sizing, ev: evResult, bluffRead, usedRangeVsRange: simResult.usedRangeVsRange, villainRangePct: simResult.villainRangePct };
}
