import { createDeck, evaluateHand, expandRangeToCombos, type Card } from './poker';

export interface OpponentInput {
  /** Empty means hidden cards, not an empty seat. Include only active opponents. */
  holeCards?: Card[];
  /** Uniformly weighted combinations. Omit for a random hand. */
  rangeKeys?: string[];
}

export interface EquityInput {
  holeCards: Card[];
  boardCards: Card[];
  opponents: OpponentInput[];
  /** Exposed cards belonging to players who have folded. */
  deadCards?: Card[];
  iterations?: number;
}

export interface EquityResult {
  wins: number;
  ties: number;
  losses: number;
  total: number;
  winProb: number;
  tieProb: number;
  /** Expected share of a single pot, including multiway splits. */
  equity: number;
  method: 'exact' | 'monte-carlo';
  /** Conservative 95% sampling error bound for equity (not recognition accuracy). */
  errorBound95: number;
}

const cardKey = (c: Card) => `${c.rank}${c.suit}`;

export function validateRangeKeys(keys: string[]): void {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > 169) {
    throw new Error('A range must contain 1–169 starting hands');
  }
  for (const key of keys) {
    if (typeof key !== 'string' || !/^([2-9TJQKA])\1$|^[2-9TJQKA]{2}[so]$/.test(key)) {
      throw new Error(`Invalid range hand: ${String(key)}`);
    }
    if (key.length === 3 && '23456789TJQKA'.indexOf(key[0]) <= '23456789TJQKA'.indexOf(key[1])) {
      throw new Error(`Use the higher rank first in a non-pair range hand: ${key}`);
    }
  }
}

export function validateEquityInput(input: EquityInput): void {
  if (!Array.isArray(input.holeCards) || input.holeCards.length !== 2) {
    throw new Error('Choose exactly two hero cards');
  }
  if (!Array.isArray(input.boardCards) || ![0, 3, 4, 5].includes(input.boardCards.length)) {
    throw new Error('The board must contain 0, 3, 4 or 5 cards');
  }
  if (!Array.isArray(input.opponents) || input.opponents.length < 1 || input.opponents.length > 8) {
    throw new Error('Choose 1–8 active opponents');
  }
  const iterations = input.iterations ?? 5000;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 20000) {
    throw new Error('Iterations must be an integer from 1 to 20000');
  }
  if (input.deadCards !== undefined && !Array.isArray(input.deadCards)) {
    throw new Error('Dead cards must be an array');
  }
  const known = [...input.holeCards, ...input.boardCards, ...(input.deadCards ?? [])];
  for (const opponent of input.opponents) {
    if (!opponent || typeof opponent !== 'object') throw new Error('Invalid opponent');
    const cards = opponent.holeCards ?? [];
    if (!Array.isArray(cards) || ![0, 2].includes(cards.length)) {
      throw new Error('An opponent must have either two exposed cards or hidden cards');
    }
    if (opponent.rangeKeys !== undefined) {
      if (cards.length) throw new Error('Choose exposed cards or a range, not both');
      validateRangeKeys(opponent.rangeKeys);
    }
    known.push(...cards);
  }
  const seen = new Set<string>();
  for (const card of known) {
    if (!card || !Number.isInteger(card.rank) || card.rank < 2 || card.rank > 14 || !['c', 'd', 'h', 's'].includes(card.suit)) {
      throw new Error('Invalid card');
    }
    const key = cardKey(card);
    if (seen.has(key)) throw new Error('The same card cannot occupy two places');
    seen.add(key);
  }
  const hiddenCount = input.opponents.filter(o => !o.holeCards?.length).length;
  if (52 - known.length < hiddenCount * 2 + 5 - input.boardCards.length) {
    throw new Error('Not enough cards left to complete the deal');
  }
}

/** Independent draws from ranges are rejected together on collision. This samples
 * the joint distribution without favouring the opponent dealt first. Opponent
 * cards are chosen BEFORE the runout, so range blockers affect future boards. */
export function calculateEquity(input: EquityInput, random: () => number = Math.random): EquityResult {
  validateEquityInput(input);
  const known = [...input.holeCards, ...input.boardCards, ...(input.deadCards ?? []),
    ...input.opponents.flatMap(o => o.holeCards ?? [])];
  const blocked = new Set(known.map(cardKey));
  const remaining = createDeck().filter(c => !blocked.has(cardKey(c)));
  const pools = input.opponents.map(o => o.rangeKeys ? expandRangeToCombos(o.rangeKeys, known) : null);
  if (pools.some(pool => pool?.length === 0)) throw new Error('An opponent range is blocked by known cards');
  let wins = 0, losses = 0, ties = 0, share = 0, total = 0;

  const record = (board: Card[], opponents: Card[][]) => {
    const heroScore = evaluateHand(input.holeCards, board)!.score;
    let equal = 1;
    let beaten = false;
    for (const cards of opponents) {
      const score = evaluateHand(cards, board)!.score;
      if (score > heroScore) beaten = true;
      if (score === heroScore) equal++;
    }
    total++;
    if (beaten) losses++;
    else {
      if (equal > 1) ties++; else wins++;
      share += 1 / equal;
    }
  };
  const finish = (method: EquityResult['method']): EquityResult => ({
    wins, ties, losses, total, winProb: wins / total, tieProb: ties / total,
    equity: share / total, method,
    errorBound95: method === 'exact' ? 0 : Math.min(1, Math.sqrt(Math.log(40) / (2 * total))),
  });

  // At most C(45,2) runouts when all hands are visible postflop.
  if (input.boardCards.length >= 3 && input.opponents.every(o => o.holeCards?.length === 2)) {
    const hands = input.opponents.map(o => o.holeCards!);
    const missing = 5 - input.boardCards.length;
    if (missing === 0) record(input.boardCards, hands);
    else if (missing === 1) for (const card of remaining) record([...input.boardCards, card], hands);
    else for (let i = 0; i < remaining.length; i++) {
      for (let j = i + 1; j < remaining.length; j++) record([...input.boardCards, remaining[i], remaining[j]], hands);
    }
    return finish('exact');
  }
  if (input.boardCards.length === 5 && input.opponents.length === 1) {
    const pool = pools[0];
    if (pool) for (const pair of pool) record(input.boardCards, [pair]);
    else for (let i = 0; i < remaining.length; i++) {
      for (let j = i + 1; j < remaining.length; j++) record(input.boardCards, [[remaining[i], remaining[j]]]);
    }
    return finish('exact');
  }

  const drawIndex = (length: number) => {
    const r = random();
    if (!Number.isFinite(r) || r < 0 || r >= 1) throw new Error('Random source must return a value in [0, 1)');
    return Math.floor(r * length);
  };
  const iterations = input.iterations ?? 5000;
  let attempts = 0;
  while (total < iterations) {
    if (++attempts > Math.max(10000, iterations * 100)) {
      throw new Error('Opponent ranges conflict too often; widen or correct the ranges');
    }
    const used = new Set<string>();
    const hands: Card[][] = input.opponents.map(o => o.holeCards ?? []);
    let collision = false;
    for (let i = 0; i < pools.length; i++) {
      const pool = pools[i];
      if (!pool) continue;
      const pair = pool[drawIndex(pool.length)];
      for (const card of pair) {
        if (used.has(cardKey(card))) collision = true;
        used.add(cardKey(card));
      }
      hands[i] = pair;
    }
    if (collision) continue;
    const deck = remaining.filter(c => !used.has(cardKey(c)));
    // Partial Fisher–Yates: only shuffle cards actually dealt.
    let cursor = 0;
    const draw = () => {
      const index = cursor + drawIndex(deck.length - cursor);
      [deck[cursor], deck[index]] = [deck[index], deck[cursor]];
      return deck[cursor++];
    };
    for (let i = 0; i < hands.length; i++) if (!hands[i].length) hands[i] = [draw(), draw()];
    const board = [...input.boardCards];
    while (board.length < 5) board.push(draw());
    record(board, hands);
  }
  return finish('monte-carlo');
}
