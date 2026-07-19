---
name: Poker Terminal Vision Scan
description: Gemini-based auto screen scan — model selection, performance tuning, architecture
---

# Vision Scan (Gemini)

## Working model
`gemini-3.1-flash-lite` (primary) → falls back to `gemini-3-flash-preview` on 503/429.

**Why not others:**
- `gemini-2.0-flash` — quota limit:0 on free tier for this API key
- `gemini-2.5-flash` — "no longer available to new users"
- `gemini-1.5-flash` — 404 on v1beta endpoint (deprecated)

## Performance (after tuning)
- Image: **480px wide** JPEG at quality 0.75 (was 960px/0.88 → 4× smaller)
- Prompt: **~60 tokens** (was ~200 tokens)
- Response time: **1.1–1.6 seconds** (was 6–16 seconds)
- Scan interval: **1500ms** (was 2500ms)
- Concurrency: up to 2 parallel Gemini calls (busyRef counter, not boolean)
- Timeout: **8s AbortController** — slow responses abort and free the slot

## Architecture
```
Browser: getDisplayMedia() → canvas → green felt auto-detect (HSV) → 480px JPEG crop
POST /api/vision/scan (base64 image + position/players)
Server: gemini-3.1-flash-lite vision (retry→gemini-3-flash-preview on 503) 
      → parse JSON → GTO analysis → Telegram push + WS broadcast
```

## Key files
- `artifacts/api-server/src/routes/vision-scan.ts` — server endpoint
- `artifacts/poker-advisor/src/components/ScreenScan.tsx` — frontend (no Tesseract)

## Green table detection
Looks for pixels where G > R*1.2 AND G > B*1.05 AND g<240 AND r<200. Downsamples to 320px for speed (~1ms). Falls back to full frame if <5% green pixels found.

## Manual overrides
Position, players, pot, bet can be set manually. Auto-detected values only applied when manual isn't set. CardPicker still works for correcting misread cards.

## busyRef
Is a number counter (not boolean): `busyRef.current++` before fetch, `busyRef.current--` in finally. Skip tick if `busyRef.current > 1`.
