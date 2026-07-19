/**
 * Hand State Machine  (Phase 1 + Phase 2)
 *
 * Phase 1 — anti-spam:
 *   Fires Telegram only on real game events:
 *     • New hand (hole cards appear / change)
 *     • Street change: preflop → flop → turn → river
 *     • Player folded (hole cards disappear mid-hand)
 *     • Within-street action stable for STABLE_THRESHOLD consecutive scans
 *
 * Phase 2 — action log:
 *   Accumulates villain action per street.
 *   Sources (in priority order):
 *     1. lastAction text read by Gemini from the screen HUD
 *     2. Inferred from betToCall / potSize context
 *   Exports getHandHistory() for the analysis + Telegram formatter.
 *
 * Phase 4 — session opponent profile:
 *   On each new hand, commits the completed hand's action log to opponent-profile.ts
 *   so VPIP/PFR/AF/C-bet stats accumulate across the session.
 */

import { commitHandToProfile, resetOpponentProfile } from './opponent-profile';

export type Street = 'preflop' | 'flop' | 'turn' | 'river';

export type TelegramTrigger =
  | { reason: 'new_hand'; street: 'preflop' }
  | { reason: 'street_change'; street: Street }
  | { reason: 'stable_action_change'; street: Street; action: string }
  | { reason: 'fold' };

// ── Action log types ──────────────────────────────────────────────────────────

export interface VillainAction {
  street: Street;
  /** Human-readable description, e.g. "raised to 12", "bet 60% pot", "checked" */
  description: string;
  potSize: number;
  betToCall: number;
}

export interface HandHistory {
  handId: number;
  holeCards: string[];
  actions: VillainAction[];
  /** Current street */
  street: Street | 'waiting' | 'ended';
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** How many consecutive scans with the same action before we re-send within a street */
const STABLE_THRESHOLD = 3;

// ── Card normalisation ─────────────────────────────────────────────────────────
// OCR may produce "AH" / "ah" / "Ah" — canonicalise to uppercase rank + lowercase suit.

function normaliseCard(raw: string): string | null {
  if (!raw || raw.length < 2) return null;
  const rank = raw.slice(0, -1).toUpperCase();
  const suit  = raw.slice(-1).toLowerCase();
  if (!['h','d','c','s'].includes(suit)) return null;
  if (['X','?','N'].includes(rank)) return null;
  return rank + suit;
}

function normaliseCards(cards: string[]): string[] {
  return cards.map(normaliseCard).filter((c): c is string => c !== null);
}

function cardKey(cards: string[]): string {
  return [...cards].sort().join(',');
}

// ── Villain action inference ──────────────────────────────────────────────────

function inferVillainAction(
  street: Street,
  betToCall: number,
  potSize: number,
  rawText: string | null,
): string {
  // Prefer Gemini-read text when available and sensible
  if (rawText && rawText.trim().length > 2 && rawText.trim().length < 60) {
    return rawText.trim();
  }

  if (street === 'preflop') {
    if (betToCall <= 0) return 'лимп / чек ББ';
    if (potSize > 0) {
      const bbEst = betToCall;
      if (bbEst >= 3) return `рейз до ${betToCall.toFixed(0)}`;
      return `лимп (${betToCall.toFixed(0)})`;
    }
    return `рейз до ${betToCall.toFixed(0)}`;
  }

  // Postflop
  if (betToCall > 0 && potSize > 0) {
    const pct = Math.round((betToCall / potSize) * 100);
    if (pct >= 150) return `овербет ${pct}% пота`;
    if (pct >= 80)  return `бет ${pct}% пота (крупный)`;
    if (pct >= 40)  return `бет ${pct}% пота`;
    return `бет ${pct}% пота (малый)`;
  }
  if (betToCall > 0) return `бет ${betToCall.toFixed(0)}`;
  return 'чек';
}

// ── State ─────────────────────────────────────────────────────────────────────

interface PendingAction {
  action: string;
  count: number;
}

interface HandStateData {
  phase: Street | 'waiting' | 'ended';
  holeKey: string | null;
  holeCards: string[];           // normalised current hole cards
  boardCount: number;
  lastSentAction: string | null;
  pending: PendingAction | null;
  handId: number;
  /** All villain actions recorded for the current hand */
  actionLog: VillainAction[];
  /** Last seen pot/bet (used to avoid duplicate action records per street) */
  lastRecordedStreet: Street | null;
}

const state: HandStateData = {
  phase: 'waiting',
  holeKey: null,
  holeCards: [],
  boardCount: 0,
  lastSentAction: null,
  pending: null,
  handId: 0,
  actionLog: [],
  lastRecordedStreet: null,
};

function boardToStreet(boardCount: number): Street {
  if (boardCount === 0) return 'preflop';
  if (boardCount <= 3) return 'flop';
  if (boardCount === 4) return 'turn';
  return 'river';
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Feed the latest scan result into the state machine.
 * Returns a TelegramTrigger when something noteworthy happened, otherwise null.
 *
 * @param rawHole      Hole cards from Gemini (null = not visible / folded)
 * @param rawBoard     Board cards from Gemini
 * @param action       Recommended action from GTO engine
 * @param potSize      Pot size detected by Gemini
 * @param betToCall    Bet to call detected by Gemini
 * @param lastAction   Raw action text Gemini read from the HUD (may be null)
 */
export function updateHandState(
  rawHole: string[] | null,
  rawBoard: string[],
  action: string,
  potSize = 0,
  betToCall = 0,
  lastAction: string | null = null,
): TelegramTrigger | null {

  const hole = rawHole && rawHole.length === 2 ? normaliseCards(rawHole) : [];
  const board = normaliseCards(rawBoard);

  const haveHole   = hole.length === 2;
  const holeKey    = haveHole ? cardKey(hole) : null;
  const boardCount = board.length;
  const currentStreet = boardToStreet(boardCount);

  // ── No hole cards visible ────────────────────────────────────────────────
  if (!haveHole) {
    const wasInHand = state.phase !== 'waiting' && state.phase !== 'ended';
    if (wasInHand) {
      state.phase = 'ended';
      state.holeKey = null;
      state.holeCards = [];
      state.boardCount = 0;
      state.lastSentAction = null;
      state.pending = null;
      // Keep actionLog for history until next new hand
      return { reason: 'fold' };
    }
    return null;
  }

  // ── New hand ─────────────────────────────────────────────────────────────
  const isNewHand =
    state.phase === 'waiting' ||
    state.phase === 'ended'   ||
    state.holeKey !== holeKey;

  if (isNewHand) {
    // Commit completed hand to session opponent profile before clearing log
    if (state.actionLog.length > 0) {
      commitHandToProfile([...state.actionLog]);
    }

    state.handId += 1;
    state.phase = 'preflop';
    state.holeKey = holeKey;
    state.holeCards = hole;
    state.boardCount = boardCount;
    state.lastSentAction = action;
    state.pending = null;
    state.actionLog = [];
    state.lastRecordedStreet = null;

    // Record preflop action immediately
    _recordAction('preflop', potSize, betToCall, lastAction);

    return { reason: 'new_hand', street: 'preflop' };
  }

  // ── Street change ────────────────────────────────────────────────────────
  const isStreetChange =
    (currentStreet === 'flop'  && state.phase === 'preflop') ||
    (currentStreet === 'turn'  && state.phase === 'flop')    ||
    (currentStreet === 'river' && state.phase === 'turn');

  if (isStreetChange) {
    state.phase = currentStreet;
    state.boardCount = boardCount;
    state.lastSentAction = action;
    state.pending = null;
    state.lastRecordedStreet = null;

    // Record the opening action of this new street
    _recordAction(currentStreet, potSize, betToCall, lastAction);

    return { reason: 'street_change', street: currentStreet };
  }

  // ── Same street: record action if not already done ───────────────────────
  if (state.lastRecordedStreet !== currentStreet && (betToCall > 0 || potSize > 0)) {
    _recordAction(currentStreet, potSize, betToCall, lastAction);
  }

  // ── Same street: debounce action changes ─────────────────────────────────
  if (action === state.lastSentAction) {
    state.pending = null;
    return null;
  }

  if (state.pending?.action === action) {
    state.pending.count += 1;
  } else {
    state.pending = { action, count: 1 };
  }

  if (state.pending.count >= STABLE_THRESHOLD) {
    state.lastSentAction = action;
    state.pending = null;
    return { reason: 'stable_action_change', street: currentStreet, action };
  }

  return null;
}

/** Record a villain action for the current hand (internal) */
function _recordAction(
  street: Street,
  potSize: number,
  betToCall: number,
  rawText: string | null,
): void {
  const description = inferVillainAction(street, betToCall, potSize, rawText);
  state.actionLog.push({ street, description, potSize, betToCall });
  state.lastRecordedStreet = street;
}

/** Get full hand history for current hand — used by analysis + Telegram */
export function getHandHistory(): HandHistory {
  return {
    handId: state.handId,
    holeCards: [...state.holeCards],
    actions: [...state.actionLog],
    street: state.phase,
  };
}

/** Reset fully — call when ScreenScan session starts/stops */
export function resetHandState(): void {
  state.phase = 'waiting';
  state.holeKey = null;
  state.holeCards = [];
  state.boardCount = 0;
  state.lastSentAction = null;
  state.pending = null;
  state.handId = 0;
  state.actionLog = [];
  state.lastRecordedStreet = null;
  // Phase 4: reset session opponent profile too
  resetOpponentProfile();
}

export function getHandState(): Readonly<HandStateData> {
  return { ...state };
}
