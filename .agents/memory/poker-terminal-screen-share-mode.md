---
name: Poker Terminal screen-share surface
description: Why "share entire screen" (vs. a specific window/tab) breaks ScreenScan calibration on real tables
---

Diagnosed from a real user screenshot: their `getDisplayMedia()` capture was "Entire screen", so the
actual poker table window was a small, off-center fraction of the captured frame (surrounded by
desktop, other browser windows, taskbar). Calibration stores region positions as `%` of the captured
frame — if the table doesn't fill the frame, calibrated regions land on background/other windows
instead of cards, and any subsequent window move/resize/re-tiling silently invalidates it further.
This reproduces as "no analysis at all" / "doesn't see the cards" even though the OCR/confidence
logic itself is working correctly.

**Why:** the browser's screen-share picker defaults to whatever the user last used or clicks first;
nothing in the UI told them to pick "Window"/"Tab" specifically, and the poker site runs in a
separate browser window from the app, so it can't use `preferCurrentTab`.

**How to apply:** `getDisplayMedia` is called with a `displaySurface: 'window'` constraint (a hint
only — Chrome uses it to default the picker's active tab, it does not block "Entire screen"). After
the stream is granted, `track.getSettings().displaySurface` is checked; if it's `'monitor'`, an
in-app warning banner tells the user to redo the share and pick the game window specifically. If a
future "sees nothing" report recurs, check this state (and the OCR debug thumbnail panel — see
`poker-terminal-ocr-debug-panel.md`) before touching recognition logic again.
