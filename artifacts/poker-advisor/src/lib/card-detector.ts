/**
 * card-detector.ts
 *
 * Pixel-based poker card detection — runs entirely in the browser, zero API calls.
 *
 * Algorithm:
 *  1. User calibrates card zones (click center of each card) once per session.
 *  2. Each frame: for each zone, extract the top-left corner patch (rank + suit area).
 *  3. Match rank using a 5×6 grid feature vector vs pre-rendered templates.
 *  4. Detect suit by foreground color (red → h/d, dark → c/s) and spatial distribution.
 *  5. Returns "Ah", "Ks", "Td", etc. — or null if the region looks empty/unclear.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CardZone {
  /** Center of the card in video pixel space */
  cx: number;
  cy: number;
  /** Estimated card dimensions in video pixels */
  w: number;
  h: number;
}

export interface Calibration {
  holeZones: [CardZone, CardZone];
  /** null = board not calibrated, user enters manually */
  boardZones: CardZone[] | null;
  videoW: number;
  videoH: number;
}

// ── Grid feature extraction ───────────────────────────────────────────────────

const PATCH_W = 30;
const PATCH_H = 40;
const GRID_COLS = 5;
const GRID_ROWS = 6;
const VEC_LEN = GRID_COLS * GRID_ROWS; // 30

function gridVector(data: Uint8ClampedArray, w: number, h: number, bgIsLight: boolean): Float32Array {
  const vec = new Float32Array(VEC_LEN);
  const cellW = w / GRID_COLS;
  const cellH = h / GRID_ROWS;
  for (let gy = 0; gy < GRID_ROWS; gy++) {
    for (let gx = 0; gx < GRID_COLS; gx++) {
      const x0 = Math.round(gx * cellW);
      const x1 = Math.round((gx + 1) * cellW);
      const y0 = Math.round(gy * cellH);
      const y1 = Math.round((gy + 1) * cellH);
      let ink = 0, total = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4;
          const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
          if (bgIsLight ? lum < 160 : lum > 96) ink++;
          total++;
        }
      }
      vec[gy * GRID_COLS + gx] = total > 0 ? ink / total : 0;
    }
  }
  return vec;
}

function l2(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) { const diff = a[i] - b[i]; d += diff * diff; }
  return Math.sqrt(d);
}

// ── Rank templates ────────────────────────────────────────────────────────────

export type RankTemplates = Map<string, Float32Array[]>; // rank → vectors per font

const RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
// '10' alias for T (some clients show "10")
const FONTS = [
  `bold ${Math.round(PATCH_H * 0.80)}px Arial, Helvetica, sans-serif`,
  `bold ${Math.round(PATCH_H * 0.80)}px Georgia, serif`,
  `bold ${Math.round(PATCH_H * 0.76)}px 'Trebuchet MS', sans-serif`,
];

let _templates: RankTemplates | null = null;

export function buildRankTemplates(): RankTemplates {
  if (_templates) return _templates;
  const result: RankTemplates = new Map();

  const c = document.createElement('canvas');
  c.width = PATCH_W;
  c.height = PATCH_H;
  const ctx = c.getContext('2d')!;

  for (const rank of RANKS) {
    const vecs: Float32Array[] = [];
    for (const font of FONTS) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, PATCH_W, PATCH_H);
      ctx.fillStyle = '#000';
      ctx.font = font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(rank === 'T' ? 'T' : rank, PATCH_W / 2, PATCH_H * 0.44);
      // Also add '10' variant for T
      const imgData = ctx.getImageData(0, 0, PATCH_W, PATCH_H);
      vecs.push(gridVector(imgData.data, PATCH_W, PATCH_H, true));
    }
    result.set(rank, vecs);
    // '10' alias
    if (rank === 'T') {
      const alias: Float32Array[] = [];
      for (const font of FONTS) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, PATCH_W, PATCH_H);
        ctx.fillStyle = '#000';
        // Smaller font to fit '10'
        const smallFont = font.replace(/\d+px/, `${Math.round(PATCH_H * 0.58)}px`);
        ctx.font = smallFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('10', PATCH_W / 2, PATCH_H * 0.44);
        const imgData = ctx.getImageData(0, 0, PATCH_W, PATCH_H);
        alias.push(gridVector(imgData.data, PATCH_W, PATCH_H, true));
      }
      result.set('10', alias);
    }
  }

  _templates = result;
  return result;
}

// ── Suit detection ────────────────────────────────────────────────────────────

function detectSuit(
  srcData: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  bgIsLight: boolean,
): string {
  // Suit symbol is in the bottom ~42% of the corner patch
  const suitY0 = Math.round(srcH * 0.58);
  const suitH  = srcH - suitY0;
  if (suitH < 4) return 'h';

  // Gather foreground pixel colors in the suit region
  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  // Also build a binarized mini-map for shape analysis
  const cols = srcW;
  const rows = suitH;
  const bin  = new Uint8Array(rows * cols);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = ((suitY0 + row) * srcW + col) * 4;
      const r = srcData[i], g = srcData[i + 1], b = srcData[i + 2];
      const lum = r * 0.299 + g * 0.587 + b * 0.114;
      const isFg = bgIsLight ? lum < 160 : lum > 96;
      if (isFg) {
        sumR += r; sumG += g; sumB += b; count++;
        bin[row * cols + col] = 1;
      }
    }
  }

  if (count === 0) return 'h';
  const avgR = sumR / count;
  const avgB = sumB / count;
  const isRed = (avgR - avgB) > 35;

  if (isRed) {
    // Hearts vs Diamonds
    // Hearts ♥: top edge has two separate blobs (left bump + right bump, gap in center)
    // Diamonds ♦: top edge comes to a single point
    let topRow = rows;
    outer:
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (bin[row * cols + col]) { topRow = row; break outer; }
      }
    }
    if (topRow < rows - 1) {
      let left = 0, center = 0, right = 0;
      const w3 = cols / 3;
      for (let row = topRow; row < Math.min(topRow + 4, rows); row++) {
        for (let col = 0; col < cols; col++) {
          if (!bin[row * cols + col]) continue;
          if (col < w3) left++;
          else if (col > cols * 0.66) right++;
          else center++;
        }
      }
      // Hearts: left AND right peaks with gap in center
      return (left > 0 && right > 0 && left + right > center) ? 'h' : 'd';
    }
    return 'h';
  } else {
    // Clubs vs Spades
    // Spades ♠: pointed top → top-center column dominates at the very top
    // Clubs ♣: three lobes → more spread across top (left+right lobes visible)
    const topSection = Math.round(rows * 0.38);
    let tLeft = 0, tCenter = 0, tRight = 0;
    const w3 = cols / 3;
    for (let row = 0; row < topSection; row++) {
      for (let col = 0; col < cols; col++) {
        if (!bin[row * cols + col]) continue;
        if (col < w3) tLeft++;
        else if (col > cols * 0.66) tRight++;
        else tCenter++;
      }
    }
    const total = tLeft + tCenter + tRight + 1;
    const centerRatio = tCenter / total;
    return centerRatio > 0.48 ? 's' : 'c';
  }
}

// ── Main detection function ───────────────────────────────────────────────────

/**
 * Detect a card from a live video canvas at the given calibrated zone.
 * @returns "Ah", "Ks", "Td", etc. — or null if detection is unreliable.
 */
export function detectCard(
  canvas: HTMLCanvasElement,
  zone: CardZone,
  templates: RankTemplates,
): string | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const vw = canvas.width, vh = canvas.height;
  const cardX = Math.round(zone.cx - zone.w / 2);
  const cardY = Math.round(zone.cy - zone.h / 2);

  // Bounds check
  if (cardX < 0 || cardY < 0 || cardX + zone.w > vw || cardY + zone.h > vh) return null;

  // Corner patch = top-left 30% × 46% of the card
  const cornerW = Math.max(12, Math.round(zone.w * 0.30));
  const cornerH = Math.max(16, Math.round(zone.h * 0.46));

  // Scale corner to template size
  const tmp = document.createElement('canvas');
  tmp.width = PATCH_W;
  tmp.height = PATCH_H;
  const tmpCtx = tmp.getContext('2d')!;
  tmpCtx.imageSmoothingEnabled = true;
  tmpCtx.imageSmoothingQuality = 'high';
  tmpCtx.drawImage(canvas, cardX, cardY, cornerW, cornerH, 0, 0, PATCH_W, PATCH_H);
  const patchData = tmpCtx.getImageData(0, 0, PATCH_W, PATCH_H);
  const d = patchData.data;

  // Detect background brightness
  let lumSum = 0, lumMax = 0, lumMin = 255;
  for (let i = 0; i < d.length; i += 4) {
    const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    lumSum += lum;
    if (lum > lumMax) lumMax = lum;
    if (lum < lumMin) lumMin = lum;
  }
  const avgLum = lumSum / (d.length / 4);
  const bgIsLight = avgLum > 128;

  // Too uniform → likely a card back or empty area
  if (lumMax - lumMin < 28) return null;

  // Rank region = top 58% of patch
  const rankH = Math.round(PATCH_H * 0.58);
  const rankVec = gridVector(d, PATCH_W, rankH, bgIsLight);

  // Match against all rank templates across all fonts
  let bestRank = 'A';
  let bestDist = Infinity;
  for (const [rank, fontVecs] of templates) {
    for (const tmplVec of fontVecs) {
      // Only compare rank region portion of template vector
      const tmplSlice = tmplVec.slice(0, rankVec.length);
      const dist = l2(rankVec, tmplSlice);
      if (dist < bestDist) { bestDist = dist; bestRank = rank; }
    }
  }

  // Confidence threshold — raised from 0.50 to 0.58 to accept more font variants
  if (bestDist > 0.58) return null;

  // Normalize 'T' alias
  const finalRank = bestRank === '10' ? 'T' : bestRank;

  // Detect suit
  const suit = detectSuit(d, PATCH_W, PATCH_H, bgIsLight);

  return finalRank + suit;
}

// ── Auto card detection (no calibration) ─────────────────────────────────────

export interface AutoDetectResult {
  /** Two hole cards at the bottom of the table, or null if not visible */
  holeZones: [CardZone, CardZone] | null;
  /** 0–5 board cards in the center of the table */
  boardZones: CardZone[];
  /** Diagnostic counters — how many column runs were found before maxCards cap */
  debug: {
    holeRunsTotal: number;   // runs found in hole band (before capping at 2)
    boardRunsTotal: number;  // runs found in board band (before capping at 5)
    shTable: number;         // scaled table height used
    shFull: number;          // scaled extended height (table + below)
  };
}

/**
 * Automatically find card positions by looking for white/light rectangles
 * on the poker table. No calibration required — works on any client.
 *
 * @param canvas  Full-resolution video canvas (drawn from video element)
 * @param table   Table bounds from green-pixel detection (or null → use full canvas)
 */
export function autoDetectCards(
  canvas: HTMLCanvasElement,
  table: { x: number; y: number; w: number; h: number } | null,
): AutoDetectResult {
  const tx = table?.x ?? 0;
  const ty = table?.y ?? 0;
  const tw = table?.w ?? canvas.width;
  const th = table?.h ?? canvas.height;

  // Work at reduced scale for speed
  const scale = Math.min(1, 320 / tw);
  const sw = Math.round(tw * scale);
  const shTable = Math.round(th * scale); // table-only scaled height (used for board bands)

  // Extend the crop all the way to the canvas bottom.
  // Reason: clients like Pokerist render hole cards BELOW the green felt oval
  // (in the wooden border / player zone), so if we only crop to the table
  // bounds we miss the hole cards entirely.
  const thExt = Math.max(th, canvas.height - ty); // from table top to screen bottom
  const sh    = Math.round(thExt * scale);         // total scan height (extended)

  const tmp = document.createElement('canvas');
  tmp.width = sw; tmp.height = sh;
  const tctx = tmp.getContext('2d')!;
  tctx.drawImage(canvas, tx, ty, tw, thExt, 0, 0, sw, sh);
  const { data } = tctx.getImageData(0, 0, sw, sh);

  // ── Column projection in an absolute-pixel band ──────────────────────────
  // y0px / y1px are rows in the SCALED canvas (not fractions).
  // Returns { zones, totalRuns } — totalRuns is count before the maxCards cap
  function findCardsInBandPx(
    y0px: number,
    y1px: number,
    maxCards: number,
  ): { zones: CardZone[]; totalRuns: number } {
    const y0 = Math.max(0, y0px);
    const y1 = Math.min(sh - 1, y1px);
    const bh = y1 - y0;
    if (bh < 4) return { zones: [], totalRuns: 0 };

    // Column brightness score: fraction of bright pixels in this band column
    const colScore = new Float32Array(sw);
    for (let x = 0; x < sw; x++) {
      let bright = 0;
      for (let y = y0; y < y1; y++) {
        const i = (y * sw + x) * 4;
        // "Card face" = light colored: not strongly green (felt), not dark
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const lum = r * 0.299 + g * 0.587 + b * 0.114;
        // Lowered from 175→145 to catch off-white/cream card faces
        const isCardPixel = lum > 145 && !(g > r * 1.10 && g > b * 1.05);
        if (isCardPixel) bright++;
      }
      colScore[x] = bright / bh;
    }

    // Find connected runs of columns where score > threshold
    const THRESH = 0.18; // lowered from 0.25
    const MIN_CARD_W = Math.round(sw * 0.03);
    const MAX_CARD_W = Math.round(sw * 0.26); // raised from 0.20

    const runs: { x0: number; x1: number }[] = [];
    let inRun = false, runStart = 0;
    for (let x = 0; x < sw; x++) {
      if (!inRun && colScore[x] >= THRESH) { inRun = true; runStart = x; }
      else if (inRun && (colScore[x] < THRESH || x === sw - 1)) {
        const runW = x - runStart;
        if (runW >= MIN_CARD_W && runW <= MAX_CARD_W) {
          runs.push({ x0: runStart, x1: x });
        }
        inRun = false;
      }
    }

    if (runs.length === 0) return { zones: [], totalRuns: 0 };

    const totalRuns = runs.length; // before cap

    // Sort by score sum (brightest first) and take top maxCards
    const scored = runs.map(r => {
      let sum = 0;
      for (let x = r.x0; x < r.x1; x++) sum += colScore[x];
      return { ...r, sum };
    }).sort((a, b) => b.sum - a.sum).slice(0, maxCards);

    // Re-sort left-to-right
    scored.sort((a, b) => a.x0 - b.x0);

    const zones = scored.map(r => {
      const cx_s = (r.x0 + r.x1) / 2;
      const cw_s = r.x1 - r.x0;

      // Find the vertical centroid of bright pixels in this column run
      let ySum = 0, yCount = 0;
      let yMin = y1, yMax = y0;
      for (let x = r.x0; x < r.x1; x++) {
        for (let y = y0; y < y1; y++) {
          const i = (y * sw + x) * 4;
          const r2 = data[i], g = data[i + 1], b = data[i + 2];
          const lum = r2 * 0.299 + g * 0.587 + b * 0.114;
          const isCardPixel = lum > 145 && !(g > r2 * 1.10 && g > b * 1.05);
          if (isCardPixel) {
            ySum += y; yCount++;
            if (y < yMin) yMin = y;
            if (y > yMax) yMax = y;
          }
        }
      }
      const cy_s = yCount > 0 ? ySum / yCount : (y0 + y1) / 2;
      const ch_s = yCount > 0 ? Math.max(yMax - yMin + 2, cw_s * 1.3) : cw_s * 1.4;

      return {
        cx: tx + cx_s / scale,
        cy: ty + cy_s / scale,
        w:  cw_s / scale,
        h:  ch_s / scale,
      } as CardZone;
    });

    return { zones, totalRuns };
  }

  // Board cards: search middle of the TABLE only (fractions of shTable)
  const boardResult = findCardsInBandPx(
    Math.round(0.22 * shTable),
    Math.round(0.70 * shTable),
    5,
  );

  // Hole cards: search from mid-table ALL THE WAY to canvas bottom.
  // This handles both standard layouts (cards on felt) and Pokerist-style
  // (cards in the wooden border below the green oval).
  const holeResult = findCardsInBandPx(
    Math.round(0.50 * shTable),
    sh, // extends to canvas bottom
    2,
  );

  const holeZones: [CardZone, CardZone] | null =
    holeResult.zones.length === 2
      ? [holeResult.zones[0], holeResult.zones[1]]
      : null;

  return {
    holeZones,
    boardZones: boardResult.zones,
    debug: {
      holeRunsTotal:  holeResult.totalRuns,
      boardRunsTotal: boardResult.totalRuns,
      shTable,
      shFull: sh,
    },
  };
}

// ── Calibration helpers (kept for manual override if needed) ──────────────────

/**
 * Estimate card size from two hole card click positions.
 * Distance between centers ÷ 1.45 ≈ card width (cards overlap slightly in hand).
 */
export function estimateCardSize(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
): { w: number; h: number } {
  const dist = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
  const w = Math.max(24, dist / 1.45);
  const h = w * 1.38; // standard poker card aspect ~2.5:3.5
  return { w, h };
}

/**
 * Estimate board card zones from the first board card click position.
 * Standard layout: 5 cards evenly spaced horizontally.
 */
export function estimateBoardZones(
  firstClick: { x: number; y: number },
  cardW: number,
  cardH: number,
): CardZone[] {
  const spacing = cardW * 1.11;
  return [0, 1, 2, 3, 4].map(i => ({
    cx: firstClick.x + i * spacing,
    cy: firstClick.y,
    w: cardW,
    h: cardH,
  }));
}

/** Build a Calibration object from click points. */
export function buildCalibration(
  hole1: { x: number; y: number },
  hole2: { x: number; y: number },
  board1: { x: number; y: number } | null,
  videoW: number,
  videoH: number,
): Calibration {
  const { w, h } = estimateCardSize(hole1, hole2);
  const holeZones: [CardZone, CardZone] = [
    { cx: hole1.x, cy: hole1.y, w, h },
    { cx: hole2.x, cy: hole2.y, w, h },
  ];
  const boardZones = board1 ? estimateBoardZones(board1, w, h) : null;
  return { holeZones, boardZones, videoW, videoH };
}

const CALIB_KEY = 'pt_calib_v1';

export function saveCalibration(calib: Calibration): void {
  try { localStorage.setItem(CALIB_KEY, JSON.stringify(calib)); } catch { /* ignore */ }
}

export function loadCalibration(videoW: number, videoH: number): Calibration | null {
  try {
    const raw = localStorage.getItem(CALIB_KEY);
    if (!raw) return null;
    const c: Calibration = JSON.parse(raw);
    // Only reuse if resolution matches (within 10%)
    if (Math.abs(c.videoW - videoW) / videoW > 0.10) return null;
    if (Math.abs(c.videoH - videoH) / videoH > 0.10) return null;
    return c;
  } catch { return null; }
}

export function clearCalibration(): void {
  try { localStorage.removeItem(CALIB_KEY); } catch { /* ignore */ }
}
