import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_HAND } from '../src/lib/demo-hand';
import { calculateEquity, parseCard, validateEquityInput } from '../../../lib/poker-engine/src';

const inputFor = (frame: typeof DEMO_HAND[number]) => ({
  holeCards: frame.holeCards.map(parseCard), boardCards: frame.boardCards.map(parseCard),
  opponents: frame.opponents.filter(s => s.active).map(s => ({ holeCards: s.cards.map(parseCard) })),
});

test('synthetic frames distinguish legal states from incomplete/dealt-away cards', () => {
  assert.equal(new Set(DEMO_HAND.map(f => f.id)).size, DEMO_HAND.length);
  for (const frame of DEMO_HAND) {
    if (frame.calculable) assert.doesNotThrow(() => validateEquityInput(inputFor(frame)), frame.id);
    else assert.throws(() => validateEquityInput(inputFor(frame)), undefined, frame.id);
  }
});

test('fold removes an opponent without changing known cards or exposing hidden ones', () => {
  const before = DEMO_HAND.find(f => f.id === 'flop')!;
  const after = DEMO_HAND.find(f => f.id === 'fold')!;
  assert.deepEqual(before.boardCards, after.boardCards);
  assert.deepEqual(before.holeCards, after.holeCards);
  assert.equal(before.opponents.filter(s => s.active).length, 2);
  assert.equal(after.opponents.filter(s => s.active).length, 1);
  assert.ok(after.opponents.every(s => s.cards.length === 0));
});

test('showdown substitutes exposed cards for uncertainty and gives an exact loss', () => {
  const result = calculateEquity(inputFor(DEMO_HAND.find(f => f.id === 'showdown')!));
  assert.equal(result.method, 'exact');
  assert.equal(result.total, 1);
  assert.equal(result.equity, 0);
  assert.equal(result.winProb, 0);
  assert.equal(result.tieProb, 0);
});
