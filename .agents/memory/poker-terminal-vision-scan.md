---
name: Poker Terminal Vision Scan
description: Gemini-based auto screen scan — model selection, quota issues, architecture
---

# Vision Scan (Gemini)

## Working model
`gemini-3-flash-preview` — supports image input, has free quota, responds fast.

**Why not others:**
- `gemini-2.0-flash` — quota limit:0 on free tier for this API key
- `gemini-2.5-flash` — "no longer available to new users"
- `gemini-1.5-flash` — 404 on v1beta endpoint (deprecated)
- `gemini-3.1-flash-lite` — also works as fallback

## Architecture
```
Browser: getDisplayMedia() → canvas → green felt auto-detect (HSV) → JPEG crop
POST /api/vision/scan (base64 image + position/players)
Server: gemini-3-flash-preview vision → parse JSON → GTO analysis → Telegram push + WS broadcast
```

## Key files
- `artifacts/api-server/src/routes/vision-scan.ts` — server endpoint
- `artifacts/poker-advisor/src/components/ScreenScan.tsx` — frontend (no Tesseract)

## Green table detection
Looks for pixels where G > R*1.2 AND G > B*1.05 AND g<240 AND r<200. Downsamples to 320px for speed (~1ms). Falls back to full frame if <5% green pixels found.

## Scan interval
2500ms, skips if frame diff < 1.5% (unchanged screen).

## Manual overrides
Position, players, pot, bet can be set manually. Auto-detected values only applied when manual isn't set. CardPicker still works for correcting misread cards.
