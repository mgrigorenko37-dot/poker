import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateEquity, evaluateHand, parseCard, runMonteCarloSim, type EquityInput } from '../src/index';

const cards = (...values: string[]) => values.map(parseCard);
const base: EquityInput = {
  holeCards: cards('7c', '9h'), boardCards: cards('9c', '4c', '2d', '3d', 'Kd'),
  opponents: [{ holeCards: cards('4s', '4d') }],
};
const seed = (value: number) => () => {
  value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
  return value / 4294967296;
};

test('TON screenshot: pair of nines loses to exposed set of fours', () => {
  const result = calculateEquity(base);
  assert.equal(result.method, 'exact');
  assert.equal(result.total, 1);
  assert.equal(result.equity, 0);
  assert.equal(result.winProb, 0);
  assert.equal(result.tieProb, 0);
  const winner = calculateEquity({ ...base, holeCards: base.opponents[0].holeCards!, opponents: [{ holeCards: base.holeCards }] });
  assert.equal(winner.equity, 1);
});

for (const count of [2, 3, 6, 9]) {
  test(`shared royal flush: equity is 1/${count}, not a win or half of a tie`, () => {
    const result = calculateEquity({
      holeCards: cards('2d', '3c'), boardCards: cards('As', 'Ks', 'Qs', 'Js', 'Ts'),
      opponents: Array.from({ length: count - 1 }, () => ({})), iterations: 100,
    }, seed(100));
    assert.equal(result.winProb, 0);
    assert.equal(result.tieProb, 1);
    assert.ok(Math.abs(result.equity - 1 / count) < 1e-12);
  });
}

test('a player sharing with hero still loses when another opponent beats both', () => {
  const result = calculateEquity({
    holeCards: cards('Ah', 'Qh'), boardCards: cards('Ac', 'Kd', '8c', '7s', '2d'),
    opponents: [{ holeCards: cards('Ad', 'Qs') }, { holeCards: cards('Kh', 'Ks') }],
  });
  assert.equal(result.tieProb, 0);
  assert.equal(result.equity, 0);
});

test('wheel loses to six-high straight and to six-high straight flush', () => {
  for (const suit of ['h', 's']) {
    const wheel = cards(`A${suit}`, `2${suit}`, `3${suit}`, `4${suit}`, `5${suit}`);
    const six = cards(`2${suit}`, `3${suit}`, `4${suit}`, `5${suit}`, `6${suit}`);
    assert.ok(evaluateHand([], wheel)!.score < evaluateHand([], six)!.score);
  }
  assert.ok(evaluateHand([], cards('Ac', '2d', '3h', '4s', '5c'))!.score < evaluateHand([], cards('2c', '3d', '4h', '5s', '6c'))!.score);
});

test('strict card parsing, including 10 aliases', () => {
  assert.deepEqual(parseCard('10H'), parseCard('Th'));
  assert.deepEqual(parseCard('ah'), parseCard('As'.replace('s', 'h')));
  for (const value of ['', '1h', 'Ax', 'ZZ', 'Ahx', '10', null, 42]) {
    assert.throws(() => parseCard(value as string));
  }
});

test('rejects duplicate cards, incomplete boards and missing/invalid opponents', () => {
  for (const input of [
    { ...base, holeCards: cards('9c', '9h') },
    { ...base, deadCards: cards('4s') },
    { ...base, boardCards: cards('9c', '4c') },
    { ...base, opponents: [] },
    { ...base, opponents: Array.from({ length: 9 }, () => ({})) },
    { ...base, opponents: [{ holeCards: cards('As') }] },
    { ...base, iterations: NaN },
    { ...base, iterations: 1.5 },
    { ...base, iterations: 20001 },
  ]) assert.throws(() => calculateEquity(input));
});

test('blocked, malformed and mutually impossible ranges never fall back to random cards', () => {
  for (const rangeKeys of [[], ['ZZ'], ['KAs'], ['AAs']]) {
    assert.throws(() => calculateEquity({ ...base, opponents: [{ rangeKeys }] }));
  }
  assert.throws(() => calculateEquity({ ...base, holeCards: cards('As', 'Ah'), deadCards: cards('Ac'), opponents: [{ rangeKeys: ['AA'] }] }));
  assert.throws(() => calculateEquity({ ...base, holeCards: cards('As', 'Ah'), opponents: [{ rangeKeys: ['AA'] }, { rangeKeys: ['AA'] }], iterations: 1 }, seed(42)), /conflict/);
});

test('river heads-up against a random hand enumerates every possible combination', () => {
  const result = calculateEquity({ ...base, opponents: [{}] });
  assert.equal(result.method, 'exact');
  assert.equal(result.total, 990); // C(45, 2)
  assert.equal(result.errorBound95, 0);
  assert.equal(result.wins + result.ties + result.losses, result.total);
});

test('exact postflop runouts exclude exposed and folded cards', () => {
  const flop = { ...base, boardCards: base.boardCards.slice(0, 3) };
  assert.equal(calculateEquity(flop).total, 990); // 52 - 2 - 3 - 2 = 45
  assert.equal(calculateEquity({ ...flop, deadCards: cards('As', 'Ah') }).total, 903); // C(43,2)
});

test('range blockers are removed before sampling future board cards', () => {
  // Only AdAc is left in AA. Its exact turn-to-river equity provides an oracle.
  const turn = {
    holeCards: cards('Ks', 'Kh'), boardCards: cards('2d', '7c', '9h', 'Tc'),
    deadCards: cards('As', 'Ah'),
  };
  const exact = calculateEquity({ ...turn, opponents: [{ holeCards: cards('Ad', 'Ac') }] });
  const sampled = calculateEquity({ ...turn, opponents: [{ rangeKeys: ['AA'] }], iterations: 5000 }, seed(22));
  assert.equal(sampled.method, 'monte-carlo');
  assert.ok(Math.abs(sampled.equity - exact.equity) < sampled.errorBound95);
  assert.equal(sampled.total, 5000);
});

test('legacy callers receive split-aware equity from the shared engine', () => {
  const result = runMonteCarloSim(cards('2c', '3c'), cards('As', 'Ks', 'Qs', 'Js', 'Ts'), 3, 100);
  assert.ok(Math.abs(result.equity - 1 / 3) < 1e-12);
  assert.equal(result.winProb, 0);
  assert.throws(() => runMonteCarloSim(base.holeCards, [], 2.5));
});
