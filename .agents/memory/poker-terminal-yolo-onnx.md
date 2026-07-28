---
name: Poker Terminal YOLOv8 ONNX integration
description: How YOLOv8-nano card detection is integrated into ScreenScan, model source, class format, and WASM setup.
---

## Model
- File: `artifacts/poker-advisor/public/models/playing_cards.onnx` (11.7 MB, YOLOv8n)
- Source: `mustafakemal0146/playing-cards-yolov8` on HuggingFace (Roboflow playing cards dataset, 50 epochs, T4)
- 52 classes, index 0-51: `{0:'10C',1:'10D',2:'10H',3:'10S',4:'2C',...,51:'QS'}` — uppercase rank, uppercase suit
- Converted to card engine format by `toCardString()`: `'10C'→'Tc'`, `'AH'→'Ah'`, etc.
- Input: `[1,3,640,640]` float32, RGB, [0,1], letterboxed with gray padding
- Output: `[1,56,8400]` — 4 bbox coords + 52 class scores per anchor

## WASM setup
- `ort-wasm-simd-threaded.wasm` and `.asyncify.wasm` copied to `public/models/`
- `ort.env.wasm.wasmPaths = \`\${import.meta.env.BASE_URL}models/\`` 
- `ort.env.wasm.numThreads = 1` — avoids SharedArrayBuffer / COOP-COEP header requirement

## Inference module
- `artifacts/poker-advisor/src/lib/yolo-cards.ts` — full ONNX inference pipeline
- `detectCards(canvas)` → `{holeCards, boardCards, allDetections}` or null
- Layout heuristic: sort by cy descending; bottom 2 = hole cards, rest sorted by cx = board cards
- Confidence threshold: 0.45; NMS IoU: 0.45; max 7 detections

## Integration in ScreenScan
- Model preloaded on mount via `loadYoloModel()` useEffect; button disabled until ready
- `scanTick` flow: draw frame → `findTableBounds` → `cropCanvas` → `detectCards` → POST `/api/vision/scan-cards`
- `/api/vision/scan-cards` already existed (no Gemini, accepts pre-parsed cards, runs full GTO + Telegram/WS)
- Cooldown reduced from 800ms (Gemini) to 300ms (YOLO is local ~50-100ms)

**Why:** Gemini Vision requires API key + network round-trip (~1-2s); YOLOv8-nano ONNX runs locally in ~50-100ms, no API key needed, works offline.
