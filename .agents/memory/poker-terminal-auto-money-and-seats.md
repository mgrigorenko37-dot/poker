---
name: Poker Terminal auto pot/bet OCR and seat-based player count
description: How the optional money-OCR and fold/seat-detection sub-calibrations work in ScreenScan, and their manual/auto handoff.
---

Two optional overlays were added on top of the mandatory card calibration in ScreenScan: (1) OCR of the pot and bet-to-call text, and (2) opponent player-count via pixel sampling of seat positions (colorful card-back/avatar pixels present = active, uniform dark felt = folded/empty — reusing the existing `looksEmpty` card heuristic rather than a new one).

Money OCR (pot/bet) requires **zero extra clicks**: `computeAutoMoneyBands()` derives search bands directly from the hole/board card points the user already calibrated (pot band = the gap between board and hole card centroids, bet band = just below the hole cards, near where action buttons usually sit). It turns on automatically the instant card calibration finishes, and `parseMoneyText` takes the largest number found in the band (OCR noise tends to produce small stray digits, the real pot/bet figure is the prominent one). A manual "уточнить вручную" flow still exists as a fallback/override for tables where this default layout guess is wrong, but it is optional, not required.

Seat/fold detection could **not** be made zero-click the same way — opponent seat positions vary arbitrarily by table size and can't be derived from the hole/board geometry, so it remains an explicit opt-in calibration (click each opponent seat once).

**Why:** the user explicitly rejected any manual "open the app and configure something" step during play — money OCR had to piggyback on calibration they're already forced to do for cards, not add its own. The seat feature is the one exception where that isn't geometrically possible.

**How to apply:** when the user types directly into the Pot/Bet-to-call input or drags the Players slider, auto mode for that field flips off immediately (`setAutoPot(false)`/`setAutoBet(false)`/`setAutoPlayers(false)`) so a manual correction isn't overwritten by the next tick. Money OCR reuses the same two-frame-confirmation + fingerprint-skip pattern as card OCR (see poker-terminal-ocr-reliability.md) to avoid one misread digit corrupting pot-odds math. If card calibration changes (recalibration), the money bands are silently regenerated from the new geometry — any previous manual money correction is lost at that point, which is an acceptable tradeoff since a recalibration usually means the table layout itself changed.
