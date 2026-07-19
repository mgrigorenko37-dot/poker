/**
 * Opponent Profile — Phase 4 (Session HUD)
 *
 * Accumulates per-session statistics about the villain from the action log
 * committed at the end of each hand. Works like a lightweight HUD:
 *
 *   VPIP  — % hands villain entered the pot voluntarily
 *   PFR   — % hands villain raised preflop
 *   AF    — postflop aggression factor (bets+raises / calls)
 *   CB%   — c-bet frequency (bet flop after raising preflop)
 *   FtCB  — fold-to-c-bet frequency
 *
 * The profile persists for the full ScreenScan session and resets with
 * resetHandState() (POST /api/vision/reset).
 *
 * Minimum hands before stats are considered reliable: MIN_HANDS_RELIABLE.
 * Below that threshold, confidence = 'low' and we don't show numbers in Telegram.
 */

import type { VillainAction, Street } from './hand-state';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Below this, stats are shown but marked as preliminary */
const MIN_HANDS_RELIABLE = 8;
/** Below this, don't show stats at all */
const MIN_HANDS_DISPLAY  = 3;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OpponentStats {
  handsPlayed: number;

  // Preflop
  vpipHands:  number;   // entered pot
  pfrHands:   number;   // raised preflop

  // Postflop
  cbetOpportunities: number;
  cbetCount:         number;
  foldToCbetOpportunities: number;
  foldToCbetCount:         number;

  // Aggression
  postflopBets:  number;
  postflopCalls: number;

  // Bet sizing sample
  betSizings: number[];  // bet/pot ratios collected this session
}

export interface OpponentSummary {
  handsPlayed: number;
  vpip:  number;   // 0–100
  pfr:   number;   // 0–100
  af:    number;   // aggression factor
  cbet:  number;   // 0–100
  ftCbet: number;  // 0–100
  avgBetPct: number;  // average bet as % of pot
  confidence: 'high' | 'medium' | 'low';
  /** Player type label */
  playerType: string;
  /** One-line exploit note */
  exploitNote: string;
}

// ── State ─────────────────────────────────────────────────────────────────────

const _stats: OpponentStats = {
  handsPlayed: 0,
  vpipHands: 0,
  pfrHands: 0,
  cbetOpportunities: 0,
  cbetCount: 0,
  foldToCbetOpportunities: 0,
  foldToCbetCount: 0,
  postflopBets: 0,
  postflopCalls: 0,
  betSizings: [],
};

// ── Hand commitment ───────────────────────────────────────────────────────────

/**
 * Called by hand-state.ts at the start of each new hand (previous hand ended).
 * Analyses the completed hand's action log and feeds it into the session stats.
 */
export function commitHandToProfile(actions: VillainAction[]): void {
  if (actions.length === 0) return;

  _stats.handsPlayed++;

  const preflopActions = actions.filter(a => a.street === 'preflop');
  const postflopActions = actions.filter(a => a.street !== 'preflop');

  // ── VPIP: villain did anything other than fold preflop ────────────────────
  const didVPIP = preflopActions.some(a => a.betToCall > 0 || a.description.includes('лимп'));
  if (didVPIP) _stats.vpipHands++;

  // ── PFR: villain raised preflop ───────────────────────────────────────────
  const didPFR = preflopActions.some(
    a => a.betToCall > 0 && (a.description.includes('рейз') || a.betToCall >= 3)
  );
  if (didPFR) _stats.pfrHands++;

  // ── C-bet: villain raised preflop and then bet the flop ───────────────────
  if (didPFR) {
    _stats.cbetOpportunities++;
    const flopBet = actions.find(a => a.street === 'flop' && a.betToCall > 0);
    if (flopBet) _stats.cbetCount++;
  }

  // ── Fold to c-bet: villain called preflop raise then folded flop ──────────
  // We detect this indirectly: if villain called preflop and the flop has no action recorded
  // from villain (i.e., they checked/folded = no postflop action) we count it.
  // Better heuristic: if preflop was a call (not raise) and there's no flop action from villain.
  const didCallPreflop = preflopActions.some(
    a => a.betToCall > 0 && !a.description.includes('рейз')
  );
  if (didCallPreflop) {
    _stats.foldToCbetOpportunities++;
    const flopAction = actions.find(a => a.street === 'flop');
    // If flop action exists and it's a check/fold, count as fold-to-cbet
    if (!flopAction || flopAction.betToCall === 0) {
      _stats.foldToCbetCount++;
    }
  }

  // ── Postflop aggression factor ────────────────────────────────────────────
  for (const a of postflopActions) {
    if (a.betToCall > 0) {
      _stats.postflopBets++;
      // Collect bet sizing
      if (a.potSize > 0) {
        _stats.betSizings.push(Math.min(3, a.betToCall / a.potSize));
      }
    } else {
      _stats.postflopCalls++;
    }
  }
}

// ── Stats computation ─────────────────────────────────────────────────────────

export function getOpponentSummary(): OpponentSummary | null {
  if (_stats.handsPlayed < MIN_HANDS_DISPLAY) return null;

  const h = _stats.handsPlayed;
  const vpip  = Math.round((_stats.vpipHands  / h) * 100);
  const pfr   = Math.round((_stats.pfrHands   / h) * 100);
  const cbet  = _stats.cbetOpportunities > 0
    ? Math.round((_stats.cbetCount / _stats.cbetOpportunities) * 100)
    : 0;
  const ftCbet = _stats.foldToCbetOpportunities > 0
    ? Math.round((_stats.foldToCbetCount / _stats.foldToCbetOpportunities) * 100)
    : 0;
  const af = _stats.postflopCalls > 0
    ? Math.round((_stats.postflopBets / _stats.postflopCalls) * 10) / 10
    : _stats.postflopBets > 0 ? 5.0 : 1.0;

  const avgBetPct = _stats.betSizings.length > 0
    ? Math.round(
        (_stats.betSizings.reduce((s, v) => s + v, 0) / _stats.betSizings.length) * 100
      )
    : 50;

  const confidence: 'high' | 'medium' | 'low' =
    h >= MIN_HANDS_RELIABLE ? 'high' :
    h >= MIN_HANDS_DISPLAY  ? 'medium' : 'low';

  const { playerType, exploitNote } = classifyPlayer(vpip, pfr, af, cbet, ftCbet);

  return { handsPlayed: h, vpip, pfr, af, cbet, ftCbet, avgBetPct, confidence, playerType, exploitNote };
}

/** Raw stats for range-narrower adjustments */
export function getOpponentStats(): Readonly<OpponentStats> {
  return { ..._stats };
}

/** Reset on new session */
export function resetOpponentProfile(): void {
  _stats.handsPlayed = 0;
  _stats.vpipHands = 0;
  _stats.pfrHands = 0;
  _stats.cbetOpportunities = 0;
  _stats.cbetCount = 0;
  _stats.foldToCbetOpportunities = 0;
  _stats.foldToCbetCount = 0;
  _stats.postflopBets = 0;
  _stats.postflopCalls = 0;
  _stats.betSizings = [];
}

// ── Player classification ─────────────────────────────────────────────────────

interface Classification {
  playerType: string;
  exploitNote: string;
}

function classifyPlayer(
  vpip: number, pfr: number, af: number, cbet: number, ftCbet: number
): Classification {
  const gap = vpip - pfr; // VPIP–PFR gap: large = limp-caller, small = tight/aggro

  // ── Tight-Aggressive (TAG) ────────────────────────────────────────────────
  if (vpip <= 22 && pfr >= 14 && af >= 2.0) {
    return {
      playerType: 'TAG (tight-aggressive)',
      exploitNote: 'Его рейз = сила. Фолдуй маргинальные руки. Его чек = слабость — атакуй.',
    };
  }

  // ── Loose-Aggressive (LAG) ────────────────────────────────────────────────
  if (vpip >= 30 && pfr >= 20 && af >= 2.5) {
    return {
      playerType: 'LAG (loose-aggressive)',
      exploitNote: 'Широкий и агрессивный. Трап сильными руками. Не блефуй — он коллирует.',
    };
  }

  // ── Calling Station ───────────────────────────────────────────────────────
  if (vpip >= 40 && af <= 1.2) {
    return {
      playerType: 'Колл-стейшн (пассивный рыба)',
      exploitNote: 'Никогда не блефуй. Максимальный тонкий вэлью — он будет коллировать слабыми руками.',
    };
  }

  // ── Nit ───────────────────────────────────────────────────────────────────
  if (vpip <= 14 && pfr >= 10) {
    return {
      playerType: 'Нит (super-tight)',
      exploitNote: 'Его рейз = топ-5% рук. Складывай всё кроме нат-хендов. Его лимп — слабость, стилуй.',
    };
  }

  // ── Passive fish (limp-caller) ────────────────────────────────────────────
  if (vpip >= 35 && gap >= 20 && af <= 1.5) {
    return {
      playerType: 'Лимп-коллер (пассивный)',
      exploitNote: 'Бет для вэлью любой парой+. Его рейз = очень сильная рука. Не блефуй.',
    };
  }

  // ── Tight-passive (rock) ──────────────────────────────────────────────────
  if (vpip <= 20 && af <= 1.2) {
    return {
      playerType: 'Тайт-пассивный (рок)',
      exploitNote: 'Стилуй его часто — он фолдирует. Когда он бетит — фолдуй без топ-пары+.',
    };
  }

  // ── Loose-passive ─────────────────────────────────────────────────────────
  if (vpip >= 30 && af <= 1.5) {
    return {
      playerType: 'Лус-пассивный',
      exploitNote: 'Вэлью-бет на всех трёх улицах. Его чек-рейз = натс, фолдуй.',
    };
  }

  // ── Default ───────────────────────────────────────────────────────────────
  return {
    playerType: 'Средний рег',
    exploitNote: ftCbet >= 60
      ? 'Много фолдирует на флопе — часто блефуй C-bet'
      : cbet >= 80
      ? 'Авто-C-bet: флоат флоп, атакуй терн'
      : 'Играй стандартно, продолжай собирать данные.',
  };
}
