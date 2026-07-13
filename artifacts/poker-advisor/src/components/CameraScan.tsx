import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createWorker, type Worker } from 'tesseract.js';
import { cn } from '@/lib/utils';
import { runMonteCarloSim, calculateOuts, evaluateHand, HandRank, parseCard, type Card } from '@/lib/poker';

// ─── Types ────────────────────────────────────────────────────────────────────
type Phase = 'idle' | 'starting-camera' | 'calibrating' | 'loading-ocr' | 'ready' | 'scanning';

interface CardRegion {
  label: string;           // e.g. "Hole 1", "Board 1"
  cx: number;              // center x, 0–1 relative to video
  cy: number;              // center y, 0–1 relative to video
}

interface DetectedCard {
  rank: string;
  suit: string;
  card: Card | null;
  raw: string;
}

interface ScanResult {
  holeCards: Card[];
  boardCards: Card[];
  winProb: number | null;
  recommendation: { action: string; color: string; text: string } | null;
  raw: DetectedCard[];
}

// ─── Constants ────────────────────────────────────────────────────────────────
const CALIBRATION_STEPS: { label: string; hint: string }[] = [
  { label: 'Hole 1',  hint: 'Нажми на центр ПЕРВОЙ своей карты' },
  { label: 'Hole 2',  hint: 'Нажми на центр ВТОРОЙ своей карты' },
  { label: 'Board 1', hint: 'Флоп — 1-я карта (или пропусти)' },
  { label: 'Board 2', hint: 'Флоп — 2-я карта (или пропусти)' },
  { label: 'Board 3', hint: 'Флоп — 3-я карта (или пропусти)' },
  { label: 'Board 4', hint: 'Тёрн (или пропусти)' },
  { label: 'Board 5', hint: 'Ривер (или пропусти)' },
];

const RANK_MAP: Record<string, string> = {
  'a':'A','A':'A','k':'K','K':'K','q':'Q','Q':'Q',
  'j':'J','J':'J','t':'T','T':'T','1':'T','10':'T',
  '0':'T', // OCR sometimes reads 10 as "10" or "0"
  '2':'2','3':'3','4':'4','5':'5','6':'6','7':'7','8':'8','9':'9',
};

const SUIT_COLORS = ['h','d','c','s'] as const;
type Suit = typeof SUIT_COLORS[number];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract a card-sized crop from the canvas around (cx,cy) in 0-1 coords */
function extractCardRegion(
  src: HTMLCanvasElement,
  cx: number, cy: number,
  cardW: number, cardH: number,
): HTMLCanvasElement {
  const x = Math.round(cx * src.width  - cardW / 2);
  const y = Math.round(cy * src.height - cardH / 2);
  const out = document.createElement('canvas');
  out.width  = cardW;
  out.height = cardH;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(src, x, y, cardW, cardH, 0, 0, cardW, cardH);
  return out;
}

/** Crop only the top-left corner where rank+suit appear, sharpen contrast */
function extractRankArea(card: HTMLCanvasElement): HTMLCanvasElement {
  const W = Math.round(card.width * 0.38);
  const H = Math.round(card.height * 0.42);
  const out = document.createElement('canvas');
  out.width  = W * 3; // upscale for OCR
  out.height = H * 3;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(card, 0, 0, W, H, 0, 0, W * 3, H * 3);

  // Boost contrast
  const id = ctx.getImageData(0, 0, out.width, out.height);
  const d  = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const avg = (d[i] + d[i+1] + d[i+2]) / 3;
    const v   = avg > 140 ? 255 : 0; // binarise
    d[i] = d[i+1] = d[i+2] = v;
  }
  ctx.putImageData(id, 0, 0);
  return out;
}

/** Detect suit from the suit symbol area color (center of card) */
function detectSuit(card: HTMLCanvasElement): { suit: Suit; confidence: number } {
  const ctx = card.getContext('2d')!;
  // Sample the suit symbol region (upper-center)
  const sx = Math.round(card.width  * 0.10);
  const sy = Math.round(card.height * 0.22);
  const sw = Math.round(card.width  * 0.25);
  const sh = Math.round(card.height * 0.18);
  const id = ctx.getImageData(sx, sy, sw, sh);
  const d  = id.data;

  let rSum = 0, gSum = 0, bSum = 0, count = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i+1], b = d[i+2];
    // Skip near-white pixels (card background)
    if (r > 200 && g > 200 && b > 200) continue;
    rSum += r; gSum += g; bSum += b; count++;
  }

  if (count === 0) return { suit: 'h', confidence: 0 };

  const rAvg = rSum / count;
  const gAvg = gSum / count;
  const bAvg = bSum / count;

  const isRed   = rAvg > 140 && gAvg < 100;
  const isDark  = rAvg < 120 && gAvg < 120 && bAvg < 120;

  // Red: hearts or diamonds — distinguish by shape
  if (isRed) {
    // Hearts have color pixels in the upper half, diamonds more central/lower
    const upperCtx = card.getContext('2d')!;
    const upper = upperCtx.getImageData(sx, sy, sw, Math.round(sh * 0.5));
    let upperRed = 0;
    for (let i = 0; i < upper.data.length; i += 4) {
      if (upper.data[i] > 140 && upper.data[i+1] < 100) upperRed++;
    }
    const upperDensity = upperRed / (sw * Math.round(sh * 0.5) / 4);
    return { suit: upperDensity > 0.1 ? 'h' : 'd', confidence: 0.7 };
  }

  if (isDark) {
    // Clubs vs spades — clubs have wider bottom (3 bumps), spades have pointed top
    // Sample bottom portion vs top portion dark pixel density
    const topData  = ctx.getImageData(sx, sy, sw, Math.round(sh * 0.45)).data;
    const botData  = ctx.getImageData(sx, sy + Math.round(sh * 0.55), sw, Math.round(sh * 0.45)).data;
    let topDark = 0, botDark = 0;
    for (let i = 0; i < topData.length; i += 4) {
      if (topData[i] < 100) topDark++;
    }
    for (let i = 0; i < botData.length; i += 4) {
      if (botData[i] < 100) botDark++;
    }
    return { suit: botDark > topDark ? 'c' : 's', confidence: 0.6 };
  }

  return { suit: 'h', confidence: 0.2 };
}

/** Parse rank string from OCR text */
function parseRank(raw: string): string | null {
  const cleaned = raw.replace(/[^AaKkQqJjTt0-9]/g, '').trim();
  if (!cleaned) return null;

  // Handle "10"
  if (cleaned === '10' || cleaned === '1O' || cleaned === 'IO') return 'T';

  const first = cleaned[0];
  return RANK_MAP[first] ?? null;
}

/** Build card notation from rank + suit */
function buildCard(rank: string, suit: Suit): Card | null {
  try {
    return parseCard(`${rank}${suit}`);
  } catch {
    return null;
  }
}

/** Compute recommendation */
function recommend(
  holeCards: Card[], boardCards: Card[], players = 4,
): { winProb: number; rec: { action: string; color: string; text: string } } | null {
  if (holeCards.length < 2) return null;
  const sim = runMonteCarloSim(holeCards, boardCards, players, 3000);
  const w   = sim.winProb;

  let action: string, color: string, text: string;
  if (boardCards.length === 0) {
    // Pre-flop
    if (w > 0.68)      { action = 'RAISE'; color = 'bg-emerald-600'; text = `Сильная рука (${(w*100).toFixed(0)}%)` }
    else if (w > 0.50) { action = 'CALL';  color = 'bg-blue-600';    text = `Рука выше среднего (${(w*100).toFixed(0)}%)` }
    else               { action = 'FOLD';  color = 'bg-red-600';     text = `Слабая рука (${(w*100).toFixed(0)}%)` }
  } else {
    const ev = evaluateHand(holeCards, boardCards);
    if (ev && ev.handRank >= HandRank.FULL_HOUSE) {
      action = 'ALL-IN'; color = 'bg-amber-500'; text = 'Монстр — максимизируй пот';
    } else if (w > 0.65) {
      action = 'RAISE'; color = 'bg-emerald-600'; text = `Win ${(w*100).toFixed(0)}% — поднимай`;
    } else if (w > 0.40) {
      action = 'CALL';  color = 'bg-blue-600';    text = `Win ${(w*100).toFixed(0)}% — коллируй`;
    } else {
      action = 'FOLD';  color = 'bg-red-600';     text = `Win ${(w*100).toFixed(0)}% — фолд`;
    }
  }
  return { winProb: w, rec: { action, color, text } };
}

// ─── Component ────────────────────────────────────────────────────────────────
export function CameraScan() {
  const [phase, setPhase]               = useState<Phase>('idle');
  const [regions, setRegions]           = useState<CardRegion[]>([]);
  const [calStep, setCalStep]           = useState(0);
  const [result, setResult]             = useState<ScanResult | null>(null);
  const [error, setError]               = useState<string | null>(null);
  const [ocrReady, setOcrReady]         = useState(false);
  const [scanCount, setScanCount]       = useState(0);
  const [lastScan, setLastScan]         = useState<string | null>(null);
  const [analyzing, setAnalyzing]       = useState(false);

  const videoRef   = useRef<HTMLVideoElement>(null);
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const workerRef  = useRef<Worker | null>(null);
  const streamRef  = useRef<MediaStream | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // ── Start camera ──────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    setError(null);
    setPhase('starting-camera');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play();
      setPhase('calibrating');
      setCalStep(0);
      setRegions([]);
    } catch (err: any) {
      setError('Не удалось открыть камеру. Разреши доступ в браузере.');
      setPhase('idle');
    }
  }, []);

  // ── Stop everything ───────────────────────────────────────────────────────
  const stopAll = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setPhase('idle');
    setRegions([]);
    setCalStep(0);
    setResult(null);
  }, []);

  // ── Handle calibration tap ────────────────────────────────────────────────
  const handleVideoTap = useCallback((e: React.MouseEvent<HTMLVideoElement>) => {
    if (phase !== 'calibrating') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = (e.clientX - rect.left)  / rect.width;
    const cy = (e.clientY - rect.top)   / rect.height;
    const step = CALIBRATION_STEPS[calStep];

    setRegions(r => [...r, { label: step.label, cx, cy }]);
    if (calStep + 1 >= CALIBRATION_STEPS.length) {
      loadOcr();
    } else {
      setCalStep(c => c + 1);
    }
  }, [phase, calStep]);

  // ── Skip board card ───────────────────────────────────────────────────────
  const skipCard = useCallback(() => {
    if (calStep < 2) return; // can't skip hole cards
    if (calStep + 1 >= CALIBRATION_STEPS.length) {
      loadOcr();
    } else {
      setCalStep(c => c + 1);
    }
  }, [calStep]);

  // ── Load Tesseract ────────────────────────────────────────────────────────
  const loadOcr = useCallback(async () => {
    setPhase('loading-ocr');
    try {
      const worker = await createWorker('eng', 1, {
        logger: () => {},
      });
      await worker.setParameters({
        tessedit_char_whitelist: 'AaKkQqJjTt23456789',
        tessedit_pageseg_mode: '10' as any, // SINGLE_CHAR
      });
      workerRef.current = worker;
      setOcrReady(true);
      setPhase('ready');
    } catch (err) {
      setError('Не удалось загрузить OCR движок');
      setPhase('calibrating');
    }
  }, []);

  // ── Scan one frame ────────────────────────────────────────────────────────
  const scanFrame = useCallback(async () => {
    if (analyzing) return;
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    const worker = workerRef.current;
    if (!video || !canvas || !worker || regions.length < 2) return;

    setAnalyzing(true);
    try {
      // Draw video frame
      canvas.width  = video.videoWidth  || 640;
      canvas.height = video.videoHeight || 480;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(video, 0, 0);

      // Estimated card size (~12% of frame height, standard aspect)
      const cardH = Math.round(canvas.height * 0.15);
      const cardW = Math.round(cardH * 0.69);

      const detected: DetectedCard[] = [];

      for (const region of regions) {
        const cardCanvas = extractCardRegion(canvas, region.cx, region.cy, cardW, cardH);
        const rankCanvas = extractRankArea(cardCanvas);

        // OCR rank
        const { data } = await worker.recognize(rankCanvas);
        const rawText  = data.text.trim();
        const rank     = parseRank(rawText);

        // Detect suit from colour
        const { suit } = detectSuit(cardCanvas);

        const card = rank ? buildCard(rank, suit) : null;
        detected.push({ rank: rank ?? '?', suit, card, raw: rawText });
      }

      // Split into hole / board
      const holeDetected  = detected.slice(0, 2);
      const boardDetected = detected.slice(2);

      const holeCards  = holeDetected.filter(d => d.card).map(d => d.card!);
      const boardCards = boardDetected.filter(d => d.card).map(d => d.card!);

      const res = recommend(holeCards, boardCards);

      setResult({
        holeCards, boardCards,
        winProb:        res?.winProb ?? null,
        recommendation: res?.rec ?? null,
        raw: detected,
      });
      setScanCount(n => n + 1);
      setLastScan(new Date().toLocaleTimeString());
    } catch (err: any) {
      setError(err?.message ?? 'Ошибка сканирования');
    } finally {
      setAnalyzing(false);
    }
  }, [regions, analyzing]);

  // ── Auto-scan loop ────────────────────────────────────────────────────────
  const startScanning = useCallback(() => {
    setPhase('scanning');
    scanFrame();
    intervalRef.current = setInterval(scanFrame, 5000);
  }, [scanFrame]);

  useEffect(() => {
    if (phase !== 'scanning') {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
  }, [phase]);

  useEffect(() => () => { stopAll(); workerRef.current?.terminate(); }, []);

  // ─── Suit display ──────────────────────────────────────────────────────────
  const suitSym  = (s: string) => ({ h:'♥', d:'♦', c:'♣', s:'♠' }[s] ?? s);
  const suitCls  = (s: string) => s === 'h' || s === 'd' ? 'text-red-400' : 'text-zinc-200';
  const rankLabel = (r: number) => ({ 14:'A',13:'K',12:'Q',11:'J',10:'T' }[r] ?? String(r));

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-[100dvh] bg-[#0d1117] text-zinc-100 font-mono overflow-hidden">

      {/* ── IDLE ── */}
      {phase === 'idle' && (
        <div className="flex flex-col items-center justify-center flex-1 gap-6 p-6 text-center">
          <div className="text-5xl">📷</div>
          <div>
            <h2 className="text-xl font-bold mb-2">Камера — авто-распознавание</h2>
            <p className="text-zinc-500 text-sm leading-relaxed max-w-xs">
              Направь телефон на экран ПК с TON Poker.<br/>
              OCR читает карты локально — без интернета и без квот.
            </p>
          </div>
          <ol className="text-left text-sm text-zinc-400 space-y-1 max-w-xs">
            <li><span className="text-emerald-400 mr-2">1.</span>Нажми «Начать»</li>
            <li><span className="text-emerald-400 mr-2">2.</span>Направь камеру на экран ПК</li>
            <li><span className="text-emerald-400 mr-2">3.</span>Один раз нажми на каждую карту</li>
            <li><span className="text-emerald-400 mr-2">4.</span>Получай советы автоматически</li>
          </ol>
          <button
            onClick={startCamera}
            className="px-8 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold text-sm transition-colors"
          >
            Начать
          </button>
          {error && <p className="text-red-400 text-sm">{error}</p>}
        </div>
      )}

      {/* ── CAMERA FEED (calibrating / ready / scanning) ── */}
      {(phase === 'calibrating' || phase === 'ready' || phase === 'scanning' || phase === 'loading-ocr') && (
        <div className="relative flex-1 bg-black overflow-hidden">
          <video
            ref={videoRef}
            className={cn(
              'w-full h-full object-cover',
              phase === 'calibrating' ? 'cursor-crosshair' : ''
            )}
            playsInline muted autoPlay
            onClick={handleVideoTap}
          />
          <canvas ref={canvasRef} className="hidden" />

          {/* Calibration dots */}
          {phase === 'calibrating' && regions.map((r, i) => (
            <div
              key={i}
              className="absolute w-6 h-6 rounded-full border-2 border-white bg-emerald-500/70 -translate-x-3 -translate-y-3 pointer-events-none"
              style={{ left: `${r.cx * 100}%`, top: `${r.cy * 100}%` }}
            >
              <span className="absolute text-[8px] font-bold text-white left-7 top-0 whitespace-nowrap">
                {r.label}
              </span>
            </div>
          ))}

          {/* Calibration instruction */}
          {phase === 'calibrating' && (
            <div className="absolute bottom-0 left-0 right-0 bg-black/80 p-4 space-y-3">
              <p className="text-center text-sm font-bold text-emerald-400">
                {CALIBRATION_STEPS[calStep]?.hint}
              </p>
              <div className="flex gap-2 justify-center">
                {calStep >= 2 && (
                  <button
                    onClick={skipCard}
                    className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 rounded-lg text-sm text-zinc-300"
                  >
                    Пропустить
                  </button>
                )}
                <button
                  onClick={stopAll}
                  className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm text-zinc-500"
                >
                  Отмена
                </button>
              </div>
              <div className="flex justify-center gap-1">
                {CALIBRATION_STEPS.map((_, i) => (
                  <div key={i} className={cn(
                    'w-2 h-2 rounded-full',
                    i < calStep ? 'bg-emerald-500' : i === calStep ? 'bg-white' : 'bg-zinc-700'
                  )} />
                ))}
              </div>
            </div>
          )}

          {/* Loading OCR */}
          {phase === 'loading-ocr' && (
            <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-3">
              <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-zinc-300">Загрузка OCR движка...</p>
              <p className="text-xs text-zinc-500">Один раз, ~5 сек</p>
            </div>
          )}

          {/* Ready / Scanning overlay */}
          {(phase === 'ready' || phase === 'scanning') && (
            <div className="absolute top-3 left-3 right-3 flex items-center justify-between">
              <div className="flex items-center gap-2 bg-black/60 rounded-full px-3 py-1">
                {phase === 'scanning'
                  ? <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  : <span className="w-2 h-2 rounded-full bg-zinc-400" />
                }
                <span className="text-xs text-zinc-300">
                  {phase === 'scanning' ? `Скан #${scanCount}` : 'Готово'}
                </span>
                {analyzing && <span className="text-xs text-amber-400">OCR...</span>}
              </div>
              <button
                onClick={stopAll}
                className="bg-black/60 rounded-full px-3 py-1 text-xs text-zinc-400"
              >
                Стоп
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── BOTTOM PANEL ── */}
      {(phase === 'ready' || phase === 'scanning') && (
        <div className="bg-zinc-950 border-t border-zinc-800 overflow-y-auto max-h-[55vh]">

          {/* CONTROLS */}
          <div className="flex gap-2 p-3">
            {phase === 'ready' && (
              <button
                onClick={startScanning}
                className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-bold text-sm"
              >
                ▶ Начать авто-скан (каждые 5с)
              </button>
            )}
            {phase === 'scanning' && (
              <button
                onClick={scanFrame}
                disabled={analyzing}
                className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg font-bold text-sm"
              >
                {analyzing ? 'Анализирую...' : 'Скан сейчас'}
              </button>
            )}
            <button
              onClick={() => { setPhase('calibrating'); setRegions([]); setCalStep(0); }}
              className="px-3 py-2.5 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs text-zinc-400"
            >
              Калибровка
            </button>
          </div>

          {/* RECOMMENDATION */}
          {result?.recommendation && (
            <div className={cn('mx-3 mb-3 rounded-xl p-4 text-center', result.recommendation.color)}>
              <div className="text-3xl font-black tracking-widest">{result.recommendation.action}</div>
              <div className="text-white/80 text-xs mt-0.5">{result.recommendation.text}</div>
            </div>
          )}

          {/* DETECTED CARDS */}
          {result && (
            <div className="px-3 pb-3 space-y-2">
              {/* Hole cards */}
              <div>
                <p className="text-zinc-500 text-xs uppercase tracking-widest mb-1.5">Твои карты</p>
                <div className="flex gap-2">
                  {result.holeCards.length > 0
                    ? result.holeCards.map((card, i) => (
                        <div key={i} className="w-10 h-14 bg-zinc-100 rounded flex flex-col items-center justify-center border border-zinc-300 shadow">
                          <span className={cn('text-sm font-black leading-none', suitCls(card.suit))}>
                            {rankLabel(card.rank)}
                          </span>
                          <span className={cn('text-sm leading-none', suitCls(card.suit))}>
                            {suitSym(card.suit)}
                          </span>
                        </div>
                      ))
                    : <p className="text-zinc-600 text-sm">Не распознано</p>
                  }
                </div>
              </div>

              {/* Board cards */}
              {result.boardCards.length > 0 && (
                <div>
                  <p className="text-zinc-500 text-xs uppercase tracking-widest mb-1.5">Борд</p>
                  <div className="flex gap-1.5 flex-wrap">
                    {result.boardCards.map((card, i) => (
                      <div key={i} className="w-9 h-12 bg-zinc-100 rounded flex flex-col items-center justify-center border border-zinc-300 shadow">
                        <span className={cn('text-xs font-black leading-none', suitCls(card.suit))}>
                          {rankLabel(card.rank)}
                        </span>
                        <span className={cn('text-xs leading-none', suitCls(card.suit))}>
                          {suitSym(card.suit)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* OCR debug */}
              <details className="text-zinc-600">
                <summary className="text-xs cursor-pointer hover:text-zinc-400">OCR debug</summary>
                <div className="mt-1 space-y-0.5">
                  {result.raw.map((d, i) => (
                    <p key={i} className="text-xs">
                      {CALIBRATION_STEPS[i]?.label}: raw="{d.raw}" → {d.rank}{suitSym(d.suit)}
                      {d.card ? ' ✓' : ' ✗'}
                    </p>
                  ))}
                </div>
              </details>

              {lastScan && (
                <p className="text-zinc-700 text-xs">Последний скан: {lastScan}</p>
              )}
            </div>
          )}

          {error && (
            <div className="mx-3 mb-3 bg-red-950/50 border border-red-800 text-red-400 rounded-lg p-2 text-xs">
              {error}
            </div>
          )}
        </div>
      )}

      {/* Starting camera */}
      {phase === 'starting-camera' && (
        <div className="flex-1 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}
    </div>
  );
}
