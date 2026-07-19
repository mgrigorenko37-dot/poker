---
name: Poker Terminal push/fold short-stack tables
description: Nash push/fold implementation for stacks ≤20BB — where files live, how the path flows, and what's covered vs not.
---

## What was built

New module `push-fold.ts` (identical copy in both artifacts) with:
- Nash equilibrium push ranges (% of hands by playability percentile) for stacks 2–20BB × 7 positions
- Nash call ranges (facing an all-in) same grid but tighter
- `getPushFoldAdvice(percentile, position, stackBBs, facingPush)` — interpolates between table rows, applies 5-point mix band

## Integration points

- `artifacts/api-server/src/lib/push-fold.ts` — server copy
- `artifacts/poker-advisor/src/lib/push-fold.ts` — client copy (identical)
- `getGTOPreflopAdvice` in both `poker-gto.ts` files: early-return when `stackBBs ≤ 20`, maps PUSH→action:'RAISE' with reason "PUSH ALL-IN (XBB, Nash: топ N% рук)"
- `getFullAdvice` in both `poker-gto.ts` files: added `stackBBs` param (before `aggressorPosition` on server, last param on client); when RAISE+stackBBs≤20 → displayText='PUSH', sizing='ALL-IN', color='bg-amber-500'
- `artifacts/api-server/src/routes/vision-scan.ts` line ~235: passes `sprAdvice?.stackBBs ?? 100` to `getFullAdvice` (ScreenScan path picks up stack size automatically from OCR)
- `artifacts/poker-advisor/src/components/HandAnalyzer.tsx`: added `stackBBs` state (default 100), "STACK (BB)" input with "— push/fold" label hint, push/fold recommendation block runs before equity heuristic when preflop + stackBBs ≤ 20

## Coverage and caveats

- Cash game Nash, no ICM pressure — accurate enough for cash, ~2-5% off for tournaments
- Does NOT cover full-stack preflop (>20BB) — that's still the formula-based system
- 20BB boundary is a hard cutoff — consider smoothing at 18-22BB if it feels jarring
- Postflop is unchanged (Monte Carlo)
- Stack size in ScreenScan comes from OCR of chip count / detected BB; null → defaults to 100BB (full stack path)
