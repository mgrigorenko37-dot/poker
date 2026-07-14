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
3. **Confidence gate, not multi-tick debounce** (changed 2026-07-14) — an earlier version required
   a changed reading to repeat identically on two consecutive scan ticks before committing (up to
   ~700ms extra latency per new card). Replaced with an immediate commit gated on Tesseract's
   per-read confidence score (`data.confidence`, rank threshold ~45, money threshold ~40): a clean
   glyph on the 5×-upscaled/Otsu-binarized crop reads with high confidence and commits on the same
   tick; a garbled/misaligned crop reads low and is discarded (last known value kept) instead of
   corrupting state. Zero added latency for a good read, vs. a full extra tick for the old scheme.
4. **Manual tap-to-correct** — tapping a detected card opens the existing `CardPicker` to fix a
   misread; the override is keyed to the region's current pixel fingerprint and auto-clears once
   that region's pixels actually change (new card dealt), so it doesn't get "stuck" wrong forever.
5. **Stale-advice guard** — if hole cards drop below 2 recognized (new hand dealing, a slot briefly
   unreadable), the advice panel is cleared instead of leaving the previous hand's decision on
   screen — with a ~5s decision window, a stale "RAISE" from the last hand is actively misleading.

**Why:** the user's core complaint was "will it confuse my cards with the table's, will suits be
right" — these are the cheap, high-leverage fixes; suit-color heuristics and OCR itself remain
approximate and skin-dependent, so a human-correctable fallback is the honest safety net that
this class of technique needs. A later complaint ("too slow, 5-second decision window, still
misreads/miscounts") drove the shift from debounce-latency to confidence-gating, plus tightening
the scan tick from 350ms to 180ms and the forced-full-rescan cadence from every 3 ticks to every 2.

**Still fully manual (not OCR'd)**: pot size, bet-to-call, player count, and position/BTN
tracking — the app never claimed otherwise, but it's worth restating since these feed directly
into pot-odds/MDF/EV math. If those go stale mid-hand, the advice is only as good as the last
manual update.
