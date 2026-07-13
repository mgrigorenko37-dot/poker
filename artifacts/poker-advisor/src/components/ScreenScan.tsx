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

// ─── Types ────────────────────────────────────────────────────────────────────
type Phase = 'idle' | 'requesting' | 'calibrating' | 'loading-ocr' | 'scanning';
interface CardRegion { label: string; cx: number; cy: number }
interface SavedCalibration { regions: CardRegion[]; cardSizePct: number; version: number }

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
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    // skip near-white background pixels
    if (d[i] > 200 && d[i+1] > 200 && d[i+2] > 200) continue;
    r += d[i]; g += d[i+1]; b += d[i+2]; n++;
  }
  if (!n) return 'h';
  r /= n; g /= n; b /= n;
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

// Process a list of regions with one worker (sequential within worker, safe)
async function processRegions(
  worker: Worker,
  src: HTMLCanvasElement,
  regs: CardRegion[],
  cardW: number, cardH: number,
  fps: Map<string, { fp: string; card: Card | null }>,
): Promise<(Card | null)[]> {
  const results: (Card | null)[] = [];
  for (const region of regs) {
    const key = region.label;
    const fp  = regionFingerprint(src, region.cx, region.cy, cardW, cardH);
    const cached = fps.get(key);
    if (cached?.fp === fp) { results.push(cached.card); continue; } // no change

    const cardC = extractCardRegion(src, region.cx, region.cy, cardW, cardH);
    const rankC = extractRankArea(cardC);
    const { data } = await worker.recognize(rankC);
    const rank = parseRank(data.text.trim());
    const suit = detectSuit(cardC);
    let card: Card | null = null;
    if (rank) { try { card = parseCard(`${rank}${suit}`); } catch {} }
    fps.set(key, { fp, card });
    results.push(card);
  }
  return results;
}

// ─── Component ────────────────────────────────────────────────────────────────
export function ScreenScan() {
  const [phase, setPhase]           = useState<Phase>('idle');
  const [regions, setRegions]       = useState<CardRegion[]>([]);
  const [calStep, setCalStep]       = useState(0);
  const [advice, setAdvice]         = useState<FullAdvice | null>(null);
  const [holeCards, setHoleCards]   = useState<Card[]>([]);
  const [boardCards, setBoardCards] = useState<Card[]>([]);
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

  const videoRef     = useRef<HTMLVideoElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const diffCanvas   = useRef<HTMLCanvasElement | null>(null);
  // Two workers: [0] for hole cards, [1] for board cards
  const workersRef   = useRef<Worker[]>([]);
  const streamRef    = useRef<MediaStream | null>(null);
  const scanLoopRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevPixels   = useRef<Uint8ClampedArray | null>(null);
  const analyzingRef = useRef(false);
  // Per-region fingerprint cache
  const fingerprintCache = useRef<Map<string, { fp: string; card: Card | null }>>(new Map());

  useEffect(() => {
    diffCanvas.current = document.createElement('canvas');
    const saved = loadCalibration();
    setHasSaved(saved !== null);
    if (saved?.cardSizePct) setCardSizePct(saved.cardSizePct);
  }, []);

  // ── Stop ─────────────────────────────────────────────────────────────────
  const stopAll = useCallback(() => {
    if (scanLoopRef.current) { clearInterval(scanLoopRef.current); scanLoopRef.current = null; }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    prevPixels.current = null;
    fingerprintCache.current.clear();
    setPhase('idle');
    setRegions([]);
    setCalStep(0);
  }, []);

  // ── Start capture ─────────────────────────────────────────────────────────
  const startCapture = useCallback(async (skipCalibration = false) => {
    setError(null);
    setPhase('requesting');
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 5, max: 15 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      stream.getVideoTracks()[0].addEventListener('ended', stopAll);
      video.play().catch(() => {});

      if (skipCalibration) {
        const saved = loadCalibration();
        if (saved) {
          setRegions(saved.regions);
          if (saved.cardSizePct) setCardSizePct(saved.cardSizePct);
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
    if (phase !== 'calibrating') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = (e.clientX - rect.left) / rect.width;
    const cy = (e.clientY - rect.top)  / rect.height;
    const newRegions = [...regions, { label: CALIBRATION_STEPS[calStep].label, cx, cy }];
    setRegions(newRegions);
    const next = calStep + 1;
    if (next >= CALIBRATION_STEPS.length) {
      saveCalibration(newRegions, cardSizePct);
      setHasSaved(true);
      await loadOcr(newRegions, true);
    } else {
      setCalStep(next);
    }
  }, [phase, calStep, regions, cardSizePct]);

  const skipCard = useCallback(async () => {
    if (calStep < 2) return;
    const next = calStep + 1;
    if (next >= CALIBRATION_STEPS.length) {
      saveCalibration(regions, cardSizePct);
      setHasSaved(true);
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
      setRegions(finalRegions);
      if (autoStart) startScanLoop(finalRegions);
      else setPhase('scanning');
    } catch {
      setError('Не удалось загрузить OCR движок');
      setPhase('calibrating');
    }
  }, []);

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
        processRegions(w1, canvas, holeRegs,  cardW, cardH, fingerprintCache.current),
        processRegions(w2, canvas, boardRegs, cardW, cardH, fingerprintCache.current),
      ]);

      const hole  = holeResults.filter((c): c is Card => c !== null);
      const board = boardResults.filter((c): c is Card => c !== null);
      setHoleCards(hole);
      setBoardCards(board);

      if (hole.length === 2) {
        const sim = runMonteCarloSim(hole, board, players, 3000);
        const fa  = getFullAdvice(hole, board, potSize ?? 0, betToCall ?? 0, players, position, sim);
        setAdvice(fa);
        await pushAnalysis({
          holeCards:  hole.map(c => `${c.rank}${c.suit}`),
          boardCards: board.map(c => `${c.rank}${c.suit}`),
          action: fa.action, displayText: fa.displayText, color: fa.color,
          details: fa.details, equity: fa.equity, potOdds: fa.potOdds, mdf: fa.mdf,
          handCategory: fa.handCategory, handName: fa.handName, draws: fa.draws,
          sizing: fa.sizing, potSize, betToCall, players, position,
        });
      }
      setScanCount(n => n + 1);
      setLastScan(new Date().toLocaleTimeString('ru'));
    } catch {}
    finally { analyzingRef.current = false; setAnalyzing(false); }
  }, [players, potSize, betToCall, position]);

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
        changed = d > 0.02;
      }
      prevPixels.current = new Uint8ClampedArray(curr);

      if ((changed || ticks >= 5) && !analyzingRef.current) {
        ticks = 0;
        await runOCR(canvas, regs, getSizePct());
      }
    }, 700);
    scanLoopRef.current = loop;
  }, [captureToCanvas, runOCR]);

  // Ref for cardSizePct so scan loop closure always reads latest value
  const cardSizePctRef = useRef(cardSizePct);
  useEffect(() => { cardSizePctRef.current = cardSizePct; }, [cardSizePct]);

  useEffect(() => () => {
    stopAll();
    workersRef.current.forEach(w => w.terminate());
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
              'Открой TON Poker в Telegram Desktop',
              'Нажми «Запустить» — выбери окно Telegram',
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
            className={cn('w-full h-full object-contain', phase === 'calibrating' ? 'cursor-crosshair' : '')}
            playsInline muted autoPlay
            onClick={handleVideoTap}
          />
          <canvas ref={canvasRef} className="hidden" />

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
          {phase === 'scanning' && regions.map((r, i) => (
            <div key={i}
              className={cn('absolute w-3 h-3 rounded-full border border-white/50 -translate-x-1.5 -translate-y-1.5 pointer-events-none z-10',
                i < 2 ? 'bg-emerald-400/60' : 'bg-blue-400/60'
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
                  <p className="text-teal-600 text-xs mt-1">{advice.draws.totalOuts} outs → ~{advice.draws.equityRiver}%</p>
                </div>
              )}

              {/* Detected cards */}
              {(holeCards.length > 0 || boardCards.length > 0) && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-2">
                  {holeCards.length > 0 && (
                    <div>
                      <p className="text-zinc-600 text-xs uppercase tracking-widest mb-1.5">Мои карты</p>
                      <div className="flex gap-2">
                        {holeCards.map((c, i) => (
                          <div key={i} className="w-10 h-14 bg-zinc-100 rounded flex flex-col items-center justify-center border border-zinc-300 shadow">
                            <span className={cn('text-sm font-black leading-none', suitCls(c.suit))}>{rankLabel(c.rank)}</span>
                            <span className={cn('text-sm leading-none', suitCls(c.suit))}>{suitSym(c.suit)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {boardCards.length > 0 && (
                    <div>
                      <p className="text-zinc-600 text-xs uppercase tracking-widest mb-1.5">Борд</p>
                      <div className="flex gap-1 flex-wrap">
                        {boardCards.map((c, i) => (
                          <div key={i} className="w-9 h-12 bg-zinc-100 rounded flex flex-col items-center justify-center border border-zinc-300 shadow">
                            <span className={cn('text-xs font-black leading-none', suitCls(c.suit))}>{rankLabel(c.rank)}</span>
                            <span className={cn('text-xs leading-none', suitCls(c.suit))}>{suitSym(c.suit)}</span>
                          </div>
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
                    <label className="text-zinc-600 text-xs block mb-1">Пот ($)</label>
                    <input type="number" min={0} placeholder="—" value={potSize ?? ''}
                      onChange={e => setPotSize(e.target.value ? Number(e.target.value) : null)}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-emerald-600" />
                  </div>
                  <div>
                    <label className="text-zinc-600 text-xs block mb-1">Колл ($)</label>
                    <input type="number" min={0} placeholder="—" value={betToCall ?? ''}
                      onChange={e => setBetToCall(e.target.value ? Number(e.target.value) : null)}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-emerald-600" />
                  </div>
                </div>
                <div>
                  <label className="text-zinc-600 text-xs block mb-1">Позиция</label>
                  <select value={position} onChange={e => setPosition(e.target.value as Position)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-emerald-600">
                    {(['UTG','MP','HJ','CO','BTN','SB','BB'] as Position[]).map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-zinc-600 text-xs shrink-0">Игроков: {players}</label>
                  <input type="range" min={2} max={9} value={players}
                    onChange={e => setPlayers(Number(e.target.value))} className="flex-1 accent-emerald-500" />
                </div>
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
                  }}
                  className="w-full accent-emerald-500"
                />
                <p className="text-zinc-700 text-xs">
                  Если карты определяются неверно — перемести ползунок. Типичные значения: 7–12%.
                </p>
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
                  setPhase('calibrating'); setRegions([]); setCalStep(0);
                  setAdvice(null); setHoleCards([]); setBoardCards([]);
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
