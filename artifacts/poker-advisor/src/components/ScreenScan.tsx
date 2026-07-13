/**
 * ScreenScan — полностью автоматический анализ экрана
 * • getDisplayMedia() захват экрана
 * • Калибровка сохраняется в localStorage
 * • Frame-diff: OCR только когда экран изменился
 * • Tesseract.js OCR ранга + цветовой анализ масти
 * • GTO движок: getFullAdvice() с MDF, EV, дроу-детекцией
 * • Отправляет результат на /api/analysis → телефон видит в реальном времени
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createWorker, type Worker } from 'tesseract.js';
import { cn } from '@/lib/utils';
import { runMonteCarloSim, parseCard, type Card } from '@/lib/poker';
import { getFullAdvice, type FullAdvice, type Position } from '@/lib/poker-gto';

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase = 'idle' | 'requesting' | 'calibrating' | 'loading-ocr' | 'scanning';

interface CardRegion {
  label: string;
  cx: number; // 0-1 relative to video
  cy: number;
}

interface SavedCalibration {
  regions: CardRegion[];
  version: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CALIBRATION_STEPS: { label: string; hint: string }[] = [
  { label: 'Hole 1',  hint: 'Кликни на центр ПЕРВОЙ своей карты' },
  { label: 'Hole 2',  hint: 'Кликни на центр ВТОРОЙ своей карты' },
  { label: 'Board 1', hint: 'Флоп — 1-я карта (или пропусти)' },
  { label: 'Board 2', hint: 'Флоп — 2-я карта (или пропусти)' },
  { label: 'Board 3', hint: 'Флоп — 3-я карта (или пропусти)' },
  { label: 'Board 4', hint: 'Тёрн (или пропусти)' },
  { label: 'Board 5', hint: 'Ривер (или пропусти)' },
];

const STORAGE_KEY = 'poker_screen_calibration_v2';
const RANK_MAP: Record<string, string> = {
  a:'A', A:'A', k:'K', K:'K', q:'Q', Q:'Q',
  j:'J', J:'J', t:'T', T:'T', '1':'T', '10':'T', '0':'T',
  '2':'2','3':'3','4':'4','5':'5','6':'6','7':'7','8':'8','9':'9',
};

// ─── Calibration persistence ──────────────────────────────────────────────────

function saveCalibration(regions: CardRegion[]): void {
  try {
    const data: SavedCalibration = { regions, version: 2 };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {}
}

function loadCalibration(): CardRegion[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data: SavedCalibration = JSON.parse(raw);
    if (data.version !== 2 || !Array.isArray(data.regions) || data.regions.length < 2) return null;
    return data.regions;
  } catch {
    return null;
  }
}

// ─── Image helpers ────────────────────────────────────────────────────────────

function extractCardRegion(
  src: HTMLCanvasElement, cx: number, cy: number, cardW: number, cardH: number,
): HTMLCanvasElement {
  const x = Math.round(cx * src.width  - cardW / 2);
  const y = Math.round(cy * src.height - cardH / 2);
  const out = document.createElement('canvas');
  out.width = cardW; out.height = cardH;
  out.getContext('2d')!.drawImage(src, x, y, cardW, cardH, 0, 0, cardW, cardH);
  return out;
}

function extractRankArea(card: HTMLCanvasElement): HTMLCanvasElement {
  const W = Math.round(card.width  * 0.38);
  const H = Math.round(card.height * 0.42);
  const out = document.createElement('canvas');
  out.width = W * 3; out.height = H * 3;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(card, 0, 0, W, H, 0, 0, W * 3, H * 3);
  const id = ctx.getImageData(0, 0, out.width, out.height);
  const d  = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const avg = (d[i] + d[i+1] + d[i+2]) / 3;
    d[i] = d[i+1] = d[i+2] = avg > 140 ? 255 : 0;
  }
  ctx.putImageData(id, 0, 0);
  return out;
}

function detectSuit(card: HTMLCanvasElement): 'h'|'d'|'c'|'s' {
  const ctx = card.getContext('2d')!;
  const sx = Math.round(card.width  * 0.10);
  const sy = Math.round(card.height * 0.22);
  const sw = Math.round(card.width  * 0.25);
  const sh = Math.round(card.height * 0.18);
  const id = ctx.getImageData(sx, sy, sw, sh);
  const d  = id.data;
  let rSum = 0, gSum = 0, bSum = 0, count = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i+1], b = d[i+2];
    if (r > 200 && g > 200 && b > 200) continue;
    rSum += r; gSum += g; bSum += b; count++;
  }
  if (count === 0) return 'h';
  const rAvg = rSum/count, gAvg = gSum/count, bAvg = bSum/count;
  if (rAvg > 140 && gAvg < 100) {
    const upper = ctx.getImageData(sx, sy, sw, Math.round(sh * 0.5));
    let ur = 0;
    for (let i = 0; i < upper.data.length; i += 4) {
      if (upper.data[i] > 140 && upper.data[i+1] < 100) ur++;
    }
    return (ur / (sw * Math.round(sh * 0.5) / 4)) > 0.1 ? 'h' : 'd';
  }
  if (rAvg < 120 && gAvg < 120 && bAvg < 120) {
    const topD = ctx.getImageData(sx, sy, sw, Math.round(sh * 0.45)).data;
    const botD = ctx.getImageData(sx, sy + Math.round(sh * 0.55), sw, Math.round(sh * 0.45)).data;
    let top = 0, bot = 0;
    for (let i = 0; i < topD.length; i += 4) if (topD[i] < 100) top++;
    for (let i = 0; i < botD.length; i += 4) if (botD[i] < 100) bot++;
    return bot > top ? 'c' : 's';
  }
  return 'h';
}

function parseRank(raw: string): string | null {
  const c = raw.replace(/[^AaKkQqJjTt0-9]/g, '').trim();
  if (!c) return null;
  if (c === '10' || c === '1O' || c === 'IO') return 'T';
  return RANK_MAP[c[0]] ?? null;
}

// ─── Frame diff (detect screen change) ───────────────────────────────────────
// Sample every 8th pixel in a downscaled region; returns fraction of changed pixels

function frameDiff(prev: Uint8ClampedArray, curr: Uint8ClampedArray, threshold = 40): number {
  const len = Math.min(prev.length, curr.length);
  let diff = 0;
  const step = 8 * 4; // every 8th pixel
  let total = 0;
  for (let i = 0; i < len; i += step) {
    const dr = Math.abs(prev[i] - curr[i]);
    const dg = Math.abs(prev[i+1] - curr[i+1]);
    const db = Math.abs(prev[i+2] - curr[i+2]);
    if (dr + dg + db > threshold) diff++;
    total++;
  }
  return total > 0 ? diff / total : 0;
}

// ─── Push to server for phone sync ───────────────────────────────────────────

async function pushAnalysis(payload: object): Promise<void> {
  try {
    await fetch('/api/analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {}
}

// ─── Display helpers ──────────────────────────────────────────────────────────

const suitSym  = (s: string) => ({ h:'♥', d:'♦', c:'♣', s:'♠' }[s] ?? s);
const suitCls  = (s: string) => s === 'h' || s === 'd' ? 'text-red-400' : 'text-zinc-200';
const rankLabel = (r: number) => ({ 14:'A',13:'K',12:'Q',11:'J',10:'T' }[r] ?? String(r));

// ─── Component ────────────────────────────────────────────────────────────────

export function ScreenScan() {
  const [phase, setPhase]         = useState<Phase>('idle');
  const [regions, setRegions]     = useState<CardRegion[]>([]);
  const [calStep, setCalStep]     = useState(0);
  const [advice, setAdvice]       = useState<FullAdvice | null>(null);
  const [holeCards, setHoleCards] = useState<Card[]>([]);
  const [boardCards, setBoardCards] = useState<Card[]>([]);
  const [error, setError]         = useState<string | null>(null);
  const [scanCount, setScanCount] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [lastScan, setLastScan]   = useState<string | null>(null);
  const [diffPct, setDiffPct]     = useState(0);
  const [hasSaved, setHasSaved]   = useState(false);

  // Game state inputs
  const [players, setPlayers]     = useState(4);
  const [potSize, setPotSize]     = useState<number | null>(null);
  const [betToCall, setBetToCall] = useState<number | null>(null);
  const [position, setPosition]   = useState<Position>('BTN');

  const videoRef    = useRef<HTMLVideoElement>(null);
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const diffCanvas  = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const workerRef   = useRef<Worker | null>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const scanLoopRef = useRef<NodeJS.Timeout | null>(null);
  const prevPixels  = useRef<Uint8ClampedArray | null>(null);
  const analyzingRef = useRef(false);

  // Check for saved calibration
  useEffect(() => {
    setHasSaved(loadCalibration() !== null);
  }, []);

  // ── Start screen capture ──────────────────────────────────────────────────
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
      await video.play();
      stream.getVideoTracks()[0].addEventListener('ended', stopAll);

      if (skipCalibration) {
        const saved = loadCalibration();
        if (saved && saved.length >= 2) {
          setRegions(saved);
          await loadOcr(saved, true);
          return;
        }
      }
      setPhase('calibrating');
      setCalStep(0);
      setRegions([]);
    } catch (err: any) {
      setError(err?.name === 'NotAllowedError'
        ? 'Доступ к экрану отклонён — разреши захват и попробуй снова'
        : err?.message ?? 'Не удалось захватить экран');
      setPhase('idle');
    }
  }, []);

  // ── Stop everything ───────────────────────────────────────────────────────
  const stopAll = useCallback(() => {
    if (scanLoopRef.current) { clearInterval(scanLoopRef.current); scanLoopRef.current = null; }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    prevPixels.current = null;
    setPhase('idle');
    setRegions([]);
    setCalStep(0);
  }, []);

  // ── Calibration tap ───────────────────────────────────────────────────────
  const handleVideoTap = useCallback(async (e: React.MouseEvent<HTMLVideoElement>) => {
    if (phase !== 'calibrating') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = (e.clientX - rect.left) / rect.width;
    const cy = (e.clientY - rect.top)  / rect.height;
    const step = CALIBRATION_STEPS[calStep];
    const newRegions = [...regions, { label: step.label, cx, cy }];
    setRegions(newRegions);
    const next = calStep + 1;
    if (next >= CALIBRATION_STEPS.length) {
      saveCalibration(newRegions);
      setHasSaved(true);
      await loadOcr(newRegions, true);
    } else {
      setCalStep(next);
    }
  }, [phase, calStep, regions]);

  const skipCard = useCallback(async () => {
    if (calStep < 2) return;
    const next = calStep + 1;
    if (next >= CALIBRATION_STEPS.length) {
      saveCalibration(regions);
      setHasSaved(true);
      await loadOcr(regions, true);
    } else {
      setCalStep(next);
    }
  }, [calStep, regions]);

  // ── Load Tesseract ────────────────────────────────────────────────────────
  const loadOcr = useCallback(async (finalRegions: CardRegion[], autoStart: boolean) => {
    setPhase('loading-ocr');
    try {
      if (!workerRef.current) {
        const w = await createWorker('eng', 1, { logger: () => {} });
        await w.setParameters({
          tessedit_char_whitelist: 'AaKkQqJjTt23456789',
          tessedit_pageseg_mode: '10' as any,
        });
        workerRef.current = w;
      }
      setRegions(finalRegions);
      if (autoStart) {
        startScanLoop(finalRegions);
      } else {
        setPhase('scanning');
      }
    } catch {
      setError('Не удалось загрузить OCR движок');
      setPhase('calibrating');
    }
  }, []);

  // ── Frame capture to canvas ───────────────────────────────────────────────
  const captureToCanvas = useCallback((): HTMLCanvasElement | null => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return null;
    canvas.width  = video.videoWidth  || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    return canvas;
  }, []);

  // ── OCR one frame ─────────────────────────────────────────────────────────
  const runOCR = useCallback(async (canvas: HTMLCanvasElement, currentRegions: CardRegion[]) => {
    const worker = workerRef.current;
    if (!worker || currentRegions.length < 2) return;

    if (analyzingRef.current) return;
    analyzingRef.current = true;
    setAnalyzing(true);

    try {
      const cardH = Math.round(canvas.height * 0.10);
      const cardW = Math.round(cardH * 0.69);

      const detected: { rank: string | null; suit: string; card: Card | null; raw: string }[] = [];
      for (const region of currentRegions) {
        const cardC = extractCardRegion(canvas, region.cx, region.cy, cardW, cardH);
        const rankC = extractRankArea(cardC);
        const { data } = await worker.recognize(rankC);
        const raw  = data.text.trim();
        const rank = parseRank(raw);
        const suit = detectSuit(cardC);
        let card: Card | null = null;
        if (rank) { try { card = parseCard(`${rank}${suit}`); } catch {} }
        detected.push({ rank, suit, card, raw });
      }

      const hole  = detected.slice(0, 2).filter(d => d.card).map(d => d.card!);
      const board = detected.slice(2).filter(d => d.card).map(d => d.card!);

      setHoleCards(hole);
      setBoardCards(board);

      if (hole.length === 2) {
        const sim = runMonteCarloSim(hole, board, players, 3000);
        const fullAdvice = getFullAdvice(
          hole, board,
          potSize ?? 0,
          betToCall ?? 0,
          players,
          position,
          sim,
        );
        setAdvice(fullAdvice);

        // Push to server → phone sees it
        await pushAnalysis({
          holeCards: hole.map(c => `${c.rank}${c.suit}`),
          boardCards: board.map(c => `${c.rank}${c.suit}`),
          action: fullAdvice.action,
          displayText: fullAdvice.displayText,
          color: fullAdvice.color,
          details: fullAdvice.details,
          equity: fullAdvice.equity,
          potOdds: fullAdvice.potOdds,
          mdf: fullAdvice.mdf,
          handCategory: fullAdvice.handCategory,
          handName: fullAdvice.handName,
          draws: fullAdvice.draws,
          sizing: fullAdvice.sizing,
          potSize,
          betToCall,
          players,
          position,
        });
      }

      setScanCount(n => n + 1);
      setLastScan(new Date().toLocaleTimeString('ru'));
    } catch (err: any) {
      // Silently skip frame errors
    } finally {
      analyzingRef.current = false;
      setAnalyzing(false);
    }
  }, [players, potSize, betToCall, position]);

  // ── Scan loop (frame-diff gated) ──────────────────────────────────────────
  const startScanLoop = useCallback((currentRegions: CardRegion[]) => {
    setPhase('scanning');

    // Check every 800ms; run OCR only when frame changed or every 5s
    let ticksSinceOcr = 0;
    const loop = setInterval(async () => {
      const canvas = captureToCanvas();
      if (!canvas) return;
      ticksSinceOcr++;

      // Downscale for diff
      const dc = diffCanvas.current;
      dc.width = 160; dc.height = 90;
      dc.getContext('2d')!.drawImage(canvas, 0, 0, 160, 90);
      const curr = dc.getContext('2d')!.getImageData(0, 0, 160, 90).data;

      let changed = false;
      if (prevPixels.current) {
        const diff = frameDiff(prevPixels.current, curr);
        setDiffPct(Math.round(diff * 100));
        changed = diff > 0.025; // 2.5% of pixels changed
      } else {
        changed = true;
      }
      prevPixels.current = new Uint8ClampedArray(curr);

      // Run OCR if changed, or as forced refresh every ~5 seconds
      if ((changed || ticksSinceOcr >= 6) && !analyzingRef.current) {
        ticksSinceOcr = 0;
        await runOCR(canvas, currentRegions);
      }
    }, 800);

    scanLoopRef.current = loop;
  }, [captureToCanvas, runOCR]);

  useEffect(() => {
    return () => {
      stopAll();
      workerRef.current?.terminate();
    };
  }, []);

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col min-h-screen bg-[#0d1117] text-zinc-100 font-mono">

      {/* ── IDLE ── */}
      {phase === 'idle' && (
        <div className="flex flex-col items-center justify-center flex-1 gap-5 p-6 text-center max-w-lg mx-auto">
          <div className="text-5xl">🖥️</div>
          <div>
            <h2 className="text-2xl font-bold mb-2">Авто-скан экрана</h2>
            <p className="text-zinc-500 text-sm leading-relaxed">
              Захватывает экран → OCR карт → GTO анализ (MDF, EV, дроу) → отправляет на телефон в реальном времени. Никаких API-ключей.
            </p>
          </div>

          <div className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-4 text-left space-y-1.5">
            {[
              'Открой TON Poker в Telegram Desktop',
              'Нажми «Начать» — выбери окно Telegram',
              'Один раз кликни на каждую карту (калибровка сохраняется)',
              'Советы идут автоматически + на телефон через вкладку 📱 Эфир',
            ].map((s, i) => (
              <div key={i} className="flex gap-2 text-sm text-zinc-400">
                <span className="text-emerald-400 font-bold shrink-0">{i+1}.</span>
                <span>{s}</span>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2 w-full max-w-xs">
            {hasSaved && (
              <button
                onClick={() => startCapture(true)}
                className="w-full px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold text-sm transition-colors shadow-[0_0_20px_rgba(5,150,105,0.3)]"
              >
                ▶ Запустить (сохранённая калибровка)
              </button>
            )}
            <button
              onClick={() => startCapture(false)}
              className={cn(
                'w-full px-6 py-3 rounded-xl font-bold text-sm transition-colors',
                hasSaved
                  ? 'bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-[0_0_20px_rgba(5,150,105,0.3)]'
              )}
            >
              {hasSaved ? '⟳ Перекалибровать и запустить' : 'Начать захват экрана'}
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

      {/* ── CALIBRATING / SCANNING (video + panel) ── */}
      {(phase === 'calibrating' || phase === 'scanning' || phase === 'loading-ocr') && (
        <div className="flex flex-col lg:flex-row flex-1 gap-0">

          {/* Video preview */}
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
              <div
                key={i}
                className="absolute w-6 h-6 rounded-full border-2 border-white bg-emerald-500/80 -translate-x-3 -translate-y-3 pointer-events-none z-10"
                style={{ left: `${r.cx * 100}%`, top: `${r.cy * 100}%` }}
              >
                <span className="absolute text-[8px] font-bold text-white left-7 top-0.5 bg-black/70 px-1 rounded whitespace-nowrap">
                  {r.label}
                </span>
              </div>
            ))}

            {/* Region dots during scan */}
            {phase === 'scanning' && regions.map((r, i) => (
              <div
                key={i}
                className={cn(
                  'absolute w-3 h-3 rounded-full border border-white/50 -translate-x-1.5 -translate-y-1.5 pointer-events-none z-10',
                  i < 2 ? 'bg-emerald-400/50' : 'bg-blue-400/50'
                )}
                style={{ left: `${r.cx * 100}%`, top: `${r.cy * 100}%` }}
              />
            ))}

            {/* Calibration overlay */}
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
                    <div key={i} className={cn('w-2 h-2 rounded-full transition-colors', i < calStep ? 'bg-emerald-500' : i === calStep ? 'bg-white' : 'bg-zinc-700')} />
                  ))}
                </div>
              </div>
            )}

            {/* Loading OCR */}
            {phase === 'loading-ocr' && (
              <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-3 z-20">
                <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                <p className="text-sm text-zinc-300">Загрузка OCR движка...</p>
                <p className="text-xs text-zinc-500">Один раз ~5 сек</p>
              </div>
            )}

            {/* Status bar */}
            {phase === 'scanning' && (
              <div className="absolute top-2 left-2 right-2 flex items-center justify-between z-20">
                <div className="flex items-center gap-2 bg-black/70 rounded-full px-3 py-1 backdrop-blur-sm">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-xs text-zinc-300">Скан #{scanCount}</span>
                  {analyzing && <span className="text-xs text-amber-400 animate-pulse">OCR...</span>}
                  {diffPct > 0 && <span className="text-xs text-zinc-600">Δ{diffPct}%</span>}
                </div>
                <button
                  onClick={stopAll}
                  className="bg-black/70 rounded-full px-3 py-1 text-xs text-zinc-400 hover:text-red-400 backdrop-blur-sm"
                >
                  ✕ Стоп
                </button>
              </div>
            )}
          </div>

          {/* RIGHT PANEL */}
          {phase === 'scanning' && (
            <div className="w-full lg:w-80 bg-zinc-950 border-t lg:border-t-0 lg:border-l border-zinc-800 flex flex-col overflow-y-auto">

              {/* Advice block */}
              {advice ? (
                <div className={cn('p-5 text-center transition-all duration-300', advice.color)}>
                  <div className="text-5xl font-black tracking-widest text-white drop-shadow-lg">
                    {advice.displayText}
                  </div>
                  {advice.sizing && (
                    <div className="text-white/80 text-base font-bold mt-1">{advice.sizing}</div>
                  )}
                  <div className="text-white/70 text-sm mt-0.5">{advice.handCategory}</div>
                  {advice.handName && (
                    <div className="text-white/60 text-xs mt-0.5">{advice.handName}</div>
                  )}
                </div>
              ) : (
                <div className="p-5 text-center bg-zinc-900 border-b border-zinc-800">
                  <p className="text-zinc-500 text-sm">Анализирую экран...</p>
                </div>
              )}

              <div className="p-3 space-y-3 flex-1 overflow-y-auto">

                {/* Win probability */}
                {advice && (
                  <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-zinc-500 text-xs uppercase tracking-widest">Win Prob</span>
                      <span className={cn(
                        'text-xl font-black',
                        advice.equity > 0.6 ? 'text-emerald-400' :
                        advice.equity > 0.4 ? 'text-amber-400' : 'text-red-400'
                      )}>
                        {(advice.equity * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        className={cn('h-full rounded-full transition-all duration-700',
                          advice.equity > 0.6 ? 'bg-emerald-500' :
                          advice.equity > 0.4 ? 'bg-amber-500' : 'bg-red-500'
                        )}
                        style={{ width: `${advice.equity * 100}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Details */}
                {advice?.details.length ? (
                  <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-1.5">
                    {advice.details.map((d, i) => (
                      <div key={i} className="flex gap-2 text-sm text-zinc-300">
                        <span className="text-emerald-500 shrink-0">▸</span>
                        <span>{d}</span>
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

                {/* Draw info */}
                {advice?.draws && advice.draws.totalOuts > 0 && (
                  <div className="bg-teal-950/50 border border-teal-800/50 rounded-lg p-3">
                    <p className="text-teal-400 text-xs font-bold mb-1">ДРОУ</p>
                    <p className="text-teal-300 text-sm">{advice.draws.description}</p>
                    <p className="text-teal-600 text-xs mt-1">
                      {advice.draws.totalOuts} outs → ~{advice.draws.equityRiver}% equity
                    </p>
                  </div>
                )}

                {/* Cards display */}
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

                {/* Game state inputs */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-2">
                  <p className="text-zinc-500 text-xs uppercase tracking-widest">Параметры игры</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-zinc-600 text-xs block mb-1">Пот ($)</label>
                      <input
                        type="number" min={0} placeholder="—" value={potSize ?? ''}
                        onChange={e => setPotSize(e.target.value ? Number(e.target.value) : null)}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-emerald-600"
                      />
                    </div>
                    <div>
                      <label className="text-zinc-600 text-xs block mb-1">Колл ($)</label>
                      <input
                        type="number" min={0} placeholder="—" value={betToCall ?? ''}
                        onChange={e => setBetToCall(e.target.value ? Number(e.target.value) : null)}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-emerald-600"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-zinc-600 text-xs block mb-1">Позиция</label>
                    <select
                      value={position}
                      onChange={e => setPosition(e.target.value as Position)}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-emerald-600"
                    >
                      {(['UTG','MP','HJ','CO','BTN','SB','BB'] as Position[]).map(p => (
                        <option key={p} value={p}>{p}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-zinc-600 text-xs">Игроков: {players}</label>
                    <input
                      type="range" min={2} max={9} value={players}
                      onChange={e => setPlayers(Number(e.target.value))}
                      className="flex-1 accent-emerald-500"
                    />
                  </div>
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
                    setPhase('calibrating');
                    setRegions([]); setCalStep(0);
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
      )}
    </div>
  );
}
