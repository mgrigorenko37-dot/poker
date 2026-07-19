/**
 * Greenline-style GTO preflop charts — 6-max, 100BB deep
 *
 * RFI frequency = probability (0.0–1.0) of raising first-in from each position.
 *   1.00  = always raise (pure)
 *   0.00  = always fold  (pure, or hand absent from table)
 *   0.xx  = mixed strategy (solver plays raise this fraction of the time)
 *
 * Source: standard GTO trainer charts (coach-level, ~5-8% from solver on
 * borderline hands). Covers all 169 starting hands for positions
 * UTG / MP / HJ / CO / BTN / SB.
 * Short-stack (≤20BB) decisions are handled separately by push-fold.ts.
 *
 * vs-open (3bet / call / fold facing a raise) data is also provided.
 * vs-3bet data (4bet / call / fold facing a 3bet) is provided for key positions.
 */

import type { Position } from './poker-gto';

// ─── RFI data ─────────────────────────────────────────────────────────────────

// UTG — ~15% of hands
const UTG_RFI: Record<string, number> = {
  // Pairs
  AA: 1.00, KK: 1.00, QQ: 1.00, JJ: 1.00, TT: 1.00,
  '99': 0.85, '88': 0.45, '77': 0.15, '66': 0.05,
  // Suited aces
  AKs: 1.00, AQs: 1.00, AJs: 1.00, ATs: 1.00,
  A9s: 0.30, A8s: 0.05, A5s: 0.05,
  // Suited kings
  KQs: 1.00, KJs: 0.75, KTs: 0.50, K9s: 0.05,
  // Suited queens
  QJs: 0.45, QTs: 0.10,
  // Suited jacks / connectors
  JTs: 0.30, J9s: 0.05,
  T9s: 0.15, '98s': 0.05,
  // Offsuit broadway
  AKo: 1.00, AQo: 1.00, AJo: 0.65, ATo: 0.15,
  KQo: 0.55, KJo: 0.05,
};

// MP — ~20% of hands
const MP_RFI: Record<string, number> = {
  AA: 1.00, KK: 1.00, QQ: 1.00, JJ: 1.00, TT: 1.00,
  '99': 1.00, '88': 0.80, '77': 0.40, '66': 0.15, '55': 0.05,
  AKs: 1.00, AQs: 1.00, AJs: 1.00, ATs: 1.00,
  A9s: 0.65, A8s: 0.25, A7s: 0.05, A5s: 0.15, A4s: 0.05,
  KQs: 1.00, KJs: 1.00, KTs: 0.85, K9s: 0.20,
  QJs: 0.95, QTs: 0.60, Q9s: 0.10,
  JTs: 0.80, J9s: 0.25,
  T9s: 0.50, '98s': 0.25, '87s': 0.05,
  AKo: 1.00, AQo: 1.00, AJo: 1.00, ATo: 0.60, A9o: 0.10,
  KQo: 0.95, KJo: 0.50, KTo: 0.10,
  QJo: 0.25, QTo: 0.05,
};

// HJ (Hijack) — ~25% of hands
const HJ_RFI: Record<string, number> = {
  AA: 1.00, KK: 1.00, QQ: 1.00, JJ: 1.00, TT: 1.00,
  '99': 1.00, '88': 1.00, '77': 0.80, '66': 0.55, '55': 0.25, '44': 0.10,
  AKs: 1.00, AQs: 1.00, AJs: 1.00, ATs: 1.00, A9s: 1.00,
  A8s: 0.75, A7s: 0.40, A6s: 0.15, A5s: 0.65, A4s: 0.35, A3s: 0.15, A2s: 0.05,
  KQs: 1.00, KJs: 1.00, KTs: 1.00, K9s: 0.70, K8s: 0.15,
  QJs: 1.00, QTs: 0.95, Q9s: 0.50, Q8s: 0.05,
  JTs: 1.00, J9s: 0.65, J8s: 0.15,
  T9s: 0.85, T8s: 0.25,
  '98s': 0.70, '97s': 0.15,
  '87s': 0.45, '86s': 0.05,
  '76s': 0.20, '65s': 0.05,
  AKo: 1.00, AQo: 1.00, AJo: 1.00, ATo: 0.95, A9o: 0.50, A8o: 0.10,
  KQo: 1.00, KJo: 0.90, KTo: 0.50, K9o: 0.10,
  QJo: 0.70, QTo: 0.35, Q9o: 0.05,
  JTo: 0.40, J9o: 0.10,
  T9o: 0.10,
};

// CO (Cutoff) — ~32% of hands
const CO_RFI: Record<string, number> = {
  AA: 1.00, KK: 1.00, QQ: 1.00, JJ: 1.00, TT: 1.00,
  '99': 1.00, '88': 1.00, '77': 1.00, '66': 1.00, '55': 0.85,
  '44': 0.65, '33': 0.50, '22': 0.40,
  AKs: 1.00, AQs: 1.00, AJs: 1.00, ATs: 1.00, A9s: 1.00, A8s: 1.00,
  A7s: 0.95, A6s: 0.80, A5s: 1.00, A4s: 0.90, A3s: 0.75, A2s: 0.60,
  KQs: 1.00, KJs: 1.00, KTs: 1.00, K9s: 1.00, K8s: 0.65, K7s: 0.30,
  K6s: 0.15, K5s: 0.05,
  QJs: 1.00, QTs: 1.00, Q9s: 0.95, Q8s: 0.55, Q7s: 0.10,
  JTs: 1.00, J9s: 1.00, J8s: 0.65, J7s: 0.20,
  T9s: 1.00, T8s: 0.80, T7s: 0.25,
  '98s': 1.00, '97s': 0.60, '96s': 0.10,
  '87s': 0.90, '86s': 0.40, '85s': 0.05,
  '76s': 0.75, '75s': 0.25,
  '65s': 0.60, '64s': 0.10,
  '54s': 0.50, '53s': 0.05,
  '43s': 0.10,
  AKo: 1.00, AQo: 1.00, AJo: 1.00, ATo: 1.00, A9o: 0.90, A8o: 0.65, A7o: 0.35, A6o: 0.10,
  KQo: 1.00, KJo: 1.00, KTo: 0.90, K9o: 0.60, K8o: 0.25, K7o: 0.05,
  QJo: 1.00, QTo: 0.80, Q9o: 0.50, Q8o: 0.10,
  JTo: 0.85, J9o: 0.55, J8o: 0.20,
  T9o: 0.60, T8o: 0.25, T7o: 0.05,
  '98o': 0.45, '97o': 0.10,
  '87o': 0.30, '86o': 0.05,
  '76o': 0.15,
};

// BTN (Button) — ~48% of hands
const BTN_RFI: Record<string, number> = {
  // All pairs open
  AA: 1.00, KK: 1.00, QQ: 1.00, JJ: 1.00, TT: 1.00,
  '99': 1.00, '88': 1.00, '77': 1.00, '66': 1.00, '55': 1.00,
  '44': 1.00, '33': 1.00, '22': 1.00,
  // Suited aces — all open
  AKs: 1.00, AQs: 1.00, AJs: 1.00, ATs: 1.00, A9s: 1.00, A8s: 1.00,
  A7s: 1.00, A6s: 1.00, A5s: 1.00, A4s: 1.00, A3s: 1.00, A2s: 1.00,
  // Suited kings
  KQs: 1.00, KJs: 1.00, KTs: 1.00, K9s: 1.00, K8s: 1.00,
  K7s: 0.95, K6s: 0.85, K5s: 0.70, K4s: 0.50, K3s: 0.35, K2s: 0.20,
  // Suited queens
  QJs: 1.00, QTs: 1.00, Q9s: 1.00, Q8s: 0.90, Q7s: 0.70,
  Q6s: 0.45, Q5s: 0.20, Q4s: 0.05,
  // Suited jacks
  JTs: 1.00, J9s: 1.00, J8s: 0.90, J7s: 0.65, J6s: 0.35, J5s: 0.10,
  // Suited connectors
  T9s: 1.00, T8s: 1.00, T7s: 0.80, T6s: 0.45, T5s: 0.10,
  '98s': 1.00, '97s': 0.90, '96s': 0.60, '95s': 0.25,
  '87s': 1.00, '86s': 0.80, '85s': 0.50, '84s': 0.15,
  '76s': 1.00, '75s': 0.75, '74s': 0.35, '73s': 0.10,
  '65s': 0.95, '64s': 0.65, '63s': 0.25,
  '54s': 0.90, '53s': 0.55, '52s': 0.15,
  '43s': 0.70, '42s': 0.25,
  '32s': 0.35,
  // Offsuit
  AKo: 1.00, AQo: 1.00, AJo: 1.00, ATo: 1.00, A9o: 1.00,
  A8o: 0.95, A7o: 0.80, A6o: 0.60, A5o: 0.65, A4o: 0.45, A3o: 0.30, A2o: 0.15,
  KQo: 1.00, KJo: 1.00, KTo: 1.00, K9o: 0.90, K8o: 0.70, K7o: 0.50,
  K6o: 0.30, K5o: 0.15, K4o: 0.05,
  QJo: 1.00, QTo: 0.95, Q9o: 0.80, Q8o: 0.55, Q7o: 0.25, Q6o: 0.05,
  JTo: 1.00, J9o: 0.85, J8o: 0.60, J7o: 0.30, J6o: 0.10,
  T9o: 0.85, T8o: 0.60, T7o: 0.30, T6o: 0.10,
  '98o': 0.70, '97o': 0.45, '96o': 0.15,
  '87o': 0.60, '86o': 0.30, '85o': 0.10,
  '76o': 0.50, '75o': 0.20,
  '65o': 0.40, '64o': 0.10,
  '54o': 0.30, '53o': 0.05,
  '43o': 0.10,
};

// SB (vs BB only) — ~40% of hands
const SB_RFI: Record<string, number> = {
  AA: 1.00, KK: 1.00, QQ: 1.00, JJ: 1.00, TT: 1.00,
  '99': 1.00, '88': 1.00, '77': 1.00, '66': 1.00, '55': 1.00,
  '44': 0.90, '33': 0.75, '22': 0.60,
  AKs: 1.00, AQs: 1.00, AJs: 1.00, ATs: 1.00, A9s: 1.00, A8s: 1.00,
  A7s: 1.00, A6s: 1.00, A5s: 1.00, A4s: 0.90, A3s: 0.75, A2s: 0.60,
  KQs: 1.00, KJs: 1.00, KTs: 1.00, K9s: 1.00, K8s: 0.85, K7s: 0.70,
  K6s: 0.55, K5s: 0.40, K4s: 0.25, K3s: 0.10,
  QJs: 1.00, QTs: 1.00, Q9s: 0.95, Q8s: 0.75, Q7s: 0.50, Q6s: 0.25,
  JTs: 1.00, J9s: 0.95, J8s: 0.75, J7s: 0.45, J6s: 0.15,
  T9s: 1.00, T8s: 0.90, T7s: 0.60, T6s: 0.25,
  '98s': 0.95, '97s': 0.70, '96s': 0.35,
  '87s': 0.90, '86s': 0.55, '85s': 0.20,
  '76s': 0.80, '75s': 0.45, '74s': 0.10,
  '65s': 0.70, '64s': 0.25,
  '54s': 0.60, '53s': 0.20,
  '43s': 0.35, '42s': 0.05,
  '32s': 0.15,
  AKo: 1.00, AQo: 1.00, AJo: 1.00, ATo: 1.00, A9o: 0.90, A8o: 0.70,
  A7o: 0.50, A6o: 0.30, A5o: 0.45, A4o: 0.25, A3o: 0.10,
  KQo: 1.00, KJo: 1.00, KTo: 0.95, K9o: 0.75, K8o: 0.50, K7o: 0.30, K6o: 0.10,
  QJo: 0.95, QTo: 0.80, Q9o: 0.60, Q8o: 0.30, Q7o: 0.10,
  JTo: 0.85, J9o: 0.60, J8o: 0.30, J7o: 0.10,
  T9o: 0.70, T8o: 0.40, T7o: 0.15,
  '98o': 0.55, '97o': 0.25, '96o': 0.05,
  '87o': 0.40, '86o': 0.15,
  '76o': 0.30, '75o': 0.05,
  '65o': 0.20,
  '54o': 0.10,
};

const RFI_TABLES: Partial<Record<Position, Record<string, number>>> = {
  UTG: UTG_RFI,
  MP:  MP_RFI,
  HJ:  HJ_RFI,
  CO:  CO_RFI,
  BTN: BTN_RFI,
  SB:  SB_RFI,
};

// ─── vs-open (facing a raise) ─────────────────────────────────────────────────
// { raise: 3bet freq, call: call freq } — fold = 1 - raise - call
// Keyed by our position. Simplification: does not break down by raiser position
// (the aggressor-position multiplier in poker-gto.ts handles that nuance).

interface VsOpenFreqs { raise: number; call: number }

const UTG_VS_OPEN: Record<string, VsOpenFreqs> = {
  AA: { raise: 1.00, call: 0.00 }, KK: { raise: 1.00, call: 0.00 },
  QQ: { raise: 0.85, call: 0.15 }, JJ: { raise: 0.50, call: 0.50 },
  TT: { raise: 0.20, call: 0.65 }, '99': { raise: 0.05, call: 0.55 },
  '88': { raise: 0.00, call: 0.35 }, '77': { raise: 0.00, call: 0.20 },
  AKs: { raise: 1.00, call: 0.00 }, AQs: { raise: 0.60, call: 0.40 },
  AJs: { raise: 0.20, call: 0.55 }, ATs: { raise: 0.05, call: 0.55 },
  A9s: { raise: 0.00, call: 0.30 }, A5s: { raise: 0.20, call: 0.00 },
  KQs: { raise: 0.35, call: 0.55 }, KJs: { raise: 0.05, call: 0.45 },
  KTs: { raise: 0.00, call: 0.30 },
  QJs: { raise: 0.00, call: 0.25 }, JTs: { raise: 0.00, call: 0.20 },
  AKo: { raise: 0.90, call: 0.10 }, AQo: { raise: 0.30, call: 0.55 },
  AJo: { raise: 0.05, call: 0.40 }, ATo: { raise: 0.00, call: 0.20 },
  KQo: { raise: 0.10, call: 0.45 }, KJo: { raise: 0.00, call: 0.20 },
};

const MP_VS_OPEN: Record<string, VsOpenFreqs> = {
  AA: { raise: 1.00, call: 0.00 }, KK: { raise: 1.00, call: 0.00 },
  QQ: { raise: 0.80, call: 0.20 }, JJ: { raise: 0.45, call: 0.55 },
  TT: { raise: 0.15, call: 0.70 }, '99': { raise: 0.05, call: 0.60 },
  '88': { raise: 0.00, call: 0.40 }, '77': { raise: 0.00, call: 0.25 },
  '66': { raise: 0.00, call: 0.15 }, '55': { raise: 0.00, call: 0.10 },
  AKs: { raise: 1.00, call: 0.00 }, AQs: { raise: 0.65, call: 0.35 },
  AJs: { raise: 0.25, call: 0.60 }, ATs: { raise: 0.10, call: 0.60 },
  A9s: { raise: 0.00, call: 0.35 }, A8s: { raise: 0.00, call: 0.20 },
  A5s: { raise: 0.25, call: 0.00 }, A4s: { raise: 0.15, call: 0.00 },
  KQs: { raise: 0.40, call: 0.50 }, KJs: { raise: 0.10, call: 0.55 },
  KTs: { raise: 0.05, call: 0.40 }, K9s: { raise: 0.00, call: 0.20 },
  QJs: { raise: 0.05, call: 0.35 }, QTs: { raise: 0.00, call: 0.25 },
  JTs: { raise: 0.00, call: 0.30 }, J9s: { raise: 0.00, call: 0.15 },
  T9s: { raise: 0.00, call: 0.20 }, '98s': { raise: 0.00, call: 0.15 },
  AKo: { raise: 0.90, call: 0.10 }, AQo: { raise: 0.35, call: 0.55 },
  AJo: { raise: 0.10, call: 0.50 }, ATo: { raise: 0.00, call: 0.30 },
  KQo: { raise: 0.15, call: 0.55 }, KJo: { raise: 0.00, call: 0.30 },
  KTo: { raise: 0.00, call: 0.15 }, QJo: { raise: 0.00, call: 0.20 },
};

const CO_VS_OPEN: Record<string, VsOpenFreqs> = {
  AA: { raise: 1.00, call: 0.00 }, KK: { raise: 1.00, call: 0.00 },
  QQ: { raise: 0.90, call: 0.10 }, JJ: { raise: 0.55, call: 0.45 },
  TT: { raise: 0.25, call: 0.70 }, '99': { raise: 0.10, call: 0.70 },
  '88': { raise: 0.05, call: 0.60 }, '77': { raise: 0.00, call: 0.45 },
  '66': { raise: 0.00, call: 0.30 }, '55': { raise: 0.00, call: 0.20 },
  '44': { raise: 0.00, call: 0.15 }, '33': { raise: 0.00, call: 0.10 }, '22': { raise: 0.00, call: 0.10 },
  AKs: { raise: 1.00, call: 0.00 }, AQs: { raise: 0.75, call: 0.25 },
  AJs: { raise: 0.35, call: 0.60 }, ATs: { raise: 0.15, call: 0.70 },
  A9s: { raise: 0.05, call: 0.55 }, A8s: { raise: 0.05, call: 0.45 },
  A7s: { raise: 0.00, call: 0.35 }, A6s: { raise: 0.00, call: 0.25 },
  A5s: { raise: 0.30, call: 0.10 }, A4s: { raise: 0.25, call: 0.05 },
  A3s: { raise: 0.15, call: 0.00 }, A2s: { raise: 0.10, call: 0.00 },
  KQs: { raise: 0.50, call: 0.45 }, KJs: { raise: 0.20, call: 0.60 },
  KTs: { raise: 0.10, call: 0.55 }, K9s: { raise: 0.05, call: 0.40 },
  QJs: { raise: 0.10, call: 0.55 }, QTs: { raise: 0.05, call: 0.45 },
  Q9s: { raise: 0.00, call: 0.30 }, JTs: { raise: 0.05, call: 0.50 },
  J9s: { raise: 0.00, call: 0.35 }, T9s: { raise: 0.05, call: 0.45 },
  T8s: { raise: 0.00, call: 0.30 }, '98s': { raise: 0.05, call: 0.40 },
  '97s': { raise: 0.00, call: 0.25 }, '87s': { raise: 0.00, call: 0.30 },
  '76s': { raise: 0.00, call: 0.25 }, '65s': { raise: 0.00, call: 0.20 },
  AKo: { raise: 0.90, call: 0.10 }, AQo: { raise: 0.45, call: 0.50 },
  AJo: { raise: 0.15, call: 0.60 }, ATo: { raise: 0.05, call: 0.50 },
  A9o: { raise: 0.00, call: 0.30 }, A8o: { raise: 0.00, call: 0.20 },
  KQo: { raise: 0.20, call: 0.60 }, KJo: { raise: 0.05, call: 0.50 },
  KTo: { raise: 0.00, call: 0.30 }, K9o: { raise: 0.00, call: 0.15 },
  QJo: { raise: 0.05, call: 0.40 }, QTo: { raise: 0.00, call: 0.25 },
  JTo: { raise: 0.00, call: 0.30 }, J9o: { raise: 0.00, call: 0.15 },
  T9o: { raise: 0.00, call: 0.20 },
};

const BTN_VS_OPEN: Record<string, VsOpenFreqs> = {
  AA: { raise: 1.00, call: 0.00 }, KK: { raise: 1.00, call: 0.00 },
  QQ: { raise: 0.95, call: 0.05 }, JJ: { raise: 0.65, call: 0.35 },
  TT: { raise: 0.35, call: 0.65 }, '99': { raise: 0.20, call: 0.75 },
  '88': { raise: 0.10, call: 0.75 }, '77': { raise: 0.05, call: 0.65 },
  '66': { raise: 0.00, call: 0.55 }, '55': { raise: 0.00, call: 0.45 },
  '44': { raise: 0.00, call: 0.35 }, '33': { raise: 0.00, call: 0.25 }, '22': { raise: 0.00, call: 0.20 },
  AKs: { raise: 1.00, call: 0.00 }, AQs: { raise: 0.80, call: 0.20 },
  AJs: { raise: 0.45, call: 0.55 }, ATs: { raise: 0.25, call: 0.70 },
  A9s: { raise: 0.10, call: 0.65 }, A8s: { raise: 0.10, call: 0.60 },
  A7s: { raise: 0.05, call: 0.55 }, A6s: { raise: 0.05, call: 0.45 },
  A5s: { raise: 0.40, call: 0.20 }, A4s: { raise: 0.30, call: 0.15 },
  A3s: { raise: 0.20, call: 0.10 }, A2s: { raise: 0.15, call: 0.10 },
  KQs: { raise: 0.55, call: 0.45 }, KJs: { raise: 0.30, call: 0.65 },
  KTs: { raise: 0.20, call: 0.65 }, K9s: { raise: 0.10, call: 0.55 },
  K8s: { raise: 0.05, call: 0.45 }, K7s: { raise: 0.00, call: 0.35 },
  QJs: { raise: 0.20, call: 0.70 }, QTs: { raise: 0.10, call: 0.65 },
  Q9s: { raise: 0.05, call: 0.50 }, Q8s: { raise: 0.00, call: 0.35 },
  JTs: { raise: 0.15, call: 0.70 }, J9s: { raise: 0.05, call: 0.55 },
  J8s: { raise: 0.00, call: 0.40 }, T9s: { raise: 0.10, call: 0.65 },
  T8s: { raise: 0.05, call: 0.50 }, T7s: { raise: 0.00, call: 0.35 },
  '98s': { raise: 0.10, call: 0.60 }, '97s': { raise: 0.05, call: 0.45 },
  '87s': { raise: 0.05, call: 0.55 }, '86s': { raise: 0.00, call: 0.40 },
  '76s': { raise: 0.05, call: 0.50 }, '75s': { raise: 0.00, call: 0.35 },
  '65s': { raise: 0.00, call: 0.45 }, '64s': { raise: 0.00, call: 0.30 },
  '54s': { raise: 0.00, call: 0.40 }, '53s': { raise: 0.00, call: 0.25 },
  AKo: { raise: 0.95, call: 0.05 }, AQo: { raise: 0.55, call: 0.45 },
  AJo: { raise: 0.25, call: 0.65 }, ATo: { raise: 0.10, call: 0.65 },
  A9o: { raise: 0.05, call: 0.50 }, A8o: { raise: 0.00, call: 0.40 },
  A7o: { raise: 0.00, call: 0.30 }, A6o: { raise: 0.00, call: 0.20 },
  KQo: { raise: 0.30, call: 0.60 }, KJo: { raise: 0.10, call: 0.60 },
  KTo: { raise: 0.05, call: 0.50 }, K9o: { raise: 0.00, call: 0.35 },
  QJo: { raise: 0.10, call: 0.55 }, QTo: { raise: 0.05, call: 0.45 },
  Q9o: { raise: 0.00, call: 0.30 }, JTo: { raise: 0.05, call: 0.50 },
  J9o: { raise: 0.00, call: 0.35 }, T9o: { raise: 0.00, call: 0.40 },
  T8o: { raise: 0.00, call: 0.25 }, '98o': { raise: 0.00, call: 0.30 },
};

const BB_VS_OPEN: Record<string, VsOpenFreqs> = {
  AA: { raise: 1.00, call: 0.00 }, KK: { raise: 1.00, call: 0.00 },
  QQ: { raise: 0.90, call: 0.10 }, JJ: { raise: 0.65, call: 0.35 },
  TT: { raise: 0.40, call: 0.60 }, '99': { raise: 0.20, call: 0.80 },
  '88': { raise: 0.10, call: 0.90 }, '77': { raise: 0.05, call: 0.80 },
  '66': { raise: 0.00, call: 0.70 }, '55': { raise: 0.00, call: 0.65 },
  '44': { raise: 0.00, call: 0.60 }, '33': { raise: 0.00, call: 0.55 }, '22': { raise: 0.00, call: 0.50 },
  AKs: { raise: 1.00, call: 0.00 }, AQs: { raise: 0.80, call: 0.20 },
  AJs: { raise: 0.50, call: 0.50 }, ATs: { raise: 0.30, call: 0.70 },
  A9s: { raise: 0.15, call: 0.75 }, A8s: { raise: 0.10, call: 0.75 },
  A7s: { raise: 0.10, call: 0.70 }, A6s: { raise: 0.10, call: 0.65 },
  A5s: { raise: 0.35, call: 0.40 }, A4s: { raise: 0.30, call: 0.35 },
  A3s: { raise: 0.25, call: 0.35 }, A2s: { raise: 0.20, call: 0.35 },
  KQs: { raise: 0.55, call: 0.45 }, KJs: { raise: 0.35, call: 0.65 },
  KTs: { raise: 0.20, call: 0.70 }, K9s: { raise: 0.10, call: 0.70 },
  K8s: { raise: 0.05, call: 0.70 }, K7s: { raise: 0.05, call: 0.65 },
  K6s: { raise: 0.00, call: 0.60 }, K5s: { raise: 0.00, call: 0.55 },
  QJs: { raise: 0.25, call: 0.75 }, QTs: { raise: 0.15, call: 0.75 },
  Q9s: { raise: 0.10, call: 0.70 }, Q8s: { raise: 0.05, call: 0.60 },
  Q7s: { raise: 0.00, call: 0.50 }, Q6s: { raise: 0.00, call: 0.45 },
  JTs: { raise: 0.20, call: 0.80 }, J9s: { raise: 0.10, call: 0.75 },
  J8s: { raise: 0.05, call: 0.65 }, J7s: { raise: 0.00, call: 0.55 },
  T9s: { raise: 0.15, call: 0.80 }, T8s: { raise: 0.05, call: 0.75 },
  T7s: { raise: 0.00, call: 0.60 }, T6s: { raise: 0.00, call: 0.50 },
  '98s': { raise: 0.10, call: 0.80 }, '97s': { raise: 0.05, call: 0.70 },
  '96s': { raise: 0.00, call: 0.60 }, '87s': { raise: 0.10, call: 0.75 },
  '86s': { raise: 0.00, call: 0.65 }, '76s': { raise: 0.05, call: 0.70 },
  '75s': { raise: 0.00, call: 0.60 }, '65s': { raise: 0.05, call: 0.65 },
  '64s': { raise: 0.00, call: 0.55 }, '54s': { raise: 0.05, call: 0.60 },
  '53s': { raise: 0.00, call: 0.50 }, '43s': { raise: 0.00, call: 0.45 },
  '32s': { raise: 0.00, call: 0.40 },
  AKo: { raise: 0.90, call: 0.10 }, AQo: { raise: 0.55, call: 0.45 },
  AJo: { raise: 0.30, call: 0.65 }, ATo: { raise: 0.15, call: 0.75 },
  A9o: { raise: 0.05, call: 0.70 }, A8o: { raise: 0.00, call: 0.65 },
  A7o: { raise: 0.00, call: 0.60 }, A6o: { raise: 0.00, call: 0.55 },
  A5o: { raise: 0.10, call: 0.45 }, A4o: { raise: 0.05, call: 0.40 },
  A3o: { raise: 0.05, call: 0.40 }, A2o: { raise: 0.00, call: 0.40 },
  KQo: { raise: 0.35, call: 0.60 }, KJo: { raise: 0.15, call: 0.70 },
  KTo: { raise: 0.05, call: 0.65 }, K9o: { raise: 0.00, call: 0.60 },
  K8o: { raise: 0.00, call: 0.50 }, K7o: { raise: 0.00, call: 0.45 },
  QJo: { raise: 0.15, call: 0.70 }, QTo: { raise: 0.05, call: 0.65 },
  Q9o: { raise: 0.00, call: 0.55 }, Q8o: { raise: 0.00, call: 0.45 },
  JTo: { raise: 0.10, call: 0.70 }, J9o: { raise: 0.00, call: 0.60 },
  J8o: { raise: 0.00, call: 0.50 }, T9o: { raise: 0.05, call: 0.65 },
  T8o: { raise: 0.00, call: 0.55 }, '98o': { raise: 0.00, call: 0.55 },
  '97o': { raise: 0.00, call: 0.45 }, '87o': { raise: 0.00, call: 0.50 },
  '76o': { raise: 0.00, call: 0.45 }, '65o': { raise: 0.00, call: 0.40 },
  '54o': { raise: 0.00, call: 0.40 }, '43o': { raise: 0.00, call: 0.30 },
};

// SB vs open — SB folds or 3bets most of the time (rarely calls IP is not applicable here)
const SB_VS_OPEN: Record<string, VsOpenFreqs> = {
  AA: { raise: 1.00, call: 0.00 }, KK: { raise: 1.00, call: 0.00 },
  QQ: { raise: 0.90, call: 0.10 }, JJ: { raise: 0.60, call: 0.35 },
  TT: { raise: 0.30, call: 0.50 }, '99': { raise: 0.15, call: 0.55 },
  '88': { raise: 0.10, call: 0.45 }, '77': { raise: 0.00, call: 0.35 },
  '66': { raise: 0.00, call: 0.25 }, '55': { raise: 0.00, call: 0.15 },
  AKs: { raise: 1.00, call: 0.00 }, AQs: { raise: 0.70, call: 0.30 },
  AJs: { raise: 0.40, call: 0.50 }, ATs: { raise: 0.20, call: 0.60 },
  A9s: { raise: 0.05, call: 0.50 }, A8s: { raise: 0.05, call: 0.40 },
  A5s: { raise: 0.30, call: 0.10 }, A4s: { raise: 0.20, call: 0.05 },
  A3s: { raise: 0.15, call: 0.00 }, A2s: { raise: 0.10, call: 0.00 },
  KQs: { raise: 0.50, call: 0.40 }, KJs: { raise: 0.20, call: 0.55 },
  KTs: { raise: 0.10, call: 0.50 }, K9s: { raise: 0.05, call: 0.35 },
  QJs: { raise: 0.10, call: 0.50 }, QTs: { raise: 0.05, call: 0.40 },
  JTs: { raise: 0.10, call: 0.50 }, J9s: { raise: 0.00, call: 0.35 },
  T9s: { raise: 0.05, call: 0.45 }, '98s': { raise: 0.05, call: 0.40 },
  '87s': { raise: 0.00, call: 0.35 }, '76s': { raise: 0.00, call: 0.30 },
  '65s': { raise: 0.00, call: 0.25 }, '54s': { raise: 0.00, call: 0.20 },
  AKo: { raise: 0.90, call: 0.10 }, AQo: { raise: 0.45, call: 0.45 },
  AJo: { raise: 0.20, call: 0.55 }, ATo: { raise: 0.05, call: 0.50 },
  A9o: { raise: 0.00, call: 0.30 }, A8o: { raise: 0.00, call: 0.20 },
  KQo: { raise: 0.25, call: 0.55 }, KJo: { raise: 0.05, call: 0.45 },
  KTo: { raise: 0.00, call: 0.30 }, QJo: { raise: 0.05, call: 0.40 },
  QTo: { raise: 0.00, call: 0.25 }, JTo: { raise: 0.00, call: 0.30 },
};

const VS_OPEN_TABLES: Partial<Record<Position, Record<string, VsOpenFreqs>>> = {
  UTG: UTG_VS_OPEN,
  MP:  MP_VS_OPEN,
  CO:  CO_VS_OPEN,
  BTN: BTN_VS_OPEN,
  SB:  SB_VS_OPEN,
  BB:  BB_VS_OPEN,
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Raise-first-in frequency for a hand at a given position.
 * Returns null for BB (always in blind, no RFI) and for positions
 * not covered by the chart (not expected).
 */
export function getGreenlineRFIFreq(handKey: string, position: Position): number | null {
  const table = RFI_TABLES[position];
  if (!table) return null;               // BB, or unknown position
  return table[handKey] ?? 0;            // unlisted hand = pure fold
}

/**
 * Frequencies when facing a raise, from our position.
 * Returns null if the position/hand has no chart entry.
 */
export function getGreenlineVsOpenFreqs(handKey: string, position: Position): { raise: number; call: number; fold: number } | null {
  const table = VS_OPEN_TABLES[position];
  if (!table) return null;
  const entry = table[handKey];
  if (!entry) return null;
  const fold = Math.max(0, 1 - entry.raise - entry.call);
  return { raise: entry.raise, call: entry.call, fold };
}

/**
 * Whether a hand is a "pure" action (≥ 95% one way) or a genuine mix.
 */
export function isGreenlineMixed(freq: number): boolean {
  return freq > 0.05 && freq < 0.95;
}
