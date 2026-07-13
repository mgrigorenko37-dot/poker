---
name: Poker Terminal OCR reliability
description: Safeguards added to ScreenScan's auto card recognition, and which inputs are still manual-only
---

The screen-scan pipeline (local Tesseract OCR + pixel-color suit detection) had no protection
against misreads corrupting the hand state. Added, in order of impact:

1. **Duplicate-card rejection** — the same rank+suit can never legitimately appear twice across
   hole+board; if it does, the whole frame's reading is distrusted and the last known-good
   hole/board state is kept instead of feeding an impossible hand into the equity engine.
2. **Blank-region filter** (`looksEmpty`) — a dark + low-variance region (typical felt/background)
   skips OCR entirely rather than risking a false rank/suit read on an empty board slot (guards
   against phantom turn/river cards appearing before they're actually dealt).
3. **Two-frame confirmation** — a *changed* reading for a slot must appear identically on two
   consecutive scan ticks before being committed; a single flickery OCR pass can't flip a card.
   Unchanged (fingerprint-matched) slots still resolve instantly — no added latency in the
   common case.
4. **Manual tap-to-correct** — tapping a detected card opens the existing `CardPicker` to fix a
   misread; the override is keyed to the region's current pixel fingerprint and auto-clears once
   that region's pixels actually change (new card dealt), so it doesn't get "stuck" wrong forever.

**Why:** the user's core complaint was "will it confuse my cards with the table's, will suits be
right" — these are the cheap, high-leverage fixes; suit-color heuristics and OCR itself remain
approximate and skin-dependent, so a human-correctable fallback is the honest safety net that
this class of technique needs.

**Still fully manual (not OCR'd)**: pot size, bet-to-call, player count, and position/BTN
tracking — the app never claimed otherwise, but it's worth restating since these feed directly
into pot-odds/MDF/EV math. If those go stale mid-hand, the advice is only as good as the last
manual update.
