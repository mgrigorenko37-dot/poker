/**
 * yolo-cards.ts
 *
 * YOLOv8 card detection running entirely in the browser via onnxruntime-web.
 * The model detects all 52 card classes from a canvas frame and assigns them
 * to hole cards (bottom of frame) vs board cards (middle of frame).
 *
 * Model: best.onnx (custom-trained YOLOv8, universal_poker_cards_fast)
 * Input:  [1, 3, 768, 768] float32, RGB, normalized [0,1], letterboxed
 * Output: [1, 56, 12096]  — 4 bbox coords + 52 class scores per anchor
 *
 * Fallback: playing_cards.onnx (YOLOv8n 640×640) used if best.onnx not found.
 */

import * as ort from 'onnxruntime-web';

// ── WASM setup ────────────────────────────────────────────────────────────────
// Vite 7 blocks dynamic import() of .mjs files from public/ — onnxruntime-web
// uses dynamic import to load its worker .mjs files, which Vite intercepts and
// rejects. Loading from CDN bypasses this restriction while keeping the .onnx
// model file served locally. Single-threaded avoids SharedArrayBuffer / COOP-COEP.
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/';
ort.env.wasm.numThreads = 1;

// ── Constants ──────────────────────────────────────────────────────────────────
// Primary: custom-trained 768×768 model. Fallback: original 640×640.
const MODEL_URL_PRIMARY  = `${import.meta.env.BASE_URL}models/best.onnx`;
const MODEL_URL_FALLBACK = `${import.meta.env.BASE_URL}models/playing_cards.onnx`;
// Map: model URL → expected input spatial size. parseOutput reads the anchor
// count from output.dims dynamically, so 12096 vs 8400 is handled automatically.
const MODEL_INPUT_SIZES: Record<string, number> = {
  [MODEL_URL_PRIMARY]:  768,
  [MODEL_URL_FALLBACK]: 640,
};
// Effective input size — updated once the model finishes loading.
let activeInputSize = 768;
const CONF_THRESHOLD = 0.15;      // lowered from 0.25: mobile games use stylized card art that scores lower
const NMS_IOU_THRESHOLD = 0.45;
const MAX_DETECTIONS = 7; // 2 hole + 5 board

// ── Class names (from model metadata, index 0-51) ─────────────────────────────
// Format: '10C','10D','10H','10S','2C',...,'QS'
const MODEL_CLASS_NAMES: string[] = [
  '10C','10D','10H','10S',
  '2C','2D','2H','2S',
  '3C','3D','3H','3S',
  '4C','4D','4H','4S',
  '5C','5D','5H','5S',
  '6C','6D','6H','6S',
  '7C','7D','7H','7S',
  '8C','8D','8H','8S',
  '9C','9D','9H','9S',
  'AC','AD','AH','AS',
  'JC','JD','JH','JS',
  'KC','KD','KH','KS',
  'QC','QD','QH','QS',
];

/**
 * Convert model label (e.g. "10C", "AH", "KS") to poker engine format ("Tc", "Ah", "Ks").
 */
function toCardString(label: string): string {
  const suit = label.slice(-1).toLowerCase();          // 'c','d','h','s'
  const rankRaw = label.slice(0, -1);                  // '10','A','K','2',...
  const rank = rankRaw === '10' ? 'T' : rankRaw;       // 'T','A','K','2',...
  return rank + suit;
}

// Pre-build lookup: model index → poker card string
const CLASS_TO_CARD: string[] = MODEL_CLASS_NAMES.map(toCardString);

// ── Session singleton ─────────────────────────────────────────────────────────
let session: ort.InferenceSession | null = null;
let sessionPromise: Promise<ort.InferenceSession> | null = null;
let loadError: Error | null = null;
// Which model URL ended up loading (shown in debug panel)
export let loadedModelUrl = '';
// Export model URL constants for debug panel
export { MODEL_URL_PRIMARY, MODEL_URL_FALLBACK };

export async function loadYoloModel(): Promise<ort.InferenceSession> {
  if (loadError) throw loadError;
  if (session) return session;
  if (!sessionPromise) {
    sessionPromise = (async () => {
      // Try primary (best.onnx 768×768) first; fall back to original 640×640.
      const urls = [MODEL_URL_PRIMARY, MODEL_URL_FALLBACK];
      let lastErr: unknown;
      for (const url of urls) {
        try {
          const s = await ort.InferenceSession.create(url, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all',
          });
          session = s;
          loadedModelUrl = url;
          // Update active input size to match the loaded model
          activeInputSize = MODEL_INPUT_SIZES[url] ?? 640;
          console.log(`[yolo] loaded model: ${url} (input ${activeInputSize}×${activeInputSize})`);
          return s;
        } catch (e) {
          console.warn(`[yolo] failed to load ${url}:`, e);
          lastErr = e;
        }
      }
      loadError = lastErr as Error;
      sessionPromise = null;
      throw lastErr;
    })();
  }
  return sessionPromise;
}

/**
 * Force-load a specific model URL, replacing the current session.
 * Used by the debug panel to let the user try the fallback model.
 */
export async function switchYoloModel(url: string): Promise<void> {
  // Tear down existing session
  session = null;
  sessionPromise = null;
  loadError = null;
  loadedModelUrl = '';
  activeInputSize = MODEL_INPUT_SIZES[url] ?? 640;

  const s = await ort.InferenceSession.create(url, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  session = s;
  loadedModelUrl = url;
  activeInputSize = MODEL_INPUT_SIZES[url] ?? 640;
  console.log(`[yolo] switched to model: ${url} (input ${activeInputSize}×${activeInputSize})`);
}

// ── Types ──────────────────────────────────────────────────────────────────────
export interface Detection {
  label: string;      // poker engine format: "Ah", "Kd", etc.
  confidence: number;
  cx: number;         // 0-1 relative to original canvas
  cy: number;
  w: number;
  h: number;
}

export interface YoloCardResult {
  holeCards: string[];          // 2 card strings (bottom of frame = hero)
  boardCards: string[];         // 0-5 card strings (middle of frame)
  allDetections: Detection[];   // for debug overlay
}

// ── Preprocessing ──────────────────────────────────────────────────────────────
function preprocessCanvas(src: HTMLCanvasElement): {
  tensor: ort.Tensor;
  padX: number;
  padY: number;
  scaledW: number;
  scaledH: number;
} {
  const S = activeInputSize;  // 768 for best.onnx, 640 for fallback
  const W = src.width, H = src.height;
  const scale = Math.min(S / W, S / H);
  const scaledW = Math.round(W * scale);
  const scaledH = Math.round(H * scale);
  const padX = (S - scaledW) / 2;
  const padY = (S - scaledH) / 2;

  const tmp = document.createElement('canvas');
  tmp.width = S;
  tmp.height = S;
  const ctx = tmp.getContext('2d')!;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, S, S);
  ctx.drawImage(src, padX, padY, scaledW, scaledH);

  const { data } = ctx.getImageData(0, 0, S, S);
  const n = S * S;
  const float32 = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    float32[i]         = data[i * 4]     / 255; // R
    float32[n + i]     = data[i * 4 + 1] / 255; // G
    float32[2 * n + i] = data[i * 4 + 2] / 255; // B
  }

  return {
    tensor: new ort.Tensor('float32', float32, [1, 3, S, S]),
    padX,
    padY,
    scaledW,
    scaledH,
  };
}

// ── Post-processing ────────────────────────────────────────────────────────────
function parseOutput(
  output: ort.Tensor,
  padX: number,
  padY: number,
  scaledW: number,
  scaledH: number,
): Detection[] {
  // output.dims = [1, 56, 8400]
  const [, , anchors] = output.dims as [number, number, number];
  const data = output.data as Float32Array;
  const NUM_CLASSES = MODEL_CLASS_NAMES.length; // 52

  const detections: Detection[] = [];

  for (let a = 0; a < anchors; a++) {
    // Find max class score for this anchor
    let maxScore = 0, maxClass = 0;
    for (let c = 0; c < NUM_CLASSES; c++) {
      const score = data[(4 + c) * anchors + a];
      if (score > maxScore) { maxScore = score; maxClass = c; }
    }
    if (maxScore < CONF_THRESHOLD) continue;
    if (maxClass >= CLASS_TO_CARD.length) continue;

    // Bbox in 640×640 space (center format)
    const cx640 = data[0 * anchors + a];
    const cy640 = data[1 * anchors + a];
    const w640  = data[2 * anchors + a];
    const h640  = data[3 * anchors + a];

    // Map back to original canvas coordinates (0-1)
    const cx = (cx640 - padX) / scaledW;
    const cy = (cy640 - padY) / scaledH;
    const w  = w640 / scaledW;
    const h  = h640 / scaledH;

    // Discard detections outside the unpadded area
    if (cx < 0 || cx > 1 || cy < 0 || cy > 1) continue;

    detections.push({
      label: CLASS_TO_CARD[maxClass],
      confidence: maxScore,
      cx, cy, w, h,
    });
  }

  return detections;
}

function iou(a: Detection, b: Detection): number {
  const ax1 = a.cx - a.w / 2, ay1 = a.cy - a.h / 2;
  const ax2 = a.cx + a.w / 2, ay2 = a.cy + a.h / 2;
  const bx1 = b.cx - b.w / 2, by1 = b.cy - b.h / 2;
  const bx2 = b.cx + b.w / 2, by2 = b.cy + b.h / 2;
  const interW = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
  const interH = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
  const inter = interW * interH;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function nms(detections: Detection[]): Detection[] {
  detections.sort((a, b) => b.confidence - a.confidence);
  const kept: Detection[] = [];
  const suppressed = new Set<number>();

  for (let i = 0; i < detections.length; i++) {
    if (suppressed.has(i)) continue;
    kept.push(detections[i]);
    if (kept.length >= MAX_DETECTIONS) break;
    for (let j = i + 1; j < detections.length; j++) {
      if (!suppressed.has(j) && iou(detections[i], detections[j]) > NMS_IOU_THRESHOLD) {
        suppressed.add(j);
      }
    }
  }
  return kept;
}

// ── Layout heuristic ───────────────────────────────────────────────────────────
// Hole cards sit at the BOTTOM of the frame; board cards are in the middle.
//
// Primary strategy: gap-based (find the biggest vertical jump in the sorted list;
// if it falls between position 1 and 2, bottom-2 = hole cards).
// This works regardless of absolute cy values — it only needs relative positions,
// so it handles full-frame captures, windowed captures, and mobile aspect ratios.
//
// Secondary strategy: relative-median fallback.
// If no clear gap is found, check whether the bottom-2 cards are meaningfully
// lower than the median cy of all detections. A small margin (2% of frame) is
// enough to tell hole cards from a tight cluster of board cards.
//
// Showdown note: at showdown other players' cards appear near the hero's at the
// bottom of the frame. When multiple cards are in the hole zone, pick the pair
// with the highest holeScore (bottom + rightmost) — that's the hero position in
// most mobile poker apps (Pokerist, WPC, GGPoker mobile, PokerStars mobile).
const MIN_HOLE_GAP      = 0.06;  // minimum cy gap to separate hole from board
const MIN_RELATIVE_DIFF = 0.02;  // relative fallback: bottom-2 must be > median by this margin

/**
 * Score used to rank candidate "hole card" pairs at showdown.
 * Higher score = more likely to be the hero's hole cards.
 * Prioritises: (1) low in frame, (2) right side of frame (mobile hero position).
 */
function holeScore(d: Detection): number {
  return d.cy * 0.7 + d.cx * 0.3;
}

function assignCards(detections: Detection[]): { holeCards: string[]; boardCards: string[] } {
  // Deduplicate: keep highest-confidence detection per card label
  const byLabel = new Map<string, Detection>();
  for (const d of detections) {
    const existing = byLabel.get(d.label);
    if (!existing || d.confidence > existing.confidence) byLabel.set(d.label, d);
  }
  const unique = [...byLabel.values()];

  if (unique.length < 2) return { holeCards: [], boardCards: [] };

  // Sort by cy descending (bottom of frame first = highest cy at index 0)
  unique.sort((a, b) => b.cy - a.cy);

  if (unique.length === 2) {
    // Only 2 cards visible — preflop before board, or fold
    return { holeCards: unique.map(d => d.label), boardCards: [] };
  }

  // ── Primary: gap-based ────────────────────────────────────────────────────
  // Find the largest vertical gap in the sorted sequence.
  let maxGap = 0, maxGapIdx = 1;
  for (let i = 1; i < unique.length; i++) {
    const gap = unique[i - 1].cy - unique[i].cy;
    if (gap > maxGap) { maxGap = gap; maxGapIdx = i; }
  }

  if (maxGap >= MIN_HOLE_GAP && maxGapIdx === 2) {
    // Biggest gap is between position 1 and 2 → bottom 2 are hole cards
    return {
      holeCards:  unique.slice(0, 2).sort((a, b) => a.cx - b.cx).map(d => d.label),
      boardCards: unique.slice(2).sort((a, b) => a.cx - b.cx).map(d => d.label),
    };
  }

  if (maxGap >= MIN_HOLE_GAP && maxGapIdx === 1) {
    // Biggest gap between 0 and 1 — one isolated bottom card (can't be a full hole pair)
    // Could be a showdown or misdetection. Check if we have ≥ 2 cards below the gap
    // by looking for the next significant gap starting from 2.
    // Fall through to secondary strategy for now.
  }

  // ── Secondary: absolute zone split ───────────────────────────────────────
  // Use a dynamic threshold: the midpoint between the 2nd and 3rd card cy.
  // This adapts to whatever vertical range the cards occupy in the frame.
  if (unique.length >= 3) {
    const dynamicThreshold = (unique[1].cy + unique[2].cy) / 2;
    const inHoleZone  = unique.filter(d => d.cy > dynamicThreshold);
    const inBoardZone = unique.filter(d => d.cy <= dynamicThreshold);

    if (inHoleZone.length >= 2 && inBoardZone.length >= 1) {
      // Showdown-aware: pick best-scoring pair from hole zone
      if (inHoleZone.length === 2) {
        return {
          holeCards:  inHoleZone.sort((a, b) => a.cx - b.cx).map(d => d.label),
          boardCards: inBoardZone.sort((a, b) => a.cx - b.cx).map(d => d.label),
        };
      }
      // 3+ in hole zone (showdown with multiple hands visible) — pick best pair
      let bestPair: [Detection, Detection] | null = null;
      let bestPairScore = -1;
      for (let i = 0; i < inHoleZone.length; i++) {
        for (let j = i + 1; j < inHoleZone.length; j++) {
          const score = holeScore(inHoleZone[i]) + holeScore(inHoleZone[j]);
          if (score > bestPairScore) {
            bestPairScore = score;
            bestPair = [inHoleZone[i], inHoleZone[j]];
          }
        }
      }
      const holeSet = new Set(bestPair!.map(d => d.label));
      const board = unique.filter(d => !holeSet.has(d.label)).sort((a, b) => a.cx - b.cx);
      return {
        holeCards:  bestPair!.sort((a, b) => a.cx - b.cx).map(d => d.label),
        boardCards: board.map(d => d.label),
      };
    }
  }

  // ── Tertiary: relative-median fallback ────────────────────────────────────
  // All cards at similar heights (no clear zone split). Use the bottom-2 as
  // hole cards if they're at least MIN_RELATIVE_DIFF below the median.
  if (unique.length >= 3) {
    const medianCy    = unique[Math.floor(unique.length / 2)].cy;
    const bottom2Avg  = (unique[0].cy + unique[1].cy) / 2;
    if (bottom2Avg > medianCy + MIN_RELATIVE_DIFF) {
      return {
        holeCards:  unique.slice(0, 2).sort((a, b) => a.cx - b.cx).map(d => d.label),
        boardCards: unique.slice(2).sort((a, b) => a.cx - b.cx).map(d => d.label),
      };
    }
  }

  // All cards truly at the same height — fold / between hands / animation frame.
  // Return as board cards only (NOT empty) to avoid false fold detection.
  return {
    holeCards:  [],
    boardCards: unique.sort((a, b) => a.cx - b.cx).map(d => d.label),
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface YoloCardResult {
  holeCards: string[];          // 2 card strings (bottom of frame = hero)
  boardCards: string[];         // 0-5 card strings (middle of frame)
  allDetections: Detection[];   // for debug overlay
  folded: boolean;              // true when cards were found but no hole cards (fold detected)
}

/**
 * Run card detection on a canvas element.
 *
 * Returns:
 *   - { holeCards: [..2], boardCards: [...], folded: false } — normal hand
 *   - { holeCards: [], boardCards: [...], folded: true }     — fold detected
 *     (board cards still present but no hole cards in frame)
 *   - null — nothing useful found (< 2 cards total, model not warmed up yet, etc.)
 */
export async function detectCards(canvas: HTMLCanvasElement): Promise<YoloCardResult | null> {
  const sess = await loadYoloModel();

  const { tensor, padX, padY, scaledW, scaledH } = preprocessCanvas(canvas);
  const feeds: Record<string, ort.Tensor> = {};
  feeds[sess.inputNames[0]] = tensor;

  const results = await sess.run(feeds);
  const output = results[sess.outputNames[0]];

  const raw = parseOutput(output, padX, padY, scaledW, scaledH);
  const detections = nms(raw);

  // Debug: always log detection count and positions so layout issues are visible
  console.debug(
    `[yolo] raw=${raw.length} after-nms=${detections.length}`,
    detections.map(d => `${d.label}@${(d.confidence * 100).toFixed(0)}%(cy=${d.cy.toFixed(2)})`).join(' '),
  );

  // Need at least 2 detections to say anything meaningful
  if (detections.length < 2) return null;

  const { holeCards, boardCards } = assignCards(detections);

  if (holeCards.length < 2) {
    // Cards are on screen but none assigned to hole zone → fold / between hands
    return { holeCards: [], boardCards, allDetections: detections, folded: true };
  }

  return { holeCards, boardCards, allDetections: detections, folded: false };
}

/**
 * Crop a region from a canvas and return a new canvas.
 * Used to isolate the poker table before running YOLO.
 */
export function cropCanvas(
  src: HTMLCanvasElement,
  x: number, y: number, w: number, h: number,
): HTMLCanvasElement {
  const dst = document.createElement('canvas');
  dst.width = w;
  dst.height = h;
  dst.getContext('2d')!.drawImage(src, x, y, w, h, 0, 0, w, h);
  return dst;
}
