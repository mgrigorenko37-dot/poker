/**
 * yolo-cards.ts
 *
 * YOLOv8-nano card detection running entirely in the browser via onnxruntime-web.
 * The model detects all 52 card classes from a canvas frame and assigns them
 * to hole cards (bottom of frame) vs board cards (middle of frame).
 *
 * Model: playing_cards.onnx (YOLOv8n, trained on Roboflow Playing Cards dataset)
 * Input:  [1, 3, 640, 640] float32, RGB, normalized [0,1], letterboxed
 * Output: [1, 56, 8400]  — 4 bbox coords + 52 class scores per anchor
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
const MODEL_URL = `${import.meta.env.BASE_URL}models/playing_cards.onnx`;
const INPUT_SIZE = 640;
const CONF_THRESHOLD = 0.25;      // lowered: 0.45 was too strict for most poker room card designs
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

export async function loadYoloModel(): Promise<ort.InferenceSession> {
  if (loadError) throw loadError;
  if (session) return session;
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    }).then(s => {
      session = s;
      return s;
    }).catch(e => {
      loadError = e;
      sessionPromise = null;
      throw e;
    });
  }
  return sessionPromise;
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
  const W = src.width, H = src.height;
  const scale = Math.min(INPUT_SIZE / W, INPUT_SIZE / H);
  const scaledW = Math.round(W * scale);
  const scaledH = Math.round(H * scale);
  const padX = (INPUT_SIZE - scaledW) / 2;
  const padY = (INPUT_SIZE - scaledH) / 2;

  const tmp = document.createElement('canvas');
  tmp.width = INPUT_SIZE;
  tmp.height = INPUT_SIZE;
  const ctx = tmp.getContext('2d')!;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(src, padX, padY, scaledW, scaledH);

  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const n = INPUT_SIZE * INPUT_SIZE;
  const float32 = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    float32[i]         = data[i * 4]     / 255; // R
    float32[n + i]     = data[i * 4 + 1] / 255; // G
    float32[2 * n + i] = data[i * 4 + 2] / 255; // B
  }

  return {
    tensor: new ort.Tensor('float32', float32, [1, 3, INPUT_SIZE, INPUT_SIZE]),
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
// Hole cards sit at the BOTTOM of the cropped table frame; board cards are in
// the middle. After a fold the hole cards disappear, leaving only board cards.
//
// Old approach (blindly take bottom-2) broke on fold: board cards that happen
// to be lowest got misassigned as hole cards.
//
// New approach — gap-based:
//   1. Sort all detections by cy descending (bottom of frame first).
//   2. Look for a significant vertical gap between position [1] and [2].
//      A gap ≥ 15 % of the frame means there's a clear separation between
//      two groups (hole cards below, board cards above).
//   3. The bottom group must have cy ≥ 0.50 (actually in the lower half of
//      the frame) — prevents assigning middle-table board cards as hole cards.
//   4. With only 2 cards visible: hole cards only if cy ≥ 0.50.
//   5. No valid hole assignment → return empty holeCards (fold / between hands).
//
// Constants are intentionally conservative so a mis-deal false-positive is
// much less likely than a missed detection — better to under-detect than to
// ghost the wrong hand into Telegram.
const MIN_HOLE_GAP = 0.15;   // minimum cy gap to separate hole from board
const MIN_HOLE_CY  = 0.50;   // hole cards must be in the bottom half of the crop

function assignCards(detections: Detection[]): { holeCards: string[]; boardCards: string[] } {
  // Deduplicate: keep highest-confidence detection per card label
  const byLabel = new Map<string, Detection>();
  for (const d of detections) {
    const existing = byLabel.get(d.label);
    if (!existing || d.confidence > existing.confidence) byLabel.set(d.label, d);
  }
  const unique = [...byLabel.values()];

  if (unique.length < 2) return { holeCards: [], boardCards: [] };

  // Sort by cy descending (bottom of frame first, i.e. highest cy = index 0)
  unique.sort((a, b) => b.cy - a.cy);

  if (unique.length === 2) {
    // Only 2 cards: treat as hole cards only when they're in the bottom half
    if (unique[0].cy >= MIN_HOLE_CY) {
      return { holeCards: unique.map(d => d.label), boardCards: [] };
    }
    // Too high up → board-only, no hole cards (folded)
    return { holeCards: [], boardCards: unique.sort((a, b) => a.cx - b.cx).map(d => d.label) };
  }

  // 3+ cards: check for a gap between position [1] (2nd from bottom) and [2]
  const gap = unique[1].cy - unique[2].cy;
  const avgHoleCy = (unique[0].cy + unique[1].cy) / 2;

  if (gap >= MIN_HOLE_GAP && avgHoleCy >= MIN_HOLE_CY) {
    // Clear separation: bottom 2 = hole cards, rest = board (sorted left→right)
    return {
      holeCards: [unique[0].label, unique[1].label],
      boardCards: unique.slice(2, 7).sort((a, b) => a.cx - b.cx).map(d => d.label),
    };
  }

  // No clear gap → no hole cards visible (player folded or between hands)
  return { holeCards: [], boardCards: [] };
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
