---
name: Poker Terminal GTO preflop mixed-frequency model
description: How preflop RFI/3bet/call is modeled as frequencies (not a hard threshold), and the tradeoffs baked into the approximation.
---

The old preflop advisor used a single flat equity threshold per position (open/fold) plus a separate hardcoded min-pair rank. This was replaced by ranking all 169 starting hands by a "playability score" (raw preflop equity, with a flat bonus added for pairs to reflect set-mining/implied-odds value beyond raw equity) and computing a percentile for each hand. Each position's target range size (RFI %, value-3bet %, continue-vs-raise %) is a center point with a small mixed-frequency band around it: hands inside the band get a smooth 0–1 frequency instead of a binary yes/no, matching how real solvers mix borderline hands rather than always taking one action.

**Why:** No solver data source is available in this environment, so exact GTO frequencies can't be sourced — this is a hand-built approximation using the existing equity table as a proxy for range order. It's explicitly a shaped heuristic, not solved output.

**How to apply:** When extending preflop logic, prefer widening/adjusting the target-% tables and band width over reintroducing hard equity cutoffs — the smoothing is the point (avoids a fake "0% or 100%" feel and surfaces true edge-of-range spots to the user as "mixed strategy"). The light 3bet-bluff frequency for suited BTN/CO hands is a separate additive layer on top of the value-3bet/call bands, not part of the percentile ramp itself.
