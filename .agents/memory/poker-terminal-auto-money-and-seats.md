---
name: Poker Terminal auto pot/bet OCR and seat-based player count
description: How the optional money-OCR and fold/seat-detection sub-calibrations work in ScreenScan, and their manual/auto handoff.
---

Two optional overlays were added on top of the mandatory card calibration in ScreenScan: (1) OCR of the pot and bet-to-call text, and (2) opponent player-count via pixel sampling of seat positions (colorful card-back/avatar pixels present = active, uniform dark felt = folded/empty — reusing the existing `looksEmpty` card heuristic rather than a new one). Both are opt-in, calibrated separately from the mandatory hole/board card steps, and stored under their own localStorage keys so they don't force existing users to redo card calibration.

**Why:** the original card calibration flow is already a forced multi-click UX; bundling two more required clicks (pot, bet) plus a variable number of seat clicks onto every user — including those who don't want it — would degrade the primary flow. Making them separate opt-in sub-flows keeps the default path unchanged.

**How to apply:** when the user types directly into the Pot/Bet-to-call input or drags the Players slider, auto mode for that field flips off immediately (`setAutoPot(false)`/`setAutoBet(false)`/`setAutoPlayers(false)`) so a manual correction isn't immediately overwritten by the next OCR/pixel tick — there's no "lock" step, just direct-edit-disables-auto. Money OCR reuses the same two-frame-confirmation + fingerprint-skip pattern as card OCR (see poker-terminal-ocr-reliability.md) to avoid one misread digit corrupting pot-odds math.
