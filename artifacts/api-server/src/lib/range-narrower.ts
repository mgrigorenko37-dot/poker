/**
 * Villain Range Narrower — Phase 3 (Negréanu-style)
 *
 * Takes the accumulated action log for the current hand and narrows the
 * villain's starting-hand range with each new piece of information.
 *
 * Method: start from a position-based prior, then apply modifiers for each
 * observed action (limp, raise, call 3bet, check/bet on each street).
 * The result is:
 *   • rangeKeys  — hand-key array passed to runMonteCarloSim for accurate equity
 *   • description — plain Russian text for Telegram: "скорее всего топ-пара / блеф-мисс"
 *   • categories  — structured list of likely hand types
 *   • confidence  — how much information we have
 *   • tendencyNote — human insight (e.g. "пассивный — лимп-колл стиль")
 *
 * NOT a solver — a well-calibrated heuristic that approximates GTO intuition
 * and expert live-game reads.
 */

import { getRangeHandKeys, rangeKeysToPct } from './poker';
import type { VillainAction, Street } from './hand-state';
import { getOpponentStats } from './opponent-profile';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NarrowedRange {
  /** Hand keys for Monte Carlo (passed as opponentRangeKeys) */
  rangeKeys: string[];
  /** Approximate range width % */
  rangePct: number;
  /** Plain-text description for Telegram */
  description: string;
  /** Structured hand categories */
  categories: string[];
  /** How reliable is this read */
  confidence: 'high' | 'medium' | 'low';
  /** One-line villain tendency */
  tendencyNote: string;
}

// ── Equity threshold → range size mapping ────────────────────────────────────
//
// getRangeHandKeys(threshold) returns all hands with preflop equity >= threshold,
// plus all pocket pairs. Rough mapping:
//   threshold 65 → ~10-12%  (UTG 5max open)
//   threshold 60 → ~18-22%
//   threshold 55 → ~28-32%
//   threshold 50 → ~38-42%  ← DEFAULT_VILLAIN_RANGE
//   threshold 46 → ~48-53%
//   threshold 42 → ~57-62%
//   threshold 38 → ~65-70%

const THRESHOLD_VERY_TIGHT  = 65; // 10-15%
const THRESHOLD_TIGHT       = 60; // 18-22%
const THRESHOLD_MEDIUM_TIGHT = 56; // 26-30%
const THRESHOLD_MEDIUM      = 51; // 36-42%
const THRESHOLD_MEDIUM_WIDE = 46; // 48-53%
const THRESHOLD_WIDE        = 42; // 57-62%
const THRESHOLD_VERY_WIDE   = 38; // 65-70%

// ── Action parsing helpers ────────────────────────────────────────────────────

function isBetLarge(betToCall: number, potSize: number): boolean {
  return potSize > 0 && betToCall / potSize >= 0.75;
}

function isBetSmall(betToCall: number, potSize: number): boolean {
  return potSize > 0 && betToCall / potSize < 0.35;
}

function isBetOverbet(betToCall: number, potSize: number): boolean {
  return potSize > 0 && betToCall / potSize >= 1.5;
}

function isCheck(action: VillainAction): boolean {
  return action.betToCall === 0 || action.description.includes('чек');
}

// ── Street-by-street modifier engine ─────────────────────────────────────────

interface RangeState {
  threshold: number;
  dataPoints: number;           // how many actions we've processed
  tendencies: string[];         // accumulated tendency observations
  categories: string[];         // likely hand types at this point
}

function applyPreflopAction(state: RangeState, action: VillainAction): void {
  const { betToCall, potSize, description } = action;

  // Limp (≈ no raise, just called the BB)
  if (description.includes('лимп') || (betToCall > 0 && betToCall <= 2.5 && potSize <= 3)) {
    state.threshold = Math.max(state.threshold, THRESHOLD_WIDE); // wide, passive
    state.tendencies.push('лимп — широкий пассивный диапазон');
    state.categories = ['слабые тузы (Ax)', 'пары любого размера', 'suited connectors', 'бродвей-руки'];
    state.dataPoints++;
    return;
  }

  // Raise: estimate range width from bet size vs pot
  if (betToCall > 0) {
    const isLargeRaise = betToCall >= 5;
    if (isLargeRaise) {
      // Large 3-bet or 4-bet → very tight
      state.threshold = Math.min(state.threshold, THRESHOLD_TIGHT);
      state.tendencies.push('крупный рейз — тайт диапазон (QQ+, AK, AQs)');
      state.categories = ['KK+', 'QQ', 'JJ', 'AKs', 'AKo'];
    } else {
      // Standard open raise
      state.threshold = Math.min(state.threshold, THRESHOLD_MEDIUM);
      state.tendencies.push('стандартный рейз префлоп');
      state.categories = ['большие пары (TT+)', 'AK/AQ/AJ', 'suited connectors'];
    }
    state.dataPoints++;
  }
}

function applyPostflopAction(state: RangeState, action: VillainAction, street: Street): void {
  const { betToCall, potSize } = action;

  if (isCheck(action)) {
    // Checked → removes the strongest made hands (mostly)
    state.threshold += 6;   // widen — weaker hands check more often
    if (street === 'flop') {
      state.tendencies.push('чек на флопе — нет сильных сделанных рук');
      state.categories = state.categories.length
        ? state.categories
        : ['слабые пары', 'дро (флеш/стрит)', 'воздух (пропустил флоп)'];
    } else if (street === 'turn') {
      state.tendencies.push('чек на тёрне — пот-контроль или слабость');
    } else {
      state.tendencies.push('чек на ривере — блеф сдался или шоудаун-велью');
      state.categories = state.categories.length
        ? state.categories
        : ['средняя пара', 'слабый топ-пэр', 'пропущенный дро'];
    }
  } else if (betToCall > 0) {
    // Bet — value or bluff
    if (isBetOverbet(betToCall, potSize)) {
      // Overbet: highly polarized — nuts or total air
      state.threshold -= 10;
      state.tendencies.push(`овербет ${Math.round(betToCall/potSize*100)}% — поляризован (натс или воздух)`);
      state.categories = ['натс', 'нат-дро', 'тотальный блеф (промах дро)'];
    } else if (isBetLarge(betToCall, potSize)) {
      // Large bet: polarized but not as extreme
      state.threshold -= 6;
      if (street === 'river') {
        state.tendencies.push(`крупный бет на ривере — вэлью или блеф`);
        state.categories = ['топ-пара+', 'сет', 'блеф (промах флеш/стрит дро)'];
      } else {
        state.tendencies.push(`крупный бет на ${streetRu(street)} — поляризован`);
        state.categories = ['сильная рука', 'нат-дро', 'чек-рейз блеф'];
      }
    } else if (isBetSmall(betToCall, potSize)) {
      // Small bet: merged, wide range
      state.threshold += 2;
      state.tendencies.push(`малый бет на ${streetRu(street)} — мёрдж (вэлью и блеф)`);
      state.categories = ['любые пары', 'дро', 'флоатинг'];
    } else {
      // Medium bet (35-74% pot): standard value/semi-bluff
      state.threshold -= 3;
      state.tendencies.push(`стандартный бет на ${streetRu(street)} — вэлью или полублеф`);
      if (state.categories.length === 0) {
        state.categories = ['топ-пара', 'оверпара', 'флеш-дро', 'стрит-дро'];
      }
    }
  }

  state.dataPoints++;
}

function streetRu(s: Street): string {
  return { preflop: 'префлопе', flop: 'флопе', turn: 'тёрне', river: 'ривере' }[s] ?? s;
}

// ── Category labels based on final threshold ──────────────────────────────────

function defaultCategories(threshold: number): string[] {
  if (threshold <= THRESHOLD_VERY_TIGHT) return ['АА-JJ', 'AK-AQ'];
  if (threshold <= THRESHOLD_TIGHT)      return ['TT+', 'AK', 'AQs', 'KQs'];
  if (threshold <= THRESHOLD_MEDIUM_TIGHT) return ['88+', 'AJ+', 'KQ', 'suited broadways'];
  if (threshold <= THRESHOLD_MEDIUM)     return ['любые пары', 'AJ+', 'KQ', 'suited connectors'];
  if (threshold <= THRESHOLD_MEDIUM_WIDE) return ['любые пары', 'Ax', 'коннекторы', 'бродвей'];
  return ['слабые тузы', 'малые пары', 'suited connectors', 'разношёрстные руки'];
}

function rangeLabel(threshold: number, rangePct: number): string {
  if (rangePct <= 15) return `тайт (≈${rangePct}% рук)`;
  if (rangePct <= 28) return `умеренно тайт (≈${rangePct}% рук)`;
  if (rangePct <= 42) return `средний (≈${rangePct}% рук)`;
  if (rangePct <= 56) return `умеренно широкий (≈${rangePct}% рук)`;
  return `широкий (≈${rangePct}% рук)`;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Narrow the villain's range based on all observed actions this hand.
 *
 * @param actions     Full action log from getHandHistory().actions
 * @param currentStreet  Which street we are currently on
 */
export function narrowVillainRange(
  actions: VillainAction[],
  currentStreet: Street | 'waiting' | 'ended',
): NarrowedRange {

  // ── Phase 4: pull session VPIP/PFR to seed the prior ─────────────────────
  const sessionStats = getOpponentStats();
  let sessionAdjust = 0; // equity threshold modifier from session data
  if (sessionStats.handsPlayed >= 5) {
    const vpip = (sessionStats.vpipHands / sessionStats.handsPlayed) * 100;
    const pfr  = (sessionStats.pfrHands  / sessionStats.handsPlayed) * 100;
    // Tight player (VPIP<20, PFR>12) → narrower range → higher threshold
    if (vpip < 20 && pfr > 12)  sessionAdjust = -6;
    // Loose passive (VPIP>45, PFR<15) → wider range → lower threshold
    else if (vpip > 45 && pfr < 15) sessionAdjust = +8;
    // Loose aggro (VPIP>30, PFR>20) → medium-wide
    else if (vpip > 30 && pfr > 20) sessionAdjust = +3;
  }

  if (actions.length === 0) {
    // No hand actions yet — use session-adjusted prior
    const baseThreshold = Math.max(THRESHOLD_VERY_WIDE,
      Math.min(THRESHOLD_VERY_TIGHT, THRESHOLD_MEDIUM + sessionAdjust));
    const keys = getRangeHandKeys(baseThreshold);
    const pct  = rangeKeysToPct(keys);
    return {
      rangeKeys: keys,
      rangePct: pct,
      description: sessionStats.handsPlayed >= 5
        ? `Нет данных по руке · сессионный профиль: ${rangeLabel(baseThreshold, pct)}`
        : 'Диапазон неизвестен — данных нет',
      categories: defaultCategories(baseThreshold),
      confidence: 'low',
      tendencyNote: '',
    };
  }

  // Start from session-adjusted prior
  const rState: RangeState = {
    threshold: THRESHOLD_MEDIUM + sessionAdjust,
    dataPoints: 0,
    tendencies: [],
    categories: [],
  };

  // Process each recorded action in street order
  for (const action of actions) {
    if (action.street === 'preflop') {
      applyPreflopAction(rState, action);
    } else {
      applyPostflopAction(rState, action, action.street);
    }
  }

  // Clamp threshold to valid range
  const threshold = Math.max(THRESHOLD_VERY_WIDE, Math.min(THRESHOLD_VERY_TIGHT, rState.threshold));

  const keys    = getRangeHandKeys(threshold);
  const pct     = rangeKeysToPct(keys);
  const cats    = rState.categories.length > 0
    ? rState.categories.slice(0, 4)
    : defaultCategories(threshold);

  // Build Telegram description
  const label = rangeLabel(threshold, pct);
  const catsStr = cats.join(' / ');
  const description = `Скорее всего: ${catsStr} · ${label}`;

  // Confidence based on how many data points we have
  const confidence: 'high' | 'medium' | 'low' =
    rState.dataPoints >= 3 ? 'high' :
    rState.dataPoints >= 1 ? 'medium' : 'low';

  // Tendency summary
  const tendencyNote = rState.tendencies.length > 0
    ? rState.tendencies[rState.tendencies.length - 1] // most recent / most relevant
    : '';

  return { rangeKeys: keys, rangePct: pct, description, categories: cats, confidence, tendencyNote };
}
