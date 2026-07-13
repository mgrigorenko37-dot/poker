---
name: Poker Terminal bluff heuristic
description: Scope and limits of the "bluff read" feature in poker-advisor's GTO engine
---

`getBluffRead()` (in `poker-gto.ts`) labels a bet as likely-bluff / likely-value / unclear using only
bet-sizing ratio vs. pot, board texture (flush-possible boards), player count, and street. It has no
access to opponent history, timing tells, or actual cards.

**Why:** the user asked for a "who might be bluffing" signal. A real read requires opponent-specific
history (HUD stats) which this app doesn't track. A population-tendency heuristic was the honest
middle ground — implemented as clearly-labeled "heuristic, not certainty" and always secondary to the
equity/pot-odds math in the displayed advice.

**How to apply:** if the user later wants a real per-opponent read, that requires persisting hand
history with bet-sizing per villain across sessions and building actual stats (VPIP/PFR/aggression) —
a materially bigger feature than the current heuristic.
