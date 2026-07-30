---
name: Poker Terminal YOLOv8 ONNX integration
note: wasmPaths must point to CDN (not local public/) — Vite 7 blocks dynamic import() of .mjs files from public/; see fix in yolo-cards.ts
description: How YOLOv8-nano card detection is integrated into ScreenScan, model source, class format, and WASM setup.
---

## Models
- **Primary**: `artifacts/poker-advisor/public/models/best.onnx` (43 MB, custom-trained YOLOv8, `universal_poker_cards_fast`)
  - Input: `[1,3,768,768]`, Output: `[1,56,12096]` — 12096 anchors = (768/8)²+(768/16)²+(768/32)²
- **Fallback**: `artifacts/poker-advisor/public/models/playing_cards.onnx` (12 MB, YOLOv8n)
  - Input: `[1,3,640,640]`, Output: `[1,56,8400]`
- Both use identical class ordering (Roboflow `augmented-startups/playing-cards-ow27d`): `{0:'10C',...,51:'QS'}`

## Loading strategy
- `loadYoloModel()` tries `best.onnx` first, falls back to `playing_cards.onnx` on error
- `activeInputSize` (module-level `let`) is set to 768 or 640 after load — `preprocessCanvas` reads it dynamically
- `parseOutput` reads `output.dims[2]` for anchor count → works for both 8400 and 12096 without code changes
- `loadedModelUrl` exported for debug panel display

## WASM setup
- `ort.env.wasm.wasmPaths` points to CDN (`https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/`) — Vite 7 blocks dynamic import of .mjs from public/
- `ort.env.wasm.numThreads = 1` — avoids SharedArrayBuffer / COOP-COEP header requirement

## Integration in ScreenScan
- Model preloaded on mount via `loadYoloModel()` useEffect; button disabled until ready
- `scanTick` flow: draw frame → `findTableBounds` → `cropCanvas` → `detectCards` → POST `/api/vision/scan-cards`
- Confidence threshold: 0.25; NMS IoU: 0.45; max 7 detections
- Layout heuristic: gap-based cy separation (MIN_HOLE_GAP=0.10, MIN_HOLE_CY=0.50)

**Why primary 768:** custom-trained model covers more poker room card designs; higher resolution improves small-card detection accuracy.
