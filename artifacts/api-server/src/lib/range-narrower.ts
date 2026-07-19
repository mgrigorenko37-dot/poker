/**
 * Villain Range Narrower — Phase 3 + Phase 4 integration
 *
 * Takes the accumulated action log for the current hand and narrows the
 * villain's starting-hand range with each new piece of information.
 *
 * Method: start from a session-profile-adjusted prior (Phase 4), then apply
 * action-based modifiers for each observed action (limp, raise, check/bet on
 * each street). The session stats (VPIP/PFR/AF/CB%/FtCB%) feed directly into:
 *
 *   1. The PRIOR — how wide/tight villain starts before any hand action
 *   2. The POSTFLOP MODIFIER — how much we tighten on a bet vs. a check,
 *      calibrated by whether villain is selective or automatic with their bets
 *
 * This closes the "pipeline gap" where opponent-profile.ts collected stats
 * but never fed them back into the Monte Carlo equity calculation.
 *
 * Sign convention for `threshold`:
 *   Higher threshold → getRangeHandKeys returns FEWER hands → TIGHTER range
 *   Lower threshold  → getRangeHandKeys returns MORE hands  → WIDER range
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
  /**
   * Non-null when the session profile significantly changed the range vs.
   * action-only estimate. Used by Telegram formatter to surface the insight.
   */
  profileNote: string | null;
}

// ── Threshold → range size mapping ───────────────────────────────────────────
//
// getRangeHandKeys(threshold) returns all hands with preflop equity >= threshold,
// plus all pocket pairs. Rough mapping:
//   threshold 65 → ~10-12%  (UTG 5max open)       ← TIGHTEST
//   threshold 60 → ~18-22%
//   threshold 55 → ~28-32%
//   threshold 50 → ~38-42%  ← DEFAULT_VILLAIN_RANGE
//   threshold 46 → ~48-53%
//   threshold 42 → ~57-62%
//   threshold 38 → ~65-70%                         ← WIDEST
//
// HIGHER threshold → FEWER hands → TIGHTER range → hero equity LOWER
// LOWER  threshold → MORE  hands → WIDER  range → hero equity HIGHER

const THRESHOLD_VERY_TIGHT   = 65; // ~10-12%
const THRESHOLD_TIGHT        = 60; // ~18-22%
const THRESHOLD_MEDIUM_TIGHT = 56; // ~26-30%
const THRESHOLD_MEDIUM       = 51; // ~36-42%
const THRESHOLD_MEDIUM_WIDE  = 46; // ~48-53%
const THRESHOLD_WIDE         = 42; // ~57-62%
const THRESHOLD_VERY_WIDE    = 38; // ~65-70%

// ── Session context ───────────────────────────────────────────────────────────

interface SessionContext {
  /** How much to adjust the prior threshold (+= tighter, -= wider) */
  priorAdjust: number;
  /** C-bet frequency 0–100 (high = automatic, low = selective/strong) */
  cbetFreq: number;
  /** Aggression factor (high = polarized bets = tighter range when betting) */
  af: number;
  /** Fold-to-cbet frequency 0–100 (high = check is clearly weak) */
  ftCbet: number;
  /** Average villain bet sizing as fraction of pot (0–1) */
  avgBetFraction: number;
  /** Whether enough hands were observed for reliable stats */
  reliable: boolean;
  handsPlayed: number;
}

function buildSessionContext(): SessionContext {
  const s = getOpponentStats();
  const h = s.handsPlayed;

  const defaults: SessionContext = {
    priorAdjust: 0, cbetFreq: 60, af: 1.5,
    ftCbet: 50, avgBetFraction: 0.55, reliable: false, handsPlayed: 0,
  };
  if (h < 3) return defaults;

  const vpip = (s.vpipHands / h) * 100;
  const pfr  = (s.pfrHands  / h) * 100;
  const af   = s.postflopCalls > 0
    ? s.postflopBets / s.postflopCalls
    : s.postflopBets > 0 ? 5.0 : 1.0;
  const cbet = s.cbetOpportunities > 0
    ? (s.cbetCount / s.cbetOpportunities) * 100 : 60;
  const ftCbet = s.foldToCbetOpportunities > 0
    ? (s.foldToCbetCount / s.foldToCbetOpportunities) * 100 : 50;
  const avgBetFraction = s.betSizings.length > 0
    ? s.betSizings.reduce((a, b) => a + b, 0) / s.betSizings.length : 0.55;

  // ── Prior adjustment from session profile ─────────────────────────────────
  //
  // Positive = tighter prior (higher threshold = fewer hands in MC range)
  // Negative = wider prior
  let priorAdjust = 0;

  // VPIP/PFR: primary signal for pre-action range width
  if (vpip < 15 && pfr >= 10) {
    priorAdjust += 12;                    // super-nit: 10–12% range prior
  } else if (vpip < 22 && pfr >= 14) {
    priorAdjust += 7;                     // TAG: 20–25% range prior
  } else if (vpip > 45 && pfr < 12) {
    priorAdjust -= 10;                    // calling station: 60–65% range prior
  } else if (vpip > 38 && pfr < 18) {
    priorAdjust -= 6;                     // loose passive fish
  } else if (vpip > 30 && pfr > 20) {
    priorAdjust -= 3;                     // LAG: slightly wider prior
  }

  // AF: independent postflop polarization signal
  // High AF → when villain bets, it's more polarized → tighter range
  // Low AF  → passive caller, wide range even when betting
  if (af >= 3.5) priorAdjust += 4;
  else if (af >= 2.5) priorAdjust += 2;
  else if (af <= 0.8) priorAdjust -= 4;
  else if (af <= 1.2) priorAdjust -= 2;

  return { priorAdjust, cbetFreq: cbet, af, ftCbet, avgBetFraction, reliable: true, handsPlayed: h };
}

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

// ── Range state ───────────────────────────────────────────────────────────────

interface RangeState {
  threshold: number;
  dataPoints: number;
  tendencies: string[];
  categories: string[];
}

// ── Preflop ───────────────────────────────────────────────────────────────────

function applyPreflopAction(state: RangeState, action: VillainAction): void {
  const { betToCall, potSize, description } = action;

  if (description.includes('лимп') || (betToCall > 0 && betToCall <= 2.5 && potSize <= 3)) {
    // Limp → wide, passive range; floor at THRESHOLD_WIDE to avoid going too wide
    state.threshold = Math.min(state.threshold, THRESHOLD_WIDE);
    state.tendencies.push('лимп — широкий пассивный диапазон');
    state.categories = ['слабые тузы (Ax)', 'пары любого размера', 'suited connectors', 'бродвей-руки'];
    state.dataPoints++;
    return;
  }

  if (betToCall > 0) {
    const isLargeRaise = betToCall >= 5;
    if (isLargeRaise) {
      // Large 3-bet / 4-bet → very tight: cap threshold at TIGHT level
      state.threshold = Math.max(state.threshold, THRESHOLD_TIGHT);
      state.tendencies.push('крупный рейз — тайт диапазон (QQ+, AK, AQs)');
      state.categories = ['KK+', 'QQ', 'JJ', 'AKs', 'AKo'];
    } else {
      // Standard open raise → medium tight
      state.threshold = Math.max(state.threshold, THRESHOLD_MEDIUM_TIGHT);
      state.tendencies.push('стандартный рейз префлоп');
      state.categories = ['большие пары (TT+)', 'AK/AQ/AJ', 'suited connectors'];
    }
    state.dataPoints++;
  }
}

// ── Postflop ──────────────────────────────────────────────────────────────────

function applyPostflopAction(
  state: RangeState,
  action: VillainAction,
  street: Street,
  ctx: SessionContext,
): void {
  const { betToCall, potSize } = action;

  if (isCheck(action)) {
    // Check → villain is weak/trapping → WIDER range → LOWER threshold
    let widen = 5;
    // If villain folds to c-bets a lot, his check is especially weak (rarely a trap)
    if (ctx.reliable && ctx.ftCbet > 70) widen += 3;
    else if (ctx.reliable && ctx.ftCbet < 30) widen -= 2; // might be slow-playing

    state.threshold -= widen;

    if (street === 'flop') {
      state.tendencies.push(
        ctx.reliable && ctx.ftCbet > 70
          ? `чек на флопе — слабость (FtCB ${Math.round(ctx.ftCbet)}%, он обычно фолдирует)`
          : 'чек на флопе — нет сильных сделанных рук',
      );
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

    if (isBetOverbet(betToCall, potSize)) {
      // Overbet: highly polarized — nuts or total air → tighter to model extremes
      const tighten = 8 + (ctx.reliable && ctx.af >= 3 ? 3 : 0);
      state.threshold += tighten;
      state.tendencies.push(`овербет ${Math.round(betToCall / potSize * 100)}% — поляризован (натс или воздух)`);
      state.categories = ['натс', 'нат-дро', 'тотальный блеф (промах дро)'];

    } else if (isBetLarge(betToCall, potSize)) {
      // Large bet (75%+ pot): value or semi-bluff, reasonably tight
      let tighten = 5;
      if (street === 'flop' && ctx.reliable) {
        if (ctx.cbetFreq > 80) {
          // Automatic C-bettor: large flop bet barely narrows range
          tighten = 1;
          state.tendencies.push(`крупный бет на флопе — авто-cbет (${Math.round(ctx.cbetFreq)}%), диапазон мало сужается`);
        } else if (ctx.cbetFreq < 40) {
          // Selective C-bettor: large flop bet = very strong hand
          tighten = 10;
          state.tendencies.push(`крупный бет на флопе — избирательный cbет (${Math.round(ctx.cbetFreq)}%), сильная рука`);
        } else {
          state.tendencies.push(`крупный бет на флопе — вэлью или полублеф`);
        }
      } else {
        if (street === 'river') {
          state.tendencies.push('крупный бет на ривере — вэлью или блеф');
          state.categories = ['топ-пара+', 'сет', 'блеф (промах флеш/стрит дро)'];
        } else {
          state.tendencies.push(`крупный бет на ${streetRu(street)} — поляризован`);
          state.categories = ['сильная рука', 'нат-дро', 'чек-рейз блеф'];
        }
      }
      // High AF bonus: aggressive players' bets are more polarized → tighter
      if (ctx.reliable && ctx.af >= 3.0) tighten += 3;
      else if (ctx.reliable && ctx.af <= 0.8) tighten -= 2; // passive player: bet = wide

      state.threshold += tighten;

    } else if (isBetSmall(betToCall, potSize)) {
      // Small bet (<35% pot): merged, wide range → WIDER → LOWER threshold
      const widen = ctx.reliable && ctx.af <= 1.0 ? 3 : 1;
      state.threshold -= widen;
      state.tendencies.push(`малый бет на ${streetRu(street)} — мёрдж (вэлью и блеф)`);
      state.categories = ['любые пары', 'дро', 'флоатинг'];

    } else {
      // Medium bet (35–74% pot): standard value/semi-bluff
      let tighten = 3;
      if (ctx.reliable && ctx.cbetFreq < 45 && street === 'flop') tighten += 2;
      if (ctx.reliable && ctx.af >= 2.5) tighten += 1;
      state.threshold += tighten;
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
  if (threshold >= THRESHOLD_VERY_TIGHT)   return ['АА-JJ', 'AK-AQ'];
  if (threshold >= THRESHOLD_TIGHT)        return ['TT+', 'AK', 'AQs', 'KQs'];
  if (threshold >= THRESHOLD_MEDIUM_TIGHT) return ['88+', 'AJ+', 'KQ', 'suited broadways'];
  if (threshold >= THRESHOLD_MEDIUM)       return ['любые пары', 'AJ+', 'KQ', 'suited connectors'];
  if (threshold >= THRESHOLD_MEDIUM_WIDE)  return ['любые пары', 'Ax', 'коннекторы', 'бродвей'];
  return ['слабые тузы', 'малые пары', 'suited connectors', 'разношёрстные руки'];
}

function rangeLabel(pct: number): string {
  if (pct <= 15) return `тайт (≈${pct}% рук)`;
  if (pct <= 28) return `умеренно тайт (≈${pct}% рук)`;
  if (pct <= 42) return `средний (≈${pct}% рук)`;
  if (pct <= 56) return `умеренно широкий (≈${pct}% рук)`;
  return `широкий (≈${pct}% рук)`;
}

// ── Profile influence note ────────────────────────────────────────────────────
//
// When the session profile significantly shifted the range vs. what action
// alone would suggest, we surface a short note for the Telegram formatter.

function buildProfileNote(
  ctx: SessionContext,
  actionBasedThreshold: number,
  finalThreshold: number,
): string | null {
  if (!ctx.reliable || ctx.handsPlayed < 3) return null;

  const delta = finalThreshold - actionBasedThreshold;
  if (Math.abs(delta) < 4) return null; // negligible shift

  const vpip  = 0; // not stored in ctx — we use delta direction instead
  const tighter = delta > 0;

  if (tighter && ctx.cbetFreq < 45) {
    return `Профиль (C-bet ${Math.round(ctx.cbetFreq)}%) → диапазон сужен: его бет = сильная рука`;
  }
  if (tighter && ctx.af >= 3) {
    return `Профиль (AF ${ctx.af.toFixed(1)}) → диапазон сужен: агрессор бетит поляризовано`;
  }
  if (!tighter && ctx.cbetFreq > 80) {
    return `Профиль (C-bet ${Math.round(ctx.cbetFreq)}%) → диапазон расширен: бет часто автоматический`;
  }
  if (!tighter && ctx.ftCbet > 70) {
    return `Профиль (FtCB ${Math.round(ctx.ftCbet)}%) → чек подтверждает слабость`;
  }
  if (tighter) {
    return `Профиль (${ctx.handsPlayed}р) → диапазон тайтовее среднего`;
  }
  return `Профиль (${ctx.handsPlayed}р) → диапазон шире среднего`;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Narrow the villain's range based on all observed actions this hand,
 * seeded by the session-long opponent profile (VPIP/PFR/AF/CB%/FtCB%).
 *
 * @param actions        Full action log from getHandHistory().actions
 * @param currentStreet  Which street we are currently on
 */
export function narrowVillainRange(
  actions: VillainAction[],
  currentStreet: Street | 'waiting' | 'ended',
): NarrowedRange {

  const ctx = buildSessionContext();

  // ── Session-adjusted prior ────────────────────────────────────────────────
  const priorThreshold = Math.max(
    THRESHOLD_VERY_WIDE,
    Math.min(THRESHOLD_VERY_TIGHT, THRESHOLD_MEDIUM + ctx.priorAdjust),
  );

  if (actions.length === 0) {
    const keys = getRangeHandKeys(priorThreshold);
    const pct  = rangeKeysToPct(keys);
    return {
      rangeKeys: keys,
      rangePct: pct,
      description: ctx.reliable
        ? `Нет данных по руке · сессионный профиль: ${rangeLabel(pct)}`
        : 'Диапазон неизвестен — данных нет',
      categories: defaultCategories(priorThreshold),
      confidence: 'low',
      tendencyNote: '',
      profileNote: null,
    };
  }

  // ── Process actions ────────────────────────────────────────────────────────
  const rState: RangeState = {
    threshold: priorThreshold,
    dataPoints: 0,
    tendencies: [],
    categories: [],
  };

  for (const action of actions) {
    if (action.street === 'preflop') {
      applyPreflopAction(rState, action);
    } else {
      applyPostflopAction(rState, action, action.street, ctx);
    }
  }

  // ── Clamp & build output ──────────────────────────────────────────────────
  const threshold = Math.max(
    THRESHOLD_VERY_WIDE,
    Math.min(THRESHOLD_VERY_TIGHT, rState.threshold),
  );

  const keys = getRangeHandKeys(threshold);
  const pct  = rangeKeysToPct(keys);
  const cats = rState.categories.length > 0
    ? rState.categories.slice(0, 4)
    : defaultCategories(threshold);

  const label       = rangeLabel(pct);
  const catsStr     = cats.join(' / ');
  const description = `Скорее всего: ${catsStr} · ${label}`;

  const confidence: 'high' | 'medium' | 'low' =
    rState.dataPoints >= 3 ? 'high' :
    rState.dataPoints >= 1 ? 'medium' : 'low';

  const tendencyNote = rState.tendencies.length > 0
    ? rState.tendencies[rState.tendencies.length - 1]
    : '';

  // Profile note: how much did the session profile shift the range?
  const profileNote = buildProfileNote(ctx, THRESHOLD_MEDIUM, threshold);

  return { rangeKeys: keys, rangePct: pct, description, categories: cats, confidence, tendencyNote, profileNote };
}
