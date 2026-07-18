/**
 * GTO Poker Engine — advanced analysis layer
 * Extends base poker.ts with GTO ranges, draw detection, MDF, EV calculations
 */
import {
  type Card, type Suit, type Rank,
  evaluateHand, HandRank, runMonteCarloSim, getPreflopEquity,
  createDeck, RANK_CHARS, PREFLOP_EQUITY, getHandKey,
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
//
// villainAggression (default 1.0) is a per-opponent scaling factor:
//   < 1.0 → passive/station (compress bluff signals, stretch value signals)
//   1.0   → population baseline
//   > 1.0 → hyper-aggressive (amplify bluff signals)
// Applied as: adjusted = 0.5 + (raw - 0.5) * villainAggression
// This keeps the truly ambiguous midpoint (0.5) fixed.
export function getBluffRead(
  betToCall: number,
  potBeforeBet: number,
  boardCards: Card[],
  players: number,
  street: 'flop' | 'turn' | 'river',
  villainAggression: number = 1.0,
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

  // Применяем индивидуальный множитель агрессии виллана.
  // Формула: deviation от нейтральной точки (0.5) масштабируется множителем.
  // Пример: score=0.7, aggression=2.0 → 0.5+(0.7-0.5)*2 = 0.9 (почти точно блеф)
  //          score=0.3, aggression=0.5 → 0.5+(0.3-0.5)*0.5 = 0.4 (слабее вэлью-сигнал)
  const aggrClamp = Math.max(0.2, Math.min(3.0, villainAggression));
  if (aggrClamp !== 1.0) {
    score = 0.5 + (score - 0.5) * aggrClamp;
    score = Math.max(0.05, Math.min(0.95, score));
    if (aggrClamp > 1.0) {
      reasons.push(`Оппонент помечен как агрессивный (×${aggrClamp.toFixed(1)}) — сигналы блефа усилены`);
    } else {
      reasons.push(`Оппонент помечен как пассивный (×${aggrClamp.toFixed(1)}) — сигналы блефа ослаблены`);
    }
  }

  let label: BluffRead['label'];
  if (sizeRatio >= 1.2) label = 'Поляризовано';
  else if (score >= 0.62) label = 'Вероятно блеф';
  else if (score <= 0.4) label = 'Похоже на вэлью';
  else label = 'Неопределённо';

  return { label, score, reasons };
}

// ─── GTO Preflop Ranges (mixed-frequency matrices) ─────────────────────────────
// Real solvers almost never play a hand as a pure 100%/0% raise-or-fold —
// hands at the edge of a range are played as a genuine mix (e.g. "raise 40%
// of the time, fold the rest") to stay balanced. Instead of one flat equity
// threshold per position, every one of the 169 starting hands is ranked by a
// "playability score" and given a smooth frequency ramp around each
// position's target range size, so borderline hands come back with an actual
// mixed strategy rather than a hard cutoff.

// Pairs get a playability bonus over raw preflop equity: their set-mining /
// implied-odds value lets them be opened profitably well below the equity
// non-paired hands would need at the same position.
const PAIR_PLAYABILITY_BONUS = 10;

function getPlayabilityScore(key: string): number {
  const equity = PREFLOP_EQUITY[key] ?? 0;
  const isPair = key.length === 2; // e.g. "AA"
  return isPair ? equity + PAIR_PLAYABILITY_BONUS : equity;
}

const HAND_KEYS_BY_PLAYABILITY: string[] = Object.keys(PREFLOP_EQUITY)
  .sort((a, b) => getPlayabilityScore(b) - getPlayabilityScore(a));

// Percentile rank of each hand key: ~0.6 = the single best hand (AA), 100 = the worst.
const PLAYABILITY_PERCENTILE: Record<string, number> = {};
HAND_KEYS_BY_PLAYABILITY.forEach((key, i) => {
  PLAYABILITY_PERCENTILE[key] = ((i + 1) / HAND_KEYS_BY_PLAYABILITY.length) * 100;
});

// Target RFI opening percentage per position (center of the mixed-frequency
// zone) — same ballpark as 6-max GTO opening frequencies, now driving a ramp
// instead of a hard cutoff.
const RFI_OPEN_PCT: Record<Position, number> = {
  UTG: 15, MP: 19, HJ: 24, CO: 32, BTN: 48, SB: 38, BB: 100, // BB never RFIs preflop
};
const RFI_MIX_BAND = 6; // width (in percentile points) of the mixed-frequency zone

// Fraction (0..1) of the time a solver-shaped strategy raises this hand
// first-in from this position: 1 = always, 0 = never, in-between = a real mix.
function getRFIFrequency(percentile: number, position: Position): number {
  const target = RFI_OPEN_PCT[position];
  const lo = target - RFI_MIX_BAND / 2;
  const hi = target + RFI_MIX_BAND / 2;
  if (percentile <= lo) return 1;
  if (percentile >= hi) return 0;
  return 1 - (percentile - lo) / (hi - lo);
}

// Facing a raise: target value-3bet % and total continuing (3bet + call) %
// per position — rough solver-shaped approximation, each with its own
// mixed-frequency band around the cutoff.
const THREEBET_VALUE_PCT: Record<Position, number> = {
  UTG: 3.5, MP: 4, HJ: 4.5, CO: 5.5, BTN: 7, SB: 6, BB: 6,
};
const CONTINUE_VS_RAISE_PCT: Record<Position, number> = {
  UTG: 12, MP: 15, HJ: 18, CO: 22, BTN: 28, SB: 20, BB: 24,
};
const FACING_RAISE_MIX_BAND = 5;

function getThreeBetFrequency(percentile: number, position: Position): number {
  const target = THREEBET_VALUE_PCT[position];
  const lo = Math.max(0, target - FACING_RAISE_MIX_BAND / 2);
  const hi = target + FACING_RAISE_MIX_BAND / 2;
  if (percentile <= lo) return 1;
  if (percentile >= hi) return 0;
  return 1 - (percentile - lo) / (hi - lo);
}

function getContinueFrequency(percentile: number, position: Position): number {
  const target = CONTINUE_VS_RAISE_PCT[position];
  const lo = Math.max(0, target - FACING_RAISE_MIX_BAND / 2);
  const hi = target + FACING_RAISE_MIX_BAND / 2;
  if (percentile <= lo) return 1;
  if (percentile >= hi) return 0;
  return 1 - (percentile - lo) / (hi - lo);
}

export interface PreflopFrequencies {
  raise: number; // RFI raise, or 3bet (value + light bluff) when facing a raise
  call: number;
  fold: number;
  isMixed: boolean; // true when no single action reaches ~80%+ — a genuine solver-style mix
}

// Core frequency table, keyed by hand string (e.g. "AKs") so it can drive
// both the live advisor and the preflop chart from the same numbers.
export function getPreflopFrequencies(
  handKey: string,
  position: Position,
  facingRaise = false,
  aggressorPosition = '',
): PreflopFrequencies {
  const percentile = PLAYABILITY_PERCENTILE[handKey] ?? 100;
  const isSuited = handKey.endsWith('s');

  if (facingRaise) {
    // When we know who opened, scale our continue range by their range width.
    // Tight opener (UTG 15%) → we need stronger hands → multiplier < 1.
    // Wide opener (BTN 48%) → baseline → multiplier ≈ 1.
    const villainMult = getVillainRangeMultiplier(aggressorPosition);

    const valueThreeBetFreq = getThreeBetFrequency(percentile, position);
    // Adjust raw continue percentile threshold by villain tightness
    const adjustedPercentile = percentile / villainMult;
    const continueFreq = getContinueFrequency(adjustedPercentile, position);
    const callFreq = Math.max(0, continueFreq - valueThreeBetFreq);

    // Light 3bet bluff: suited hands from BTN/CO just past the flat-call
    // range get 3bet a portion of the time instead of an automatic fold —
    // solvers use suited blockers/playability this way to stay balanced.
    let bluffFreq = 0;
    if ((position === 'BTN' || position === 'CO') && isSuited) {
      const callTarget = CONTINUE_VS_RAISE_PCT[position];
      if (percentile > callTarget && percentile <= callTarget + 15) {
        bluffFreq = 0.3 * (1 - (percentile - callTarget) / 15);
      }
    }

    const raise = Math.min(1, valueThreeBetFreq + bluffFreq);
    const fold = Math.max(0, 1 - raise - callFreq);
    const isMixed = Math.max(raise, callFreq, fold) < 0.8;
    return { raise, call: callFreq, fold, isMixed };
  }

  const raise = getRFIFrequency(percentile, position);
  const fold = 1 - raise;
  const isMixed = raise > 0.15 && raise < 0.85;
  return { raise, call: 0, fold, isMixed };
}

// ─── Preflop advice ───────────────────────────────────────────────────────────

export function getGTOPreflopAdvice(
  holeCards: Card[],
  position: Position,
  facingRaise = false,
  stackBBs = 100,
  aggressorPosition = '',
): { action: 'RAISE' | '3BET' | 'CALL' | 'FOLD'; reason: string; strength: string; frequencies: PreflopFrequencies; aggressorNote: string } {
  if (holeCards.length !== 2) {
    return { action: 'FOLD', reason: 'Нет карт', strength: 'Unknown', frequencies: { raise: 0, call: 0, fold: 1, isMixed: false }, aggressorNote: '' };
  }

  const equity = getPreflopEquity(holeCards);
  const key = getHandKey(holeCards[0], holeCards[1]);

  let strength = 'Weak';
  if (equity >= 78) strength = 'Premium';
  else if (equity >= 67) strength = 'Strong';
  else if (equity >= 60) strength = 'Medium';
  else if (equity >= 54) strength = 'Speculative';

  const frequencies = getPreflopFrequencies(key, position, facingRaise, aggressorPosition);

  // Human-readable note about aggressor range when known
  const villainWidth = VILLAIN_OPEN_WIDTH[aggressorPosition];
  const aggressorNote = aggressorPosition && villainWidth
    ? `Агрессор: ${aggressorPosition} (диапазон ~${villainWidth}% рук)`
    : '';
  const mixNote = frequencies.isMixed ? ' — смешанная стратегия, не 100%/0%' : '';

  if (facingRaise) {
    if (frequencies.raise >= frequencies.call && frequencies.raise >= frequencies.fold) {
      return { action: '3BET', reason: `3bet (${equity.toFixed(0)}% equity, солвер: ${(frequencies.raise * 100).toFixed(0)}%)${mixNote}`, strength, frequencies, aggressorNote };
    }
    if (frequencies.call >= frequencies.fold) {
      return { action: 'CALL', reason: `Колл против рейза (${equity.toFixed(0)}% equity, ${position}, солвер: ${(frequencies.call * 100).toFixed(0)}%)${mixNote}`, strength, frequencies, aggressorNote };
    }
    return { action: 'FOLD', reason: `Вне диапазона колла для ${position} против рейза (солвер: fold ${(frequencies.fold * 100).toFixed(0)}%)${mixNote}`, strength, frequencies, aggressorNote };
  }

  if (frequencies.raise >= 0.5) {
    const sizing = stackBBs <= 20 ? 'ALL-IN' : stackBBs <= 40 ? '3BB' : '2.5BB';
    return { action: 'RAISE', reason: `${position} RFI → ${sizing} (${equity.toFixed(0)}% equity, солвер: raise ${(frequencies.raise * 100).toFixed(0)}%)${mixNote}`, strength, frequencies, aggressorNote };
  }
  return { action: 'FOLD', reason: `Вне диапазона открытия для ${position} (солвер: raise только ${(frequencies.raise * 100).toFixed(0)}%)${mixNote}`, strength, frequencies, aggressorNote };
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

// ─── Villain Opening Range Width ─────────────────────────────────────────────
// When we know which position opened/raised, we know roughly how wide their
// range is. A tight opener (UTG 15%) means we need stronger hands to continue
// vs them than against a wide opener (BTN 48%).
const VILLAIN_OPEN_WIDTH: Partial<Record<string, number>> = {
  UTG: 15, MP: 19, HJ: 24, CO: 32, BTN: 48, SB: 38, BB: 100,
};

// Multiplier applied to our continue range vs a known aggressor.
// BTN (wide, 48%) → 1.0 baseline.
// UTG (tight, 15%) → ~0.83 (we fold more vs tight range).
// Formula keeps it linear and clamped to [0.65, 1.15].
function getVillainRangeMultiplier(aggressorPos: string): number {
  const width = VILLAIN_OPEN_WIDTH[aggressorPos];
  if (!width) return 1.0;
  return Math.max(0.65, Math.min(1.15, 0.75 + (width / 48) * 0.25));
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
  villainAggression: number = 1.0,
  aggressorPosition: string = '',
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
    ? getBluffRead(betToCall, potSize, boardCards, players, street, villainAggression)
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
    const preflopAdvice = getGTOPreflopAdvice(holeCards, pos, betToCall > 0, 100, aggressorPosition);

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
    if (preflopAdvice.aggressorNote) details.push(preflopAdvice.aggressorNote);
    if (preflopAdvice.frequencies.isMixed) {
      const f = preflopAdvice.frequencies;
      const parts = [
        f.raise > 0.02 ? `${betToCall > 0 ? '3bet' : 'raise'} ${(f.raise * 100).toFixed(0)}%` : null,
        f.call > 0.02 ? `call ${(f.call * 100).toFixed(0)}%` : null,
        f.fold > 0.02 ? `fold ${(f.fold * 100).toFixed(0)}%` : null,
      ].filter(Boolean);
      details.push(`GTO-микс на границе диапазона: ${parts.join(' / ')}`);
    }
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
    //
    // Modern sizing pattern (Negreanu / solver-derived):
    //   Flop  → small (33% pot): wide range c-bet, low information to villain
    //   Turn  → medium (50-75% pot): narrowing range, build pot
    //   River → binary: overbet (1.5× pot) for polarized / small (25-33% pot) for thin value
    //   Half-pot bets are now rare — players use small OR large, rarely in between.
    const isRiver = street === 'river';
    const isTurn  = street === 'turn';
    const isFlop  = street === 'flop';

    // Polarised river situation: our range is either monster or nothing →
    // overbet maximises EV. Applies when we have a strong made hand on the river.
    const isPolarisedRiver = isRiver && handRank !== null && handRank >= HandRank.FLUSH;

    if (isStrong || w > 0.72) {
      action = 'RAISE'; displayText = 'BET'; color = 'bg-emerald-600';

      if (isPolarisedRiver) {
        // River monster: polarised range → overbet for max value
        sizing = 'OVERBET (1.5× pot)';
        details.push(`Win ${(w * 100).toFixed(0)}% — диапазон поляризован, оверберт`);
        if (handName) details.push(handName);
        details.push('Оверберт: ваш диапазон — монстр или воздух. Слабые руки виллана не могут коллировать, сильные заплатят максимум');
      } else if (isRiver && w > 0.72 && w <= 0.85) {
        // River thin value: small bet — villain calls more often with marginal hands
        sizing = '25% pot';
        details.push(`Win ${(w * 100).toFixed(0)}% — тонкое вэлью на ривере`);
        if (handName) details.push(handName);
        details.push('Маленькая ставка: виллан с маргинальными руками охотнее заколлирует чем большую. Важна дистанция, не один пот');
      } else if (isRiver) {
        // River strong but not monster and not thin: standard value
        sizing = '50% pot';
        details.push(`Win ${(w * 100).toFixed(0)}% — строй пот`);
        if (handName) details.push(handName);
      } else if (isTurn) {
        // Turn: build pot, protect against draws
        sizing = w > 0.80 ? '75% pot' : '50% pot';
        details.push(`Win ${(w * 100).toFixed(0)}% — строй пот, защищай от дро`);
        if (handName) details.push(handName);
      } else {
        // Flop: small c-bet with strong hand (modern standard)
        sizing = '33% pot';
        details.push(`Win ${(w * 100).toFixed(0)}% — строй пот`);
        if (handName) details.push(handName);
        details.push('C-бет 33% — современный стандарт на флопе: широкий диапазон, виллан не может легко определить силу руки');
      }
    } else if (isMedium && w > 0.55) {
      action = 'RAISE'; displayText = 'BET'; color = 'bg-emerald-600';
      if (isRiver) {
        // River medium: very small value bet or check — avoid bloated pot OOP
        sizing = '25% pot';
        details.push(`${handName} (${(w * 100).toFixed(0)}%) — маленькое вэлью на ривере`);
        details.push('25% pot: приглашаем колл от худших рук, не раздуваем пот против монстров');
      } else {
        sizing = '33% pot';
        details.push(`${handName} (${(w * 100).toFixed(0)}%) — защищай небольшой ставкой`);
        if (isFlop) details.push('33% флоп — широкий диапазон, солверный стандарт');
      }
    } else if (hasGoodDraw) {
      // Semi-bluff with draw — size depends on street
      action = 'RAISE'; displayText = 'BET (полублеф)'; color = 'bg-teal-600';
      // Flop: small semi-bluff (33%) — cheap pressure, lots of equity remaining
      // Turn: larger (50%) — fewer cards left, need more fold equity now
      const semiBluffPct = isTurn ? 0.50 : 0.33;
      sizing = isTurn ? '50% pot' : '33% pot';
      details.push(draws!.description);
      details.push(`~${draws!.equityRiverClean}% "чистого" equity на дроу (грязных ${draws!.equityRiver}%) — полублеф`);
      if (isFlop) details.push('33% флоп: дешёвый полублеф — если не пройдёт, остаётся equity; если пройдёт — забираем сейчас');
      if (draws!.antiOutsNote) details.push(draws!.antiOutsNote);
      if (potSize > 0) {
        const betSize = potSize * semiBluffPct;
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
