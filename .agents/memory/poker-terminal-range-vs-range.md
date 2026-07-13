---
name: Poker Terminal range-vs-range Monte Carlo
description: How villain ranges are modeled for postflop equity sim, and a known limitation of the current (preflop-equity-threshold) approach.
---

Postflop Monte Carlo deals opponents from a range of real card combos (built from the
169-hand-key preflop equity table) instead of literally any two cards, by default when
a board is present and no explicit range is passed.

**Why:** dealing opponents fully random cards inflates hero equity — a villain who has
actually bet/called/raised does not hold "any two."

**Known limitation:** the range is built from a flat preflop-equity threshold (plus "always
include pairs"), with no board-texture awareness. On low, disconnected boards this can
paradoxically *raise* hero equity vs. the default range compared to true random, because
excluding "weak" preflop hands disproportionately removes exactly the small/offsuit
combos most likely to have paired a low board. This is a real, verified effect of the
current model (confirmed by direct simulation), not a bug — but it means the range model
is a rough approximation, not a solver-accurate continuing range. A future upgrade (e.g.
board-texture-aware ranges, or actual GTO preflop frequency tables) would address this.
