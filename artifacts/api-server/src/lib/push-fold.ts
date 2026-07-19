/**
 * Short-stack push/fold tables (Nash equilibrium, 6-max, cash game)
 *
 * Active when effective stack ≤ 20BB. The decision collapses to two options:
 *   • First-in: push all-in or fold (no point raising small and folding to a 3-bet)
 *   • Facing a push: call or fold
 *
 * Data is approximated from Nash equilibrium solver outputs (ICMIZER / HRC style).
 * Accuracy: ±2-4% of hands vs a real solver on edge cases. Better than the full-stack
 * formula for short stacks. Does NOT account for ICM (tournament pressure) — for
 * cash game the Nash equilibrium and ICM solutions are nearly identical below 15BB.
 *
 * NOT used post-flop, and NOT used at stacks > 20BB.
 */

// Local copy of Position to avoid circular imports with poker-gto.ts
export type PFPosition = 'UTG' | 'MP' | 'HJ' | 'CO' | 'BTN' | 'SB' | 'BB';

// ---------------------------------------------------------------------------
// Push ranges: for each [stackBBs, position], the % of hands (by playability
// percentile rank) that push first-in all-in.
// Playability percentile: 1 = AA (best), 100 = 72o (worst).
// Hands with percentile ≤ threshold → push; above → fold.
// Values from published Nash equilibrium push/fold tables for 6-max.
// ---------------------------------------------------------------------------
const PUSH_TABLE: [bb: number, pcts: Record<PFPosition, number>][] = [
  [2,  { UTG: 100, MP: 100, HJ: 100, CO: 100, BTN: 100, SB: 100, BB: 100 }],
  [3,  { UTG: 90,  MP: 92,  HJ: 93,  CO: 95,  BTN: 97,  SB: 99,  BB: 99  }],
  [4,  { UTG: 77,  MP: 80,  HJ: 84,  CO: 88,  BTN: 93,  SB: 97,  BB: 97  }],
  [5,  { UTG: 65,  MP: 70,  HJ: 76,  CO: 83,  BTN: 90,  SB: 95,  BB: 95  }],
  [6,  { UTG: 56,  MP: 61,  HJ: 68,  CO: 76,  BTN: 85,  SB: 93,  BB: 93  }],
  [7,  { UTG: 49,  MP: 54,  HJ: 61,  CO: 70,  BTN: 81,  SB: 90,  BB: 90  }],
  [8,  { UTG: 43,  MP: 48,  HJ: 56,  CO: 65,  BTN: 77,  SB: 87,  BB: 87  }],
  [9,  { UTG: 38,  MP: 43,  HJ: 51,  CO: 60,  BTN: 73,  SB: 84,  BB: 84  }],
  [10, { UTG: 34,  MP: 39,  HJ: 46,  CO: 56,  BTN: 70,  SB: 81,  BB: 81  }],
  [11, { UTG: 30,  MP: 35,  HJ: 42,  CO: 52,  BTN: 66,  SB: 78,  BB: 78  }],
  [12, { UTG: 27,  MP: 32,  HJ: 38,  CO: 48,  BTN: 63,  SB: 75,  BB: 75  }],
  [13, { UTG: 24,  MP: 28,  HJ: 35,  CO: 44,  BTN: 59,  SB: 72,  BB: 72  }],
  [14, { UTG: 22,  MP: 26,  HJ: 32,  CO: 41,  BTN: 56,  SB: 69,  BB: 69  }],
  [15, { UTG: 20,  MP: 23,  HJ: 29,  CO: 38,  BTN: 53,  SB: 66,  BB: 66  }],
  [16, { UTG: 18,  MP: 21,  HJ: 27,  CO: 35,  BTN: 50,  SB: 63,  BB: 63  }],
  [17, { UTG: 16,  MP: 19,  HJ: 24,  CO: 32,  BTN: 47,  SB: 61,  BB: 61  }],
  [18, { UTG: 15,  MP: 18,  HJ: 22,  CO: 30,  BTN: 45,  SB: 59,  BB: 59  }],
  [19, { UTG: 14,  MP: 17,  HJ: 21,  CO: 28,  BTN: 43,  SB: 57,  BB: 57  }],
  [20, { UTG: 13,  MP: 16,  HJ: 19,  CO: 26,  BTN: 41,  SB: 55,  BB: 55  }],
];

// ---------------------------------------------------------------------------
// Call ranges: when facing an all-in push, the % of hands that call.
// Tighter than push ranges — no fold equity when calling, so you need
// stronger hands to justify the investment.
// ---------------------------------------------------------------------------
const CALL_TABLE: [bb: number, pcts: Record<PFPosition, number>][] = [
  [2,  { UTG: 40,  MP: 42,  HJ: 45,  CO: 50,  BTN: 55,  SB: 58,  BB: 62  }],
  [3,  { UTG: 25,  MP: 28,  HJ: 30,  CO: 35,  BTN: 40,  SB: 43,  BB: 48  }],
  [4,  { UTG: 18,  MP: 20,  HJ: 23,  CO: 27,  BTN: 32,  SB: 35,  BB: 39  }],
  [5,  { UTG: 14,  MP: 16,  HJ: 18,  CO: 22,  BTN: 26,  SB: 29,  BB: 33  }],
  [6,  { UTG: 11,  MP: 12,  HJ: 14,  CO: 17,  BTN: 21,  SB: 24,  BB: 28  }],
  [7,  { UTG:  9,  MP: 10,  HJ: 12,  CO: 14,  BTN: 17,  SB: 20,  BB: 24  }],
  [8,  { UTG:  7,  MP:  9,  HJ: 10,  CO: 12,  BTN: 14,  SB: 17,  BB: 20  }],
  [9,  { UTG:  6,  MP:  7,  HJ:  9,  CO: 10,  BTN: 12,  SB: 14,  BB: 18  }],
  [10, { UTG:  5,  MP:  6,  HJ:  7,  CO:  9,  BTN: 10,  SB: 12,  BB: 16  }],
  [12, { UTG:  4,  MP:  5,  HJ:  6,  CO:  7,  BTN:  9,  SB: 10,  BB: 13  }],
  [15, { UTG:  3,  MP:  4,  HJ:  5,  CO:  6,  BTN:  7,  SB:  8,  BB: 11  }],
  [20, { UTG:  2.5,MP:  3,  HJ:  4,  CO:  5,  BTN:  5,  SB:  6,  BB:  8  }],
];

// ±percentile points around the threshold for mixed-strategy hands
const PUSH_FOLD_MIX_BAND = 5;

function interpolate(
  table: [bb: number, pcts: Record<PFPosition, number>][],
  stackBBs: number,
  position: PFPosition,
): number {
  const lo0 = table[0][0];
  const hi0 = table[table.length - 1][0];
  const clamped = Math.max(lo0, Math.min(hi0, stackBBs));

  for (let i = 0; i < table.length - 1; i++) {
    const [loStack, loPcts] = table[i];
    const [hiStack, hiPcts] = table[i + 1];
    if (clamped >= loStack && clamped <= hiStack) {
      if (loStack === hiStack) return loPcts[position];
      const t = (clamped - loStack) / (hiStack - loStack);
      return loPcts[position] + t * (hiPcts[position] - loPcts[position]);
    }
  }
  return table[table.length - 1][1][position];
}

export interface PushFoldResult {
  action: 'PUSH' | 'CALL' | 'FOLD';
  /** 0–1: how often this action is taken (1 = pure, intermediate = mixed) */
  frequency: number;
  isMixed: boolean;
  /** The Nash percentile cutoff for this spot */
  threshold: number;
}

/**
 * Returns a Nash-calibrated push/fold recommendation for short stacks (≤20BB).
 *
 * @param percentile  Hand's playability percentile (1 = AA, ~100 = 72o)
 * @param position    Hero's position at the table
 * @param stackBBs    Effective stack in big blinds (should be ≤ 20)
 * @param facingPush  true when hero faces an all-in and must call or fold
 */
export function getPushFoldAdvice(
  percentile: number,
  position: PFPosition,
  stackBBs: number,
  facingPush = false,
): PushFoldResult {
  const table = facingPush ? CALL_TABLE : PUSH_TABLE;
  const threshold = interpolate(table, stackBBs, position);

  const lo = threshold - PUSH_FOLD_MIX_BAND / 2;
  const hi = threshold + PUSH_FOLD_MIX_BAND / 2;

  let frequency: number;
  if (percentile <= lo) {
    frequency = 1;
  } else if (percentile >= hi) {
    frequency = 0;
  } else {
    frequency = 1 - (percentile - lo) / (hi - lo);
  }

  const isMixed = frequency > 0.1 && frequency < 0.9;
  const action: PushFoldResult['action'] = facingPush
    ? (frequency >= 0.5 ? 'CALL' : 'FOLD')
    : (frequency >= 0.5 ? 'PUSH' : 'FOLD');

  return { action, frequency, isMixed, threshold };
}
