---
name: Poker Terminal OCR debug panel
description: In-app "what OCR sees" thumbnail panel used to diagnose live-table recognition failures without needing screen access
---

When a user reports OCR "sees nothing" / misreads on a real table, the most likely cause is a
**calibration/capture mismatch** (saved region % coordinates no longer line up with what's actually
being captured — e.g. the shared window was resized, docked side-by-side with another window, or
zoom changed), not a logic bug in the recognition code. This is very hard to diagnose blind, since
the agent has no way to see the user's live capture pixels.

Fix: `ScreenScan.tsx` has a togglable debug panel ("👁 Что видит OCR") that renders small thumbnail
crops of exactly what each calibrated region is reading, refreshed every OCR tick. Off by default
(zero cost). When something seems broken, ask the user to turn it on and send a screenshot — if the
thumbnails show table felt/background instead of cards, it's confirmed as a calibration/capture
issue (tell them to recalibrate matching the *current* exact capture framing) rather than an OCR bug.

**Why:** debugging live-screen-capture OCR issues over chat without this is pure guesswork — each
"fix" attempt (confidence thresholds, suit detection, etc.) can't be verified against the user's
actual pixels, so failures repeat. A visual diagnostic collapses that loop to one screenshot.

**How to apply:** reach for this before tuning OCR constants again on a "still doesn't work on my
table" report — it tells you whether the problem is upstream (capture/calibration) or downstream
(recognition logic) before you touch code.
