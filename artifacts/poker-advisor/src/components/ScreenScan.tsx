/**
 * ScreenScan — real-time poker screen analysis
 * - Two parallel Tesseract workers (hole vs board)
 * - Per-region pixel fingerprint to skip unchanged cards
 * - Otsu dynamic threshold + 5× upscale for better OCR
 * - Adjustable card-height slider (tune for your TON Poker window size)
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createWorker, type Worker } from 'tesseract.js';
import { cn } from '@/lib/utils';
import { runMonteCarloSim, parseCard, type Card } from '@/lib/poker';
import { getFullAdvice, type FullAdvice, type Position } from '@/lib/poker-gto';
import { TelegramSetup } from '@/components/TelegramSetup';
import { CardPicker } from '@/components/CardPicker';

// ─── Types ────────────────────────────────────────────────────────────────────
type Phase = 'idle' | 'requesting' | 'calibrating' | 'loading-ocr' | 'scanning';
interface CardRegion { label: string; cx: number; cy: number }
interface SavedCalibration { regions: CardRegion[]; cardSizePct: number; version: number }
// Optional sub-calibration flows, entered from the scanning panel (don't touch
// the mandatory card calibration above). 'money' captures pot/bet-to-call text
// positions for OCR; 'seats' captures opponent seat positions for fold/pixel
// based player-count detection.
type SubCal = null | 'money' | 'seats';
interface MoneyCalibration { pot: CardRegion | null; bet: CardRegion | null; wPct: number; hPct: number; version: number }
interface SeatCalibration { seats: CardRegion[]; sizePct: number; version: number }

const CALIBRATION_STEPS = [
  { label: 'Hole 1',  hint: 'Кликни на ЦЕНТР первой своей карты' },
  { label: 'Hole 2',  hint: 'Кликни на ЦЕНТР второй своей карты' },
  { label: 'Board 1', hint: 'Флоп — 1-я карта (или «Пропустить»)' },
  { label: 'Board 2', hint: 'Флоп — 2-я карта (или «Пропустить»)' },
  { label: 'Board 3', hint: 'Флоп — 3-я карта (или «Пропустить»)' },
  { label: 'Board 4', hint: 'Тёрн (или «Пропустить»)' },
  { label: 'Board 5', hint: 'Ривер (или «Пропустить»)' },
];
const STORAGE_KEY = 'poker_screen_calibration_v3';
const RANK_MAP: Record<string, string> = {
  a:'A',A:'A',k:'K',K:'K',q:'Q',Q:'Q',j:'J',J:'J',t:'T',T:'T',
  '1':'T','10':'T','0':'T','2':'2','3':'3','4':'4','5':'5','6':'6','7':'7','8':'8','9':'9',
};

// ─── Persistence ──────────────────────────────────────────────────────────────
function saveCalibration(r: CardRegion[], cardSizePct: number) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ regions: r, cardSizePct, version: 3 })); } catch {}
}
function loadCalibration(): SavedCalibration | null {
  try {
    const d: SavedCalibration = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return d?.version === 3 && d.regions?.length >= 2 ? d : null;
  } catch { return null; }
}

const MONEY_STORAGE_KEY = 'poker_money_calibration_v1';
const SEAT_STORAGE_KEY  = 'poker_seat_calibration_v1';

function saveMoneyCalibration(m: MoneyCalibration) {
  try { localStorage.setItem(MONEY_STORAGE_KEY, JSON.stringify(m)); } catch {}
}
function loadMoneyCalibration(): MoneyCalibration | null {
  try {
    const d: MoneyCalibration = JSON.parse(localStorage.getItem(MONEY_STORAGE_KEY) ?? 'null');
    return d?.version === 1 && (d.pot || d.bet) ? d : null;
  } catch { return null; }
}
function saveSeatCalibration(s: SeatCalibration) {
  try { localStorage.setItem(SEAT_STORAGE_KEY, JSON.stringify(s)); } catch {}
}
function loadSeatCalibration(): SeatCalibration | null {
  try {
    const d: SeatCalibration = JSON.parse(localStorage.getItem(SEAT_STORAGE_KEY) ?? 'null');
    return d?.version === 1 && d.seats?.length > 0 ? d : null;
  } catch { return null; }
}

// ─── Otsu threshold ───────────────────────────────────────────────────────────
function otsuThreshold(data: Uint8ClampedArray): number {
  const hist = new Array(256).fill(0);
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4)
    hist[Math.round((data[i] + data[i+1] + data[i+2]) / 3)]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, T = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; T = t; }
  }
  return T;
}

// ─── Image helpers ────────────────────────────────────────────────────────────
function extractCardRegion(src: HTMLCanvasElement, cx: number, cy: number, cw: number, ch: number): HTMLCanvasElement {
  const x = Math.round(cx * src.width  - cw / 2);
  const y = Math.round(cy * src.height - ch / 2);
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  out.getContext('2d')!.drawImage(src, x, y, cw, ch, 0, 0, cw, ch);
  return out;
}

// Extract rank top-left corner, scale 5×, binarize with Otsu
function extractRankArea(card: HTMLCanvasElement): HTMLCanvasElement {
  const W = Math.round(card.width  * 0.40);
  const H = Math.round(card.height * 0.44);
  const SCALE = 5;
  const out = document.createElement('canvas');
  out.width = W * SCALE; out.height = H * SCALE;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // white background first (in case card edges bleed transparent)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(card, 0, 0, W, H, 0, 0, W * SCALE, H * SCALE);
  const id = ctx.getImageData(0, 0, out.width, out.height);
  const T = otsuThreshold(id.data);
  for (let i = 0; i < id.data.length; i += 4) {
    const v = Math.round((id.data[i] + id.data[i+1] + id.data[i+2]) / 3) < T ? 0 : 255;
    id.data[i] = id.data[i+1] = id.data[i+2] = v;
  }
  ctx.putImageData(id, 0, 0);
  return out;
}

function detectSuit(card: HTMLCanvasElement): 'h'|'d'|'c'|'s' {
  const ctx = card.getContext('2d')!;
  // Sample the lower-left quadrant where suit symbol usually lives
  const sx = Math.round(card.width  * 0.05);
  const sy = Math.round(card.height * 0.44);
  const sw = Math.round(card.width  * 0.45);
  const sh = Math.round(card.height * 0.44);
  const d = ctx.getImageData(sx, sy, sw, sh).data;
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  for (let i = 0; i < d.length; i += 4) {
    // skip near-white background AND near-black anti-aliased edge pixels —
    // both pollute a mean-color estimate; only fully-saturated glyph pixels
    // reliably carry the suit's true color.
    const lum = (d[i] + d[i+1] + d[i+2]) / 3;
    if (lum > 200 || lum < 20) continue;
    rs.push(d[i]); gs.push(d[i+1]); bs.push(d[i+2]);
  }
  if (!rs.length) return 'h';
  const median = (arr: number[]) => { const s = [...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; };
  const r = median(rs), g = median(gs), b = median(bs);
  if (r > 140 && g < 100 && b < 120) return 'h';   // red → hearts
  if (r > 140 && g < 120 && b > 120) return 'd';   // magenta-ish → diamonds
  if (r < 120 && g > 100 && b < 120) return 'c';   // green → clubs
  return 's';                                        // dark/blue → spades
}

function parseRank(raw: string): string | null {
  const c = raw.replace(/[^AaKkQqJjTt0-9]/g, '').trim();
  if (!c) return null;
  if (c === '10' || c === '1O' || c === 'IO' || c === '1o') return 'T';
  return RANK_MAP[c[0]] ?? null;
}

// Extract an arbitrary text-sized region (pot/bet-to-call amounts are wider and
// shorter than a card corner), binarize with Otsu and upscale for OCR.
function extractTextRegion(src: HTMLCanvasElement, cx: number, cy: number, wPct: number, hPct: number): HTMLCanvasElement {
  const w = Math.max(4, Math.round(src.width  * wPct / 100));
  const h = Math.max(4, Math.round(src.height * hPct / 100));
  const x = Math.round(cx * src.width  - w / 2);
  const y = Math.round(cy * src.height - h / 2);
  const SCALE = 3;
  const out = document.createElement('canvas');
  out.width = w * SCALE; out.height = h * SCALE;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, x, y, w, h, 0, 0, out.width, out.height);
  const id = ctx.getImageData(0, 0, out.width, out.height);
  const T = otsuThreshold(id.data);
  for (let i = 0; i < id.data.length; i += 4) {
    const v = Math.round((id.data[i] + id.data[i+1] + id.data[i+2]) / 3) < T ? 0 : 255;
    id.data[i] = id.data[i+1] = id.data[i+2] = v;
  }
  ctx.putImageData(id, 0, 0);
  return out;
}

// Parse an OCR'd money string ("1,234", "1.2K", "850") into a number.
// The search band can catch more than one number (stray digits, neighboring
// UI elements), so we take the LARGEST match rather than the first — the
// pot/call figure is virtually always the most prominent number in its band,
// while OCR noise tends to produce small stray digits.
// Returns null when nothing digit-like was recognized — callers must treat
// that as "couldn't read this tick" rather than "value is zero".
function parseMoneyText(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, '').replace(/,(?=\d{3}\b)/g, ''); // "1,234" -> "1234"
  const matches = [...cleaned.matchAll(/(\d+(?:\.\d+)?)\s*([KkMm])?/g)];
  if (!matches.length) return null;
  let best: number | null = null;
  for (const m of matches) {
    let val = parseFloat(m[1]);
    if (Number.isNaN(val)) continue;
    if (m[2] === 'K' || m[2] === 'k') val *= 1_000;
    if (m[2] === 'M' || m[2] === 'm') val *= 1_000_000;
    if (best === null || val > best) best = val;
  }
  return best;
}

// Generic oval-table seat template: (t, dx) where t = 0..1 progress from the
// top of the table (near the board) down to hero's level, and dx = horizontal
// offset from center as a fraction of the table's half-width. This mirrors
// the near-universal "hero at bottom-center, opponents arced around an oval
// table" layout shared by virtually every online/Telegram poker client.
const SEAT_TEMPLATE: Array<{ t: number; dx: number }> = [
  { t: 0.85, dx: -0.42 },
  { t: 0.55, dx: -0.58 },
  { t: 0.22, dx: -0.48 },
  { t: 0.02, dx: -0.18 },
  { t: 0.02, dx:  0.18 },
  { t: 0.22, dx:  0.48 },
  { t: 0.55, dx:  0.58 },
  { t: 0.85, dx:  0.42 },
];

// Derive opponent seat slots automatically from the card calibration geometry
// — no clicking. Seat positions can't be read off the board/hole cards the
// way pot/bet can, so this maps a generic oval-table template onto the
// vertical/horizontal span between hero's cards and the board. It will
// sometimes include slots that aren't real seats on smaller tables (they'll
// just always read as empty felt, which is harmless), and won't perfectly
// match every table skin — the manual "уточнить вручную" flow remains as an
// override for tables where this default doesn't line up.
function computeAutoSeatSlots(regions: CardRegion[]): SeatCalibration {
  const holePts  = regions.filter(r => r.label.startsWith('Hole'));
  const boardPts = regions.filter(r => r.label.startsWith('Board'));
  const avg = (pts: CardRegion[]) => pts.length
    ? { cx: pts.reduce((s, p) => s + p.cx, 0) / pts.length, cy: pts.reduce((s, p) => s + p.cy, 0) / pts.length }
    : null;
  const hole  = avg(holePts)  ?? { cx: 0.5, cy: 0.85 };
  const board = avg(boardPts) ?? { cx: hole.cx, cy: Math.max(0.1, hole.cy - 0.25) };
  const topY = Math.max(0.03, board.cy - (hole.cy - board.cy) * 0.35); // a bit above the board
  const seats: CardRegion[] = SEAT_TEMPLATE.map((s, i) => ({
    label: `Seat ${i + 1}`,
    cx: Math.min(0.97, Math.max(0.03, hole.cx + s.dx * 0.46)),
    cy: topY + s.t * (hole.cy - topY),
  }));
  return { seats, sizePct: 6, version: 1 };
}

// Derive pot/bet-to-call search bands automatically from the card calibration
// the user already has to do — no extra clicks. Poker tables overwhelmingly
// follow the same layout: community cards centered mid-table, hero's hole
// cards at the bottom, pot total shown in the gap between them, and the
// bet-to-call amount shown near the action buttons just below hero's cards.
// These are heuristic defaults, not a guarantee for every table skin — the
// manual "уточнить вручную" correction exists for when a specific client
// doesn't match this layout.
function computeAutoMoneyBands(regions: CardRegion[]): MoneyCalibration {
  const holePts  = regions.filter(r => r.label.startsWith('Hole'));
  const boardPts = regions.filter(r => r.label.startsWith('Board'));
  const avg = (pts: CardRegion[]) => pts.length
    ? { cx: pts.reduce((s, p) => s + p.cx, 0) / pts.length, cy: pts.reduce((s, p) => s + p.cy, 0) / pts.length }
    : null;
  const hole  = avg(holePts)  ?? { cx: 0.5, cy: 0.85 };
  // If the board wasn't calibrated (e.g. preflop-only setup), assume it sits
  // a quarter of the screen above the hole cards — a reasonable default.
  const board = avg(boardPts) ?? { cx: hole.cx, cy: Math.max(0.1, hole.cy - 0.25) };

  const potCy = board.cy + (hole.cy - board.cy) * 0.35; // between board and hole, closer to board
  const betCy = Math.min(0.96, hole.cy + 0.13);          // just below hole cards, near action buttons

  return {
    pot: { label: 'Pot',  cx: (board.cx + hole.cx) / 2, cy: potCy },
    bet: { label: 'Bet',  cx: hole.cx,                   cy: betCy },
    wPct: 34, hPct: 7,
    version: 1,
  };
}

// Pixel fingerprint for a card region — used to skip OCR if card hasn't changed
function regionFingerprint(src: HTMLCanvasElement, cx: number, cy: number, cw: number, ch: number): string {
  const ctx = src.getContext('2d')!;
  const x = Math.round(cx * src.width  - cw / 2);
  const y = Math.round(cy * src.height - ch / 2);
  // 4×4 sample grid
  const bits: number[] = [];
  for (let r = 0; r < 4; r++)
    for (let c2 = 0; c2 < 4; c2++) {
      const px = ctx.getImageData(
        x + Math.round(cw * (c2 + 0.5) / 4),
        y + Math.round(ch * (r  + 0.5) / 4),
        1, 1,
      ).data;
      bits.push(Math.round((px[0] + px[1] + px[2]) / 3 / 16)); // 16 levels
    }
  return bits.join(',');
}

// Heuristic: is this region likely blank felt/background rather than a real card?
// Real card faces (light background OR strong rank/suit contrast) fail this test;
// only dark + very uniform regions (typical of an empty table slot) are flagged empty.
// Deliberately conservative — when unsure, we still attempt OCR rather than hide a real card.
function looksEmpty(cardC: HTMLCanvasElement): boolean {
  const ctx = cardC.getContext('2d')!;
  const { data } = ctx.getImageData(0, 0, cardC.width, cardC.height);
  let sum = 0, sumSq = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
    sum += lum; sumSq += lum * lum;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return mean < 120 && variance < 200;
}

function frameDiff(prev: Uint8ClampedArray, curr: Uint8ClampedArray, thresh = 40): number {
  const step = 8 * 4, len = Math.min(prev.length, curr.length);
  let diff = 0, total = 0;
  for (let i = 0; i < len; i += step) {
    if (Math.abs(prev[i]-curr[i]) + Math.abs(prev[i+1]-curr[i+1]) + Math.abs(prev[i+2]-curr[i+2]) > thresh) diff++;
    total++;
  }
  return total > 0 ? diff / total : 0;
}

async function pushAnalysis(payload: object) {
  try {
    await fetch('/api/analysis', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  } catch {}
}

// ─── Display helpers ──────────────────────────────────────────────────────────
const suitSym  = (s: string) => ({ h:'♥',d:'♦',c:'♣',s:'♠' }[s] ?? s);
const suitCls  = (s: string) => s === 'h' || s === 'd' ? 'text-red-400' : 'text-zinc-200';
const rankLabel = (r: number) => ({ 14:'A',13:'K',12:'Q',11:'J',10:'T' }[r] ?? String(r));

// Minimum Tesseract confidence (0-100) to trust a rank reading. Tesseract.js's
// PSM_SINGLE_CHAR confidence score runs much lower in practice than a normal
// word/line read (no dictionary/context to boost it) — a threshold tuned by
// guesswork (45) rejected essentially every real reading and silently killed
// all analysis. Kept low and only as a floor against a total garbage read
// (confidence ~0), not as the primary accuracy gate — parseRank() succeeding
// on the binarized glyph is the real signal.
const RANK_CONFIDENCE_MIN = 1;

// Process a list of regions with one worker (sequential within worker, safe).
// Safeguards against misreads, in latency order (cheapest/fastest first):
//  1. A blank/felt-looking region is treated as "no card" without OCR (free).
//  2. A low-confidence OCR result is discarded and the last known value for that
//     slot is kept — no card flips on a single bad read, but a GOOD read commits
//     immediately (no multi-tick wait), so recognition speed matches scan speed.
// A manual override (user tapped to correct a misread) short-circuits both,
// staying in effect until the underlying pixels actually change.
async function processRegions(
  worker: Worker,
  src: HTMLCanvasElement,
  regs: CardRegion[],
  cardW: number, cardH: number,
  fps: Map<string, { fp: string; card: Card | null }>,
  overrides: Map<string, { fp: string; card: Card | null }>,
): Promise<(Card | null)[]> {
  const results: (Card | null)[] = [];
  for (const region of regs) {
    const key = region.label;
    const fp  = regionFingerprint(src, region.cx, region.cy, cardW, cardH);

    const ov = overrides.get(key);
    if (ov?.fp === fp) { fps.set(key, ov); results.push(ov.card); continue; }
    if (ov) overrides.delete(key); // pixels moved on — manual fix no longer applies

    const cached = fps.get(key);
    if (cached?.fp === fp) { results.push(cached.card); continue; } // no change

    const cardC = extractCardRegion(src, region.cx, region.cy, cardW, cardH);
    if (looksEmpty(cardC)) {
      fps.set(key, { fp, card: null });
      results.push(null);
      continue;
    }

    const rankC = extractRankArea(cardC);
    const { data } = await worker.recognize(rankC);
    const rank = parseRank(data.text.trim());
    if (!rank || data.confidence < RANK_CONFIDENCE_MIN) {
      // Unreadable or low-confidence — don't guess; keep whatever was last shown for this slot.
      results.push(cached?.card ?? null);
      continue;
    }
    const suit = detectSuit(cardC);
    let card: Card | null = null;
    try { card = parseCard(`${rank}${suit}`); } catch {}
    if (card) {
      fps.set(key, { fp, card }); // commit immediately — confidence gate is the safeguard now
      results.push(card);
    } else {
      results.push(cached?.card ?? null);
    }
  }
  return results;
}

// Minimum confidence for a money (pot/bet) OCR reading — same rationale as
// RANK_CONFIDENCE_MIN above: kept as a floor against total garbage, not the
// primary gate (a digit-whitelisted line read is more reliable than a single
// char, so this can stay a bit higher, but still nowhere near 40 — that
// value silently blocked pot/bet updates too).
const MONEY_CONFIDENCE_MIN = 1;

// Read one money region (pot or bet-to-call). Same safeguard shape as card OCR:
// skip re-reading unchanged pixels via fingerprint, and discard a low-confidence
// reading instead of waiting a tick to confirm it — commits instantly when clean.
async function processMoneyRegion(
  worker: Worker,
  src: HTMLCanvasElement,
  region: CardRegion,
  wPct: number, hPct: number,
  fps: Map<string, { fp: string; value: number | null }>,
): Promise<number | null | undefined> { // undefined = no change, caller keeps current UI value
  const key = region.label;
  const cw = Math.max(4, Math.round(src.width  * wPct / 100));
  const ch = Math.max(4, Math.round(src.height * hPct / 100));
  const fp = regionFingerprint(src, region.cx, region.cy, cw, ch);

  const cached = fps.get(key);
  if (cached?.fp === fp) return undefined; // unchanged — don't touch current value

  const crop = extractTextRegion(src, region.cx, region.cy, wPct, hPct);
  const { data } = await worker.recognize(crop);
  if (data.confidence < MONEY_CONFIDENCE_MIN) return undefined; // unreadable this tick — keep current value

  const value = parseMoneyText(data.text);
  fps.set(key, { fp, value });
  return value ?? undefined;
}

// ─── Component ────────────────────────────────────────────────────────────────
export function ScreenScan() {
  const [phase, setPhase]           = useState<Phase>('idle');
  const [regions, setRegions]       = useState<CardRegion[]>([]);
  const [calStep, setCalStep]       = useState(0);
  const [advice, setAdvice]         = useState<FullAdvice | null>(null);
  const [holeCards, setHoleCards]   = useState<Card[]>([]);
  const [boardCards, setBoardCards] = useState<Card[]>([]);
  // Parallel arrays of originating region labels (e.g. 'Board 3'), so a tap-to-correct
  // on a displayed card always targets the right slot even if earlier slots are empty.
  const [holeLabels, setHoleLabels]   = useState<string[]>([]);
  const [boardLabels, setBoardLabels] = useState<string[]>([]);
  const [error, setError]           = useState<string | null>(null);
  const [scanCount, setScanCount]   = useState(0);
  const [analyzing, setAnalyzing]   = useState(false);
  const [lastScan, setLastScan]     = useState<string | null>(null);
  const [diffPct, setDiffPct]       = useState(0);
  const [hasSaved, setHasSaved]     = useState(false);
  const [players, setPlayers]       = useState(4);
  const [potSize, setPotSize]       = useState<number | null>(null);
  const [betToCall, setBetToCall]   = useState<number | null>(null);
  const [position, setPosition]     = useState<Position>('BTN');
  // Card height as % of captured frame height — tune to match your TON Poker window
  const [cardSizePct, setCardSizePct] = useState(9);

  // ── Debug view: shows the exact pixels each region is reading ─────────────
  // The single most useful diagnostic when OCR "sees nothing" — lets the user
  // (and us, from a screenshot) tell instantly whether a region is even
  // pointed at a card, vs. pointed at empty table because the calibration no
  // longer matches what's actually being captured (e.g. window was resized,
  // or the shared screen area shrank after docking two windows side by side).
  const [debugMode, setDebugMode] = useState(false);
  const debugModeRef = useRef(false);
  useEffect(() => { debugModeRef.current = debugMode; }, [debugMode]);
  const [debugThumbs, setDebugThumbs] = useState<Record<string, string>>({});

  // True when the browser's screen-share picker reported "Entire screen" rather
  // than a specific window/tab — the #1 real cause of calibration silently
  // pointing at the wrong pixels (table becomes a small, movable fraction of
  // the captured frame instead of filling it).
  const [sharedWholeScreen, setSharedWholeScreen] = useState(false);

  // ── Money OCR (pot / bet-to-call) — optional sub-calibration ──────────────
  const [subCal, setSubCal]             = useState<SubCal>(null);
  const [moneyStepIdx, setMoneyStepIdx] = useState(0); // 0 = pot, 1 = bet-to-call
  const [moneyDraft, setMoneyDraft]     = useState<{ pot: CardRegion | null; bet: CardRegion | null }>({ pot: null, bet: null });
  const [moneyCal, setMoneyCal]         = useState<MoneyCalibration | null>(null);
  const [autoPot, setAutoPot]           = useState(false);
  const [autoBet, setAutoBet]           = useState(false);

  // ── Seat/fold detection — optional sub-calibration ────────────────────────
  const [seatDraft, setSeatDraft]   = useState<CardRegion[]>([]);
  const [seatCal, setSeatCal]       = useState<SeatCalibration | null>(null);
  const [autoPlayers, setAutoPlayers] = useState(false);
  const [activeSeats, setActiveSeats] = useState<number | null>(null);

  const videoRef     = useRef<HTMLVideoElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const diffCanvas   = useRef<HTMLCanvasElement | null>(null);
  // Two workers: [0] for hole cards, [1] for board cards
  const workersRef   = useRef<Worker[]>([]);
  // Dedicated worker for pot/bet money OCR — different whitelist/PSM than cards
  const moneyWorkerRef = useRef<Worker | null>(null);
  // Fingerprint cache for money regions, keyed 'pot'|'bet'
  const moneyFpCache      = useRef<Map<string, { fp: string; value: number | null }>>(new Map());
  const streamRef    = useRef<MediaStream | null>(null);
  const scanLoopRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevPixels   = useRef<Uint8ClampedArray | null>(null);
  const analyzingRef = useRef(false);
  // Per-region fingerprint cache (confirmed) and manual overrides (user
  // tap-to-correct, valid until the region's pixels change)
  const fingerprintCache = useRef<Map<string, { fp: string; card: Card | null }>>(new Map());
  const overridesCache    = useRef<Map<string, { fp: string; card: Card | null }>>(new Map());
  const lastGoodRef       = useRef<{ hole: Card[]; board: Card[]; holeLabels: string[]; boardLabels: string[] }>({ hole: [], board: [], holeLabels: [], boardLabels: [] });
  const [dupWarning, setDupWarning] = useState<string | null>(null);

  useEffect(() => {
    diffCanvas.current = document.createElement('canvas');
    const saved = loadCalibration();
    setHasSaved(saved !== null);
    if (saved?.cardSizePct) setCardSizePct(saved.cardSizePct);
    const money = loadMoneyCalibration();
    if (money) { setMoneyCal(money); setAutoPot(!!money.pot); setAutoBet(!!money.bet); }
    const seats = loadSeatCalibration();
    if (seats) { setSeatCal(seats); setAutoPlayers(true); }
  }, []);

  // ── Stop ─────────────────────────────────────────────────────────────────
  const stopAll = useCallback(() => {
    if (scanLoopRef.current) { clearInterval(scanLoopRef.current); scanLoopRef.current = null; }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    prevPixels.current = null;
    fingerprintCache.current.clear();
    overridesCache.current.clear();
    moneyFpCache.current.clear();
    lastGoodRef.current = { hole: [], board: [], holeLabels: [], boardLabels: [] };
    setSharedWholeScreen(false);
    setPhase('idle');
    setRegions([]);
    setCalStep(0);
    setSubCal(null);
    setActiveSeats(null);
  }, []);

  // ── Start capture ─────────────────────────────────────────────────────────
  const startCapture = useCallback(async (skipCalibration = false) => {
    setError(null);
    setPhase('requesting');
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        // `displaySurface: 'window'` is only a hint (Chrome uses it to default
        // the picker to the "Window" tab) — it does not block the user from
        // still choosing "Entire screen". Sharing the whole screen is the
        // #1 real-world cause of "sees nothing" reports: the table then only
        // fills a small, off-center fraction of the frame, so calibrated %
        // regions land on background/other windows instead of cards, and any
        // window move/resize silently invalidates the calibration.
        video: { frameRate: { ideal: 5, max: 15 }, displaySurface: 'window' } as MediaTrackConstraints,
        audio: false,
      });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings() as MediaTrackSettings & { displaySurface?: string };
      setSharedWholeScreen(settings.displaySurface === 'monitor');
      const video = videoRef.current!;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      track.addEventListener('ended', stopAll);
      video.play().catch(() => {});

      if (skipCalibration) {
        const saved = loadCalibration();
        if (saved) {
          setRegions(saved.regions);
          if (saved.cardSizePct) setCardSizePct(saved.cardSizePct);
          // Backfill auto pot/bet bands and seat slots for calibrations saved before these existed.
          if (!loadMoneyCalibration()) autoSetupMoney(saved.regions);
          if (!loadSeatCalibration()) autoSetupSeats(saved.regions);
          await loadOcr(saved.regions, true);
          return;
        }
      }
      setPhase('calibrating');
      setCalStep(0);
      setRegions([]);
    } catch (err: any) {
      setError(
        err?.name === 'NotAllowedError'
          ? 'Доступ к экрану отклонён — разреши захват и попробуй снова'
          : err?.message ?? 'Не удалось захватить экран'
      );
      setPhase('idle');
    }
  }, [stopAll]);

  // ── Calibration ───────────────────────────────────────────────────────────
  const handleVideoTap = useCallback(async (e: React.MouseEvent<HTMLVideoElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = (e.clientX - rect.left) / rect.width;
    const cy = (e.clientY - rect.top)  / rect.height;

    if (subCal === 'money') {
      const label = moneyStepIdx === 0 ? 'Pot' : 'Bet';
      const point = { label, cx, cy };
      const nextDraft = moneyStepIdx === 0 ? { ...moneyDraft, pot: point } : { ...moneyDraft, bet: point };
      setMoneyDraft(nextDraft);
      if (moneyStepIdx === 0) { setMoneyStepIdx(1); return; }
      finishMoneyCalibration(nextDraft);
      return;
    }
    if (subCal === 'seats') {
      setSeatDraft(d => [...d, { label: `Seat ${d.length + 1}`, cx, cy }]);
      return;
    }

    if (phase !== 'calibrating') return;
    const newRegions = [...regions, { label: CALIBRATION_STEPS[calStep].label, cx, cy }];
    setRegions(newRegions);
    const next = calStep + 1;
    if (next >= CALIBRATION_STEPS.length) {
      saveCalibration(newRegions, cardSizePct);
      setHasSaved(true);
      autoSetupMoney(newRegions);
      autoSetupSeats(newRegions);
      await loadOcr(newRegions, true);
    } else {
      setCalStep(next);
    }
  }, [phase, calStep, regions, cardSizePct, subCal, moneyStepIdx, moneyDraft]);

  // Pot/bet OCR turns on by itself the moment card calibration is done — no
  // extra clicks. See computeAutoMoneyBands for the layout assumptions.
  const autoSetupMoney = useCallback((finalRegions: CardRegion[]) => {
    const auto = computeAutoMoneyBands(finalRegions);
    saveMoneyCalibration(auto);
    setMoneyCal(auto);
    setAutoPot(true); setAutoBet(true);
    moneyFpCache.current.clear();
  }, []);

  // Opponent seat/fold detection turns on by itself the same way — no clicks.
  // See computeAutoSeatSlots for the generic oval-table layout assumptions.
  const autoSetupSeats = useCallback((finalRegions: CardRegion[]) => {
    const auto = computeAutoSeatSlots(finalRegions);
    saveSeatCalibration(auto);
    setSeatCal(auto);
    setAutoPlayers(true);
  }, []);

  // ── Money (pot/bet) sub-calibration ───────────────────────────────────────
  const startMoneyCalibration = useCallback(() => {
    setMoneyDraft({ pot: null, bet: null });
    setMoneyStepIdx(0);
    setSubCal('money');
  }, []);
  const skipMoneyStep = useCallback(() => {
    if (moneyStepIdx === 0) { setMoneyStepIdx(1); return; }
    finishMoneyCalibration(moneyDraft);
  }, [moneyStepIdx, moneyDraft]);
  const finishMoneyCalibration = useCallback(async (draft: { pot: CardRegion | null; bet: CardRegion | null }) => {
    setSubCal(null);
    if (!draft.pot && !draft.bet) return; // both skipped — nothing to save
    const cal: MoneyCalibration = { pot: draft.pot, bet: draft.bet, wPct: 9, hPct: 3.2, version: 1 };
    saveMoneyCalibration(cal);
    setMoneyCal(cal);
    moneyFpCache.current.clear();
    setAutoPot(!!draft.pot); setAutoBet(!!draft.bet);
    if (!moneyWorkerRef.current) {
      const w = await createWorker('eng', 1, { logger: () => {} });
      await w.setParameters({ tessedit_char_whitelist: '0123456789.,KkMm', tessedit_pageseg_mode: '7' as any });
      moneyWorkerRef.current = w;
    }
  }, []);
  const clearMoneyCalibration = useCallback(() => {
    try { localStorage.removeItem(MONEY_STORAGE_KEY); } catch {}
    setMoneyCal(null); setAutoPot(false); setAutoBet(false);
  }, []);

  // ── Seat (fold/player-count) sub-calibration ──────────────────────────────
  const startSeatCalibration = useCallback(() => {
    setSeatDraft([]);
    setSubCal('seats');
  }, []);
  const finishSeatCalibration = useCallback(() => {
    setSubCal(null);
    if (seatDraft.length === 0) return;
    const cal: SeatCalibration = { seats: seatDraft, sizePct: 6, version: 1 };
    saveSeatCalibration(cal);
    setSeatCal(cal);
    setAutoPlayers(true);
  }, [seatDraft]);
  const cancelSeatCalibration = useCallback(() => { setSubCal(null); setSeatDraft([]); }, []);
  const clearSeatCalibration = useCallback(() => {
    try { localStorage.removeItem(SEAT_STORAGE_KEY); } catch {}
    setSeatCal(null); setAutoPlayers(false); setActiveSeats(null);
  }, []);

  const skipCard = useCallback(async () => {
    if (calStep < 2) return;
    const next = calStep + 1;
    if (next >= CALIBRATION_STEPS.length) {
      saveCalibration(regions, cardSizePct);
      setHasSaved(true);
      autoSetupMoney(regions);
      autoSetupSeats(regions);
      await loadOcr(regions, true);
    } else {
      setCalStep(next);
    }
  }, [calStep, regions, cardSizePct]);

  // ── Load OCR workers ──────────────────────────────────────────────────────
  const loadOcr = useCallback(async (finalRegions: CardRegion[], autoStart: boolean) => {
    setPhase('loading-ocr');
    try {
      if (workersRef.current.length === 0) {
        const params = {
          tessedit_char_whitelist: 'AaKkQqJjTt23456789',
          tessedit_pageseg_mode: '10' as any, // PSM_SINGLE_CHAR
        };
        const [w1, w2] = await Promise.all([
          createWorker('eng', 1, { logger: () => {} }),
          createWorker('eng', 1, { logger: () => {} }),
        ]);
        await Promise.all([w1.setParameters(params), w2.setParameters(params)]);
        workersRef.current = [w1, w2];
      }
      // Money worker: pot/bet auto-detection is on by default now, so it's
      // always needed (not conditional on a prior manual calibration).
      if (!moneyWorkerRef.current) {
        const w = await createWorker('eng', 1, { logger: () => {} });
        await w.setParameters({ tessedit_char_whitelist: '0123456789.,KkMm', tessedit_pageseg_mode: '7' as any });
        moneyWorkerRef.current = w;
      }
      setRegions(finalRegions);
      if (autoStart) startScanLoop(finalRegions);
      else setPhase('scanning');
    } catch {
      setError('Не удалось загрузить OCR движок');
      setPhase('calibrating');
    }
  }, []);

  // ── Manual correction ─────────────────────────────────────────────────────
  // Tap a detected card to fix a misread rank/suit. The override sticks until
  // the region's pixels actually change (new card dealt), tracked via its
  // current fingerprint so auto-detection resumes cleanly afterwards.
  // Rebuilds hole/board arrays from the confirmed cache by slot label (rather
  // than splicing the already-compacted display arrays) so a correction to
  // one slot can't shift or mislabel an unrelated card.
  const rebuildFromCache = useCallback(() => {
    const hole: Card[] = [], holeL: string[] = [];
    const board: Card[] = [], boardL: string[] = [];
    for (const step of CALIBRATION_STEPS) {
      const entry = fingerprintCache.current.get(step.label);
      if (!entry?.card) continue;
      if (step.label.startsWith('Hole')) { hole.push(entry.card); holeL.push(step.label); }
      else { board.push(entry.card); boardL.push(step.label); }
    }
    setHoleCards(hole); setHoleLabels(holeL);
    setBoardCards(board); setBoardLabels(boardL);
    lastGoodRef.current = { hole, board, holeLabels: holeL, boardLabels: boardL };
  }, []);

  const handleManualOverride = useCallback((key: string, card: Card | null) => {
    const fp = fingerprintCache.current.get(key)?.fp;
    if (!fp) return;
    overridesCache.current.set(key, { fp, card });
    fingerprintCache.current.set(key, { fp, card });
    rebuildFromCache();
  }, [rebuildFromCache]);

  // ── Capture frame ─────────────────────────────────────────────────────────
  const captureToCanvas = useCallback((): HTMLCanvasElement | null => {
    const video = videoRef.current, canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return null;
    canvas.width  = video.videoWidth  || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    return canvas;
  }, []);

  // ── OCR one frame (parallel workers) ─────────────────────────────────────
  const runOCR = useCallback(async (canvas: HTMLCanvasElement, regs: CardRegion[], sizePct: number) => {
    const [w1, w2] = workersRef.current;
    if (!w1 || !w2 || regs.length < 2 || analyzingRef.current) return;
    analyzingRef.current = true;
    setAnalyzing(true);
    try {
      const cardH = Math.round(canvas.height * sizePct / 100);
      const cardW = Math.round(cardH * 0.72);

      const holeRegs  = regs.slice(0, 2);
      const boardRegs = regs.slice(2);

      // Run both workers in parallel
      const [holeResults, boardResults] = await Promise.all([
        processRegions(w1, canvas, holeRegs,  cardW, cardH, fingerprintCache.current, overridesCache.current),
        processRegions(w2, canvas, boardRegs, cardW, cardH, fingerprintCache.current, overridesCache.current),
      ]);

      // ── Debug thumbnails: exactly what pixels each region is reading right
      // now — the fastest way to tell "OCR is broken" apart from "calibration
      // no longer matches what's being captured". Only computed when the
      // debug panel is open, so it costs nothing during normal play.
      if (debugModeRef.current) {
        const toThumb = (el: HTMLCanvasElement, maxW = 64): string => {
          const scale = maxW / el.width;
          const t = document.createElement('canvas');
          t.width = maxW; t.height = Math.max(1, Math.round(el.height * scale));
          t.getContext('2d')!.drawImage(el, 0, 0, t.width, t.height);
          return t.toDataURL('image/png');
        };
        const thumbs: Record<string, string> = {};
        for (const r of regs) thumbs[r.label] = toThumb(extractCardRegion(canvas, r.cx, r.cy, cardW, cardH));
        if (moneyCal?.pot) thumbs['Пот (регион)'] = toThumb(extractTextRegion(canvas, moneyCal.pot.cx, moneyCal.pot.cy, moneyCal.wPct, moneyCal.hPct), 100);
        if (moneyCal?.bet) thumbs['Колл (регион)'] = toThumb(extractTextRegion(canvas, moneyCal.bet.cx, moneyCal.bet.cy, moneyCal.wPct, moneyCal.hPct), 100);
        setDebugThumbs(thumbs);
      }

      const compact = (results: (Card | null)[], srcRegs: CardRegion[]) => {
        const cards: Card[] = [], labels: string[] = [];
        results.forEach((c, i) => { if (c) { cards.push(c); labels.push(srcRegs[i].label); } });
        return { cards, labels };
      };
      let { cards: hole, labels: holeLbls }   = compact(holeResults, holeRegs);
      let { cards: board, labels: boardLbls } = compact(boardResults, boardRegs);

      // Sanity check: the same physical card can never appear twice (as two hole
      // cards, or shared between hole and board) — that's only possible from a
      // misread. If we see a duplicate, distrust this frame's reading entirely
      // and fall back to the last known-good state rather than feeding a
      // physically impossible hand into the equity math.
      const seen = new Set<string>();
      let hasDup = false;
      for (const c of [...hole, ...board]) {
        const k = `${c.rank}${c.suit}`;
        if (seen.has(k)) { hasDup = true; break; }
        seen.add(k);
      }
      if (hasDup) {
        setDupWarning(`Обнаружен дубль карты — кадр пропущен (${new Date().toLocaleTimeString('ru')})`);
        hole = lastGoodRef.current.hole; holeLbls = lastGoodRef.current.holeLabels;
        board = lastGoodRef.current.board; boardLbls = lastGoodRef.current.boardLabels;
      } else {
        setDupWarning(null);
        lastGoodRef.current = { hole, board, holeLabels: holeLbls, boardLabels: boardLbls };
      }

      setHoleCards(hole); setHoleLabels(holeLbls);
      setBoardCards(board); setBoardLabels(boardLbls);

      if (hole.length === 2 && !hasDup) {
        // Fewer unknown cards later in the hand → fewer iterations needed for
        // a stable estimate, so we spend less time simulating when speed matters most.
        const iterations = board.length === 0 ? 400 : board.length === 3 ? 1500 : board.length === 4 ? 900 : 300;
        const sim = runMonteCarloSim(hole, board, players, iterations);
        const fa  = getFullAdvice(hole, board, potSize ?? 0, betToCall ?? 0, players, position, sim);
        setAdvice(fa);
        // Fire-and-forget: don't block the next scan tick on network latency —
        // Telegram/phone push happens in the background while OCR keeps going.
        pushAnalysis({
          holeCards:  hole.map(c => `${c.rank}${c.suit}`),
          boardCards: board.map(c => `${c.rank}${c.suit}`),
          action: fa.action, displayText: fa.displayText, color: fa.color,
          details: fa.details, equity: fa.equity, potOdds: fa.potOdds, mdf: fa.mdf,
          handCategory: fa.handCategory, handName: fa.handName, draws: fa.draws,
          bluffRead: fa.bluffRead,
          sizing: fa.sizing, potSize, betToCall, players, position,
        });
      } else if (!hasDup) {
        // Fewer than 2 hole cards recognized right now (new hand dealing, or a
        // slot briefly unreadable) — clear any advice instead of leaving a stale
        // decision on screen. With a 5s decision window, showing an old hand's
        // "RAISE" while the new hand's cards aren't confirmed yet is actively
        // dangerous, not just cosmetic.
        setAdvice(null);
      }
      // ── Optional: OCR pot / bet-to-call from calibrated regions ──────────
      const mWorker = moneyWorkerRef.current;
      if (mWorker && moneyCal) {
        if (moneyCal.pot && autoPot) {
          const v = await processMoneyRegion(mWorker, canvas, moneyCal.pot, moneyCal.wPct, moneyCal.hPct, moneyFpCache.current);
          if (v !== undefined && v !== null) setPotSize(v);
        }
        if (moneyCal.bet && autoBet) {
          const v = await processMoneyRegion(mWorker, canvas, moneyCal.bet, moneyCal.wPct, moneyCal.hPct, moneyFpCache.current);
          if (v !== undefined && v !== null) setBetToCall(v);
        }
      }

      // ── Optional: opponent count via seat pixel sampling (active = card-back
      // pixels present, folded/empty = uniform dark felt) ──────────────────
      if (seatCal && autoPlayers) {
        const seatCw = Math.round(canvas.width  * seatCal.sizePct / 100 * 0.72);
        const seatCh = Math.round(canvas.height * seatCal.sizePct / 100);
        let active = 0;
        for (const seat of seatCal.seats) {
          const crop = extractCardRegion(canvas, seat.cx, seat.cy, seatCw, seatCh);
          if (!looksEmpty(crop)) active++;
        }
        setActiveSeats(active);
        setPlayers(Math.min(9, Math.max(2, active + 1))); // +1 = hero
      }

      setScanCount(n => n + 1);
      setLastScan(new Date().toLocaleTimeString('ru'));
    } catch {}
    finally { analyzingRef.current = false; setAnalyzing(false); }
  }, [players, potSize, betToCall, position, moneyCal, autoPot, autoBet, seatCal, autoPlayers]);

  // ── Scan loop ─────────────────────────────────────────────────────────────
  const startScanLoop = useCallback((regs: CardRegion[]) => {
    setPhase('scanning');
    let ticks = 0;
    // Use a ref so the loop always sees the latest cardSizePct
    const getSizePct = () => cardSizePctRef.current;
    const loop = setInterval(async () => {
      const canvas = captureToCanvas();
      if (!canvas || !diffCanvas.current) return;
      ticks++;

      diffCanvas.current.width = 160; diffCanvas.current.height = 90;
      const dc = diffCanvas.current.getContext('2d')!;
      dc.drawImage(canvas, 0, 0, 160, 90);
      const curr = dc.getImageData(0, 0, 160, 90).data;

      let changed = true;
      if (prevPixels.current) {
        const d = frameDiff(prevPixels.current, curr);
        setDiffPct(Math.round(d * 100));
        changed = d > 0.012;
      }
      prevPixels.current = new Uint8ClampedArray(curr);

      if ((changed || ticks >= 2) && !analyzingRef.current) {
        ticks = 0;
        await runOCR(canvas, regs, getSizePct());
      }
    }, 180);
    scanLoopRef.current = loop;
  }, [captureToCanvas, runOCR]);

  // Ref for cardSizePct so scan loop closure always reads latest value
  const cardSizePctRef = useRef(cardSizePct);
  useEffect(() => { cardSizePctRef.current = cardSizePct; }, [cardSizePct]);

  useEffect(() => () => {
    stopAll();
    workersRef.current.forEach(w => w.terminate());
    moneyWorkerRef.current?.terminate();
  }, []);

  const captureActive = phase !== 'idle' && phase !== 'requesting';

  return (
    <div className="flex flex-col min-h-screen bg-[#0d1117] text-zinc-100 font-mono">

      {/* ── IDLE ── */}
      {phase === 'idle' && (
        <div className="flex flex-col items-center justify-center flex-1 gap-5 p-6 text-center max-w-lg mx-auto">
          <div className="text-5xl">🖥️</div>
          <div>
            <h2 className="text-2xl font-bold mb-2">Авто-скан экрана</h2>
            <p className="text-zinc-500 text-sm leading-relaxed">
              Захватывает экран → OCR карт → GTO анализ → отправляет на телефон в реальном времени.
            </p>
          </div>
          <div className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-4 text-left space-y-1.5">
            {[
              'Разверни окно/вкладку с игрой на весь экран',
              'Нажми «Начать захват» — выбери именно ЭТО окно/вкладку, а не «Весь экран»',
              'Кликни по центру каждой карты один раз (калибровка сохранится)',
              'Дальше всё автоматически: OCR → GTO → результат на телефоне',
            ].map((s, i) => (
              <div key={i} className="flex gap-2 text-sm text-zinc-400">
                <span className="text-emerald-400 font-bold shrink-0">{i + 1}.</span>
                <span>{s}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2 w-full max-w-xs">
            {hasSaved && (
              <button onClick={() => startCapture(true)} className="w-full px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold text-sm transition-colors shadow-[0_0_20px_rgba(5,150,105,0.3)]">
                ▶ Запустить (сохранённая калибровка)
              </button>
            )}
            <button
              onClick={() => startCapture(false)}
              className={cn('w-full px-6 py-3 rounded-xl font-bold text-sm transition-colors',
                hasSaved ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700'
                          : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-[0_0_20px_rgba(5,150,105,0.3)]'
              )}
            >
              {hasSaved ? '⟳ Перекалибровать' : 'Начать захват экрана'}
            </button>
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <TelegramSetup />
        </div>
      )}

      {/* ── REQUESTING ── */}
      {phase === 'requesting' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <div className="w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-zinc-400 text-sm">Ожидание доступа к экрану...</p>
        </div>
      )}

      {/* ── CAPTURE VIEW — always in DOM so videoRef.current is never null ── */}
      <div className={cn('flex flex-col lg:flex-row flex-1 gap-0', !captureActive && 'hidden')}>

        {/* Video + overlays */}
        <div className="relative flex-1 bg-black overflow-hidden min-h-[40vh]">
          <video
            ref={videoRef}
            className={cn('w-full h-full object-contain', (phase === 'calibrating' || subCal) ? 'cursor-crosshair' : '')}
            playsInline muted autoPlay
            onClick={handleVideoTap}
          />
          <canvas ref={canvasRef} className="hidden" />

          {/* Whole-screen warning — the #1 real cause of "sees nothing": table
              is then a small, movable fraction of the frame instead of filling
              it, so calibrated regions land on background/other windows. */}
          {sharedWholeScreen && (
            <div className="absolute top-2 left-2 right-2 z-20 bg-amber-900/90 border border-amber-600 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
              <p className="text-amber-200 text-xs leading-snug">
                ⚠️ Ты поделился «Весь экран» — стол занимает маленькую часть кадра, и калибровка собьётся
                при любом сдвиге окна. Лучше поделиться именно окном/вкладкой с игрой, развернув её.
              </p>
              <button onClick={() => { stopAll(); startCapture(false); }}
                className="shrink-0 py-1 px-2 bg-amber-700 hover:bg-amber-600 rounded text-[10px] text-white font-bold">
                Выбрать окно игры
              </button>
            </div>
          )}

          {/* Calibration dots */}
          {phase === 'calibrating' && regions.map((r, i) => (
            <div key={i}
              className="absolute w-6 h-6 rounded-full border-2 border-white bg-emerald-500/80 -translate-x-3 -translate-y-3 pointer-events-none z-10"
              style={{ left: `${r.cx * 100}%`, top: `${r.cy * 100}%` }}
            >
              <span className="absolute text-[8px] font-bold text-white left-7 top-0.5 bg-black/70 px-1 rounded whitespace-nowrap">{r.label}</span>
            </div>
          ))}

          {/* Scan dots */}
          {phase === 'scanning' && !subCal && regions.map((r, i) => (
            <div key={i}
              className={cn('absolute w-3 h-3 rounded-full border border-white/50 -translate-x-1.5 -translate-y-1.5 pointer-events-none z-10',
                i < 2 ? 'bg-emerald-400/60' : 'bg-blue-400/60'
              )}
              style={{ left: `${r.cx * 100}%`, top: `${r.cy * 100}%` }}
            />
          ))}

          {/* Money sub-calibration dots */}
          {subCal === 'money' && [moneyDraft.pot, moneyDraft.bet].filter(Boolean).map((r, i) => (
            <div key={i}
              className="absolute w-16 h-6 rounded border-2 border-white bg-amber-500/60 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-10 flex items-center justify-center"
              style={{ left: `${r!.cx * 100}%`, top: `${r!.cy * 100}%` }}
            >
              <span className="text-[9px] font-bold text-white">{r!.label}</span>
            </div>
          ))}
          {/* Money regions during normal scanning, so the user can see what's tracked */}
          {phase === 'scanning' && !subCal && moneyCal && [moneyCal.pot, moneyCal.bet].filter(Boolean).map((r, i) => (
            <div key={i}
              className="absolute w-14 h-5 rounded border border-amber-400/60 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-10"
              style={{ left: `${r!.cx * 100}%`, top: `${r!.cy * 100}%` }}
            />
          ))}

          {/* Seat sub-calibration dots */}
          {subCal === 'seats' && seatDraft.map((r, i) => (
            <div key={i}
              className="absolute w-5 h-5 rounded-full border-2 border-white bg-purple-500/70 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-10 flex items-center justify-center"
              style={{ left: `${r.cx * 100}%`, top: `${r.cy * 100}%` }}
            >
              <span className="text-[8px] font-bold text-white">{i + 1}</span>
            </div>
          ))}
          {/* Seat regions during normal scanning — green = active, gray = folded */}
          {phase === 'scanning' && !subCal && seatCal && seatCal.seats.map((r, i) => (
            <div key={i}
              className={cn('absolute w-3 h-3 rounded-full border border-white/50 -translate-x-1.5 -translate-y-1.5 pointer-events-none z-10',
                activeSeats !== null ? 'bg-purple-400/60' : 'bg-zinc-500/40'
              )}
              style={{ left: `${r.cx * 100}%`, top: `${r.cy * 100}%` }}
            />
          ))}

          {/* Calibration UI */}
          {phase === 'calibrating' && (
            <div className="absolute bottom-0 left-0 right-0 bg-black/85 backdrop-blur-sm p-4 space-y-3 z-20">
              <p className="text-center text-sm font-bold text-emerald-400">
                {CALIBRATION_STEPS[calStep]?.hint}
              </p>
              <div className="flex gap-2 justify-center">
                {calStep >= 2 && (
                  <button onClick={skipCard} className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-sm text-zinc-300">
                    Пропустить
                  </button>
                )}
                <button onClick={stopAll} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm text-zinc-500">
                  Отмена
                </button>
              </div>
              <div className="flex justify-center gap-1.5">
                {CALIBRATION_STEPS.map((_, i) => (
                  <div key={i} className={cn('w-2 h-2 rounded-full',
                    i < calStep ? 'bg-emerald-500' : i === calStep ? 'bg-white' : 'bg-zinc-700'
                  )} />
                ))}
              </div>
            </div>
          )}

          {/* Money sub-calibration UI */}
          {subCal === 'money' && (
            <div className="absolute bottom-0 left-0 right-0 bg-black/85 backdrop-blur-sm p-4 space-y-3 z-20">
              <p className="text-center text-sm font-bold text-amber-400">
                {moneyStepIdx === 0 ? 'Кликни на текст размера ПОТА' : 'Кликни на текст суммы КОЛЛА (ставки к оплате)'}
              </p>
              <div className="flex gap-2 justify-center">
                <button onClick={skipMoneyStep} className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-sm text-zinc-300">
                  Пропустить
                </button>
                <button onClick={() => { setSubCal(null); }} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm text-zinc-500">
                  Отмена
                </button>
              </div>
            </div>
          )}

          {/* Seat sub-calibration UI */}
          {subCal === 'seats' && (
            <div className="absolute bottom-0 left-0 right-0 bg-black/85 backdrop-blur-sm p-4 space-y-3 z-20">
              <p className="text-center text-sm font-bold text-purple-400">
                Кликни по месту каждого соперника (карты/аватар). Отмечено: {seatDraft.length}
              </p>
              <div className="flex gap-2 justify-center">
                <button onClick={finishSeatCalibration} disabled={seatDraft.length === 0}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:hover:bg-emerald-600 rounded-lg text-sm text-white font-bold">
                  Готово ({seatDraft.length})
                </button>
                <button onClick={cancelSeatCalibration} className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm text-zinc-500">
                  Отмена
                </button>
              </div>
            </div>
          )}

          {/* Loading OCR */}
          {phase === 'loading-ocr' && (
            <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-3 z-20">
              <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-zinc-300">Загрузка OCR движка...</p>
              <p className="text-xs text-zinc-500">Первый запуск ~5 сек</p>
            </div>
          )}

          {/* Scan status bar */}
          {phase === 'scanning' && (
            <div className="absolute top-2 left-2 right-2 flex items-center justify-between z-20">
              <div className="flex items-center gap-2 bg-black/70 rounded-full px-3 py-1 backdrop-blur-sm">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-xs text-zinc-300">#{scanCount}</span>
                {analyzing && <span className="text-xs text-amber-400 animate-pulse">OCR…</span>}
                {diffPct > 0 && <span className="text-xs text-zinc-600">Δ{diffPct}%</span>}
              </div>
              <button onClick={stopAll} className="bg-black/70 rounded-full px-3 py-1 text-xs text-zinc-400 hover:text-red-400 backdrop-blur-sm">
                ✕ Стоп
              </button>
            </div>
          )}
        </div>

        {/* ── RIGHT PANEL ── */}
        {phase === 'scanning' && (
          <div className="w-full lg:w-80 bg-zinc-950 border-t lg:border-t-0 lg:border-l border-zinc-800 flex flex-col overflow-y-auto">

            {/* Action box */}
            {advice ? (
              <div className={cn('p-5 text-center transition-all duration-300', advice.color)}>
                <div className="text-5xl font-black tracking-widest text-white drop-shadow-lg">{advice.displayText}</div>
                {advice.sizing   && <div className="text-white/80 text-base font-bold mt-1">{advice.sizing}</div>}
                <div className="text-white/70 text-sm mt-0.5">{advice.handCategory}</div>
                {advice.handName && <div className="text-white/60 text-xs mt-0.5">{advice.handName}</div>}
              </div>
            ) : (
              <div className="p-5 text-center bg-zinc-900 border-b border-zinc-800">
                <p className="text-zinc-500 text-sm">Анализирую экран…</p>
                <p className="text-zinc-700 text-xs mt-1">Настрой «Размер карты» ниже если OCR не видит карты</p>
              </div>
            )}

            <div className="p-3 space-y-3 flex-1 overflow-y-auto">

              {/* Win prob */}
              {advice && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-zinc-500 text-xs uppercase tracking-widest">Win Prob</span>
                    <span className={cn('text-xl font-black',
                      advice.equity > 0.6 ? 'text-emerald-400' : advice.equity > 0.4 ? 'text-amber-400' : 'text-red-400'
                    )}>
                      {(advice.equity * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className={cn('h-full rounded-full transition-all duration-700',
                        advice.equity > 0.6 ? 'bg-emerald-500' : advice.equity > 0.4 ? 'bg-amber-500' : 'bg-red-500'
                      )}
                      style={{ width: `${advice.equity * 100}%` }}
                    />
                  </div>
                  {advice.usedRangeVsRange && (
                    <div className="text-[10px] text-zinc-600 italic mt-1.5">
                      Против диапазона виллана (~{advice.villainRangePct}% рук)
                    </div>
                  )}
                </div>
              )}

              {/* Advice details */}
              {advice?.details.length ? (
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-1.5">
                  {advice.details.map((d, i) => (
                    <div key={i} className="flex gap-2 text-sm text-zinc-300">
                      <span className="text-emerald-500 shrink-0">▸</span><span>{d}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {/* Pot odds + MDF */}
              {advice && (advice.potOdds !== null || advice.mdf !== null) && (
                <div className="grid grid-cols-2 gap-2">
                  {advice.potOdds !== null && (
                    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-center">
                      <div className="text-base font-black text-zinc-200">{(advice.potOdds * 100).toFixed(0)}%</div>
                      <div className="text-zinc-600 text-xs">Пот-оддс</div>
                    </div>
                  )}
                  {advice.mdf !== null && (
                    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-center">
                      <div className="text-base font-black text-zinc-200">{(advice.mdf * 100).toFixed(0)}%</div>
                      <div className="text-zinc-600 text-xs">MDF</div>
                    </div>
                  )}
                </div>
              )}

              {/* Draws */}
              {advice?.draws && advice.draws.totalOuts > 0 && (
                <div className="bg-teal-950/50 border border-teal-800/50 rounded-lg p-3">
                  <p className="text-teal-400 text-xs font-bold mb-1">ДРОУ</p>
                  <p className="text-teal-300 text-sm">{advice.draws.description}</p>
                  <p className="text-teal-600 text-xs mt-1">
                    {advice.draws.discountedOuts} чистых outs (из {advice.draws.totalOuts}) → ~{advice.draws.equityRiverClean}%
                  </p>
                  {advice.draws.antiOutsNote && (
                    <p className="text-teal-800 text-xs mt-1 italic">{advice.draws.antiOutsNote}</p>
                  )}
                </div>
              )}

              {/* Bluff read — heuristic only, not mind-reading */}
              {advice?.bluffRead && (
                <div className={cn('rounded-lg p-3 border',
                  advice.bluffRead.label === 'Вероятно блеф' ? 'bg-orange-950/50 border-orange-800/50' :
                  advice.bluffRead.label === 'Похоже на вэлью' ? 'bg-blue-950/50 border-blue-800/50' :
                  'bg-zinc-900 border-zinc-800'
                )}>
                  <p className="text-zinc-400 text-xs font-bold uppercase tracking-wider mb-1">Read виллана</p>
                  <p className="text-sm font-bold text-zinc-100">{advice.bluffRead.label}</p>
                  <div className="mt-1.5 space-y-1">
                    {advice.bluffRead.reasons.map((r, i) => (
                      <p key={i} className="text-zinc-500 text-xs">▸ {r}</p>
                    ))}
                  </div>
                  <p className="text-zinc-700 text-[10px] mt-1.5 italic">Эвристика по сайзингу/борду, не чтение карт — доверяй математике больше</p>
                </div>
              )}

              {/* Duplicate-card guard */}
              {dupWarning && (
                <div className="bg-red-950/50 border border-red-800/50 rounded-lg p-3">
                  <p className="text-red-400 text-xs font-bold">⚠ {dupWarning}</p>
                  <p className="text-red-500/70 text-[10px] mt-1">Одна и та же карта не может встретиться дважды — показываю прошлое надёжное состояние.</p>
                </div>
              )}

              {/* Detected cards — tap any card to correct a misread */}
              {(holeCards.length > 0 || boardCards.length > 0) && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-2">
                  {holeCards.length > 0 && (
                    <div>
                      <p className="text-zinc-600 text-xs uppercase tracking-widest mb-1.5">Мои карты (тапни, чтобы исправить)</p>
                      <div className="flex gap-2">
                        {holeCards.map((c, i) => (
                          <CardPicker
                            key={holeLabels[i] ?? i}
                            selectedCard={c}
                            disabledCards={[...holeCards, ...boardCards].filter(x => x !== c)}
                            onSelect={(card) => handleManualOverride(holeLabels[i], card)}
                            trigger={
                              <button className="w-10 h-14 bg-zinc-100 rounded flex flex-col items-center justify-center border border-zinc-300 shadow hover:ring-2 hover:ring-emerald-500 transition-shadow">
                                <span className={cn('text-sm font-black leading-none', suitCls(c.suit))}>{rankLabel(c.rank)}</span>
                                <span className={cn('text-sm leading-none', suitCls(c.suit))}>{suitSym(c.suit)}</span>
                              </button>
                            }
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  {boardCards.length > 0 && (
                    <div>
                      <p className="text-zinc-600 text-xs uppercase tracking-widest mb-1.5">Борд (тапни, чтобы исправить)</p>
                      <div className="flex gap-1 flex-wrap">
                        {boardCards.map((c, i) => (
                          <CardPicker
                            key={boardLabels[i] ?? i}
                            selectedCard={c}
                            disabledCards={[...holeCards, ...boardCards].filter(x => x !== c)}
                            onSelect={(card) => handleManualOverride(boardLabels[i], card)}
                            trigger={
                              <button className="w-9 h-12 bg-zinc-100 rounded flex flex-col items-center justify-center border border-zinc-300 shadow hover:ring-2 hover:ring-emerald-500 transition-shadow">
                                <span className={cn('text-xs font-black leading-none', suitCls(c.suit))}>{rankLabel(c.rank)}</span>
                                <span className={cn('text-xs leading-none', suitCls(c.suit))}>{suitSym(c.suit)}</span>
                              </button>
                            }
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Game inputs */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-2">
                <p className="text-zinc-500 text-xs uppercase tracking-widest">Параметры игры</p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-zinc-600 text-xs flex items-center gap-1 mb-1">
                      Пот ($)
                      {autoPot && <span className="text-amber-400" title="Читается автоматически (OCR)">📷</span>}
                    </label>
                    <input type="number" min={0} placeholder="—" value={potSize ?? ''}
                      onChange={e => { setAutoPot(false); setPotSize(e.target.value ? Number(e.target.value) : null); }}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-emerald-600" />
                  </div>
                  <div>
                    <label className="text-zinc-600 text-xs flex items-center gap-1 mb-1">
                      Колл ($)
                      {autoBet && <span className="text-amber-400" title="Читается автоматически (OCR)">📷</span>}
                    </label>
                    <input type="number" min={0} placeholder="—" value={betToCall ?? ''}
                      onChange={e => { setAutoBet(false); setBetToCall(e.target.value ? Number(e.target.value) : null); }}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-emerald-600" />
                  </div>
                </div>
                {moneyCal ? (
                  <div className="flex items-center justify-between gap-1.5">
                    <p className="text-zinc-700 text-[10px]">📷 Банк/колл читаются сами — ничего настраивать не нужно</p>
                    <button onClick={startMoneyCalibration}
                      className="shrink-0 py-1 px-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-[10px] text-zinc-500">
                      Уточнить вручную
                    </button>
                  </div>
                ) : (
                  <button onClick={startMoneyCalibration}
                    className="w-full py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-xs text-amber-400">
                    📷 Настроить область банка/колла вручную
                  </button>
                )}
                <div>
                  <label className="text-zinc-600 text-xs block mb-1">Позиция</label>
                  <select value={position} onChange={e => setPosition(e.target.value as Position)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-emerald-600">
                    {(['UTG','MP','HJ','CO','BTN','SB','BB'] as Position[]).map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-zinc-600 text-xs shrink-0 flex items-center gap-1">
                    Игроков: {players}
                    {autoPlayers && <span className="text-purple-400" title="Считается автоматически по фолдам">👥</span>}
                  </label>
                  <input type="range" min={2} max={9} value={players}
                    onChange={e => { setAutoPlayers(false); setPlayers(Number(e.target.value)); }} className="flex-1 accent-emerald-500" />
                </div>
                {seatCal ? (
                  <div className="flex items-center justify-between gap-1.5">
                    <p className="text-zinc-700 text-[10px]">👥 Число игроков считается само — ничего настраивать не нужно</p>
                    <button onClick={startSeatCalibration}
                      className="shrink-0 py-1 px-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-[10px] text-zinc-500">
                      Уточнить вручную
                    </button>
                  </div>
                ) : (
                  <button onClick={startSeatCalibration}
                    className="w-full py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-xs text-purple-400">
                    👥 Настроить места соперников вручную
                  </button>
                )}
              </div>

              {/* Card size tuner — adjust if OCR reads wrong cards */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-zinc-500 text-xs uppercase tracking-widest">Размер карты</p>
                  <span className="text-emerald-400 text-xs font-bold">{cardSizePct}% высоты</span>
                </div>
                <input type="range" min={4} max={22} step={1} value={cardSizePct}
                  onChange={e => {
                    const v = Number(e.target.value);
                    setCardSizePct(v);
                    const saved = loadCalibration();
                    if (saved) saveCalibration(saved.regions, v);
                    fingerprintCache.current.clear(); // force re-OCR
                    overridesCache.current.clear();
                  }}
                  className="w-full accent-emerald-500"
                />
                <p className="text-zinc-700 text-xs">
                  Если карты определяются неверно — перемести ползунок. Типичные значения: 7–12%.
                </p>
              </div>

              {/* Debug view — see exactly what pixels OCR is reading right now.
                  Turn this on FIRST if recognition seems broken: it shows whether
                  each region is actually pointed at a card, or at empty table
                  because the capture no longer matches the saved calibration. */}
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-2">
                <button onClick={() => setDebugMode(v => !v)}
                  className="w-full flex items-center justify-between text-xs text-zinc-400">
                  <span>👁 Что видит OCR (debug)</span>
                  <span className={cn('px-2 py-0.5 rounded text-[10px] font-bold', debugMode ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-500')}>
                    {debugMode ? 'ВКЛ' : 'ВЫКЛ'}
                  </span>
                </button>
                {debugMode && (
                  <>
                    <p className="text-zinc-700 text-[10px]">
                      Если тут не карты (а стол/фон) — калибровка не совпадает с тем, что реально захватывается.
                      Перекалибруй или измени «Размер карты» так, чтобы рамки точно легли на карты.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(debugThumbs).map(([label, src]) => (
                        <div key={label} className="flex flex-col items-center gap-0.5">
                          <img src={src} alt={label} className="border border-zinc-700 rounded bg-white" style={{ imageRendering: 'pixelated' }} />
                          <span className="text-zinc-600 text-[9px]">{label}</span>
                        </div>
                      ))}
                      {Object.keys(debugThumbs).length === 0 && (
                        <p className="text-zinc-700 text-[10px]">Жди следующего скана...</p>
                      )}
                    </div>
                  </>
                )}
              </div>

              {lastScan && (
                <div className="flex items-center justify-between text-zinc-700 text-xs">
                  <span className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    LIVE → телефон
                  </span>
                  <span>{lastScan}</span>
                </div>
              )}

              <button
                onClick={() => {
                  if (scanLoopRef.current) { clearInterval(scanLoopRef.current); scanLoopRef.current = null; }
                  fingerprintCache.current.clear();
                  overridesCache.current.clear();
                  lastGoodRef.current = { hole: [], board: [], holeLabels: [], boardLabels: [] };
                  setPhase('calibrating'); setRegions([]); setCalStep(0);
                  setAdvice(null); setHoleCards([]); setBoardCards([]);
                  setHoleLabels([]); setBoardLabels([]); setDupWarning(null);
                  prevPixels.current = null;
                }}
                className="w-full py-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-500 transition-colors"
              >
                Перекалибровать
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
