import React, { useState, useRef, useCallback, useEffect } from 'react';
import { createWorker, type Worker } from 'tesseract.js';
import { cn } from '@/lib/utils';
import {
  runMonteCarloSim, evaluateHand, HandRank, parseCard,
  type Card,
} from '@/lib/poker';

// ─── Types ────────────────────────────────────────────────────────────────────

type Phase =
  | 'idle'
  | 'requesting'
  | 'calibrating'
  | 'loading-ocr'
  | 'ready'
  | 'scanning';

interface CardRegion {
  label: string;
  cx: number; // 0-1 relative to video
  cy: number;
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
  ts: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CALIBRATION_STEPS: { label: string; hint: string }[] = [
  { label: 'Hole 1',  hint: 'Кликни на центр ПЕРВОЙ своей карты' },
  { label: 'Hole 2',  hint: 'Кликни на центр ВТОРОЙ своей карты' },
  { label: 'Board 1', hint: 'Флоп — 1-я карта на столе (или пропусти)' },
  { label: 'Board 2', hint: 'Флоп — 2-я карта (или пропусти)' },
  { label: 'Board 3', hint: 'Флоп — 3-я карта (или пропусти)' },
  { label: 'Board 4', hint: 'Тёрн (или пропусти)' },
  { label: 'Board 5', hint: 'Ривер (или пропусти)' },
];

const RANK_MAP: Record<string, string> = {
  a:'A', A:'A', k:'K', K:'K', q:'Q', Q:'Q',
  j:'J', J:'J', t:'T', T:'T', '1':'T', '10':'T', '0':'T',
  '2':'2','3':'3','4':'4','5':'5','6':'6','7':'7','8':'8','9':'9',
};

// ─── Image helpers ────────────────────────────────────────────────────────────

function extractCardRegion(
  src: HTMLCanvasElement,
  cx: number, cy: number,
  cardW: number, cardH: number,
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
  // Binarise for OCR
  const id = ctx.getImageData(0, 0, out.width, out.height);
  const d  = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const avg = (d[i] + d[i+1] + d[i+2]) / 3;
    const v   = avg > 140 ? 255 : 0;
    d[i] = d[i+1] = d[i+2] = v;
  }
  ctx.putImageData(id, 0, 0);
  return out;
}

function detectSuit(card: HTMLCanvasElement): { suit: 'h'|'d'|'c'|'s'; confidence: number } {
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
  if (count === 0) return { suit: 'h', confidence: 0 };

  const rAvg = rSum / count, gAvg = gSum / count, bAvg = bSum / count;
  const isRed  = rAvg > 140 && gAvg < 100;
  const isDark = rAvg < 120 && gAvg < 120 && bAvg < 120;

  if (isRed) {
    const upper = ctx.getImageData(sx, sy, sw, Math.round(sh * 0.5));
    let upperRed = 0;
    for (let i = 0; i < upper.data.length; i += 4) {
      if (upper.data[i] > 140 && upper.data[i+1] < 100) upperRed++;
    }
    const upperDensity = upperRed / (sw * Math.round(sh * 0.5) / 4);
    return { suit: upperDensity > 0.1 ? 'h' : 'd', confidence: 0.7 };
  }
  if (isDark) {
    const topData = ctx.getImageData(sx, sy, sw, Math.round(sh * 0.45)).data;
    const botData = ctx.getImageData(sx, sy + Math.round(sh * 0.55), sw, Math.round(sh * 0.45)).data;
    let topDark = 0, botDark = 0;
    for (let i = 0; i < topData.length; i += 4) { if (topData[i] < 100) topDark++; }
    for (let i = 0; i < botData.length; i += 4) { if (botData[i] < 100) botDark++; }
    return { suit: botDark > topDark ? 'c' : 's', confidence: 0.6 };
  }
  return { suit: 'h', confidence: 0.2 };
}

function parseRank(raw: string): string | null {
  const cleaned = raw.replace(/[^AaKkQqJjTt0-9]/g, '').trim();
  if (!cleaned) return null;
  if (cleaned === '10' || cleaned === '1O' || cleaned === 'IO') return 'T';
  return RANK_MAP[cleaned[0]] ?? null;
}

// ─── Recommendation ───────────────────────────────────────────────────────────

function recommend(
  holeCards: Card[],
  boardCards: Card[],
  players = 4,
  potSize: number | null,
  betToCall: number | null,
): { winProb: number; rec: { action: string; color: string; text: string } } | null {
  if (holeCards.length < 2) return null;
  const sim = runMonteCarloSim(holeCards, boardCards, players, 3000);
  const w   = sim.winProb;

  let action: string, color: string, text: string;

  const pot  = potSize  ?? 0;
  const call = betToCall ?? 0;
  const potOdds = (pot > 0 && call > 0) ? call / (pot + call) : null;
  const ev   = evaluateHand(holeCards, boardCards);
  const isMonster = ev && ev.handRank >= HandRank.FULL_HOUSE;

  if (isMonster) {
    action = 'ALL-IN'; color = 'bg-amber-500';
    text = `${ev.handName} — максимизируй пот`;
  } else if (call === 0) {
    if (w > 0.6) { action = 'RAISE'; color = 'bg-emerald-600'; text = `Win ${(w*100).toFixed(0)}% — поднимай`; }
    else          { action = 'CHECK'; color = 'bg-zinc-600';    text = `Win ${(w*100).toFixed(0)}% — чек`; }
  } else if (potOdds !== null) {
    if (w > potOdds + 0.15)     { action = 'RAISE'; color = 'bg-emerald-600'; text = `Win ${(w*100).toFixed(0)}% vs odds ${(potOdds*100).toFixed(0)}% — raise`; }
    else if (w > potOdds + 0.02) { action = 'CALL';  color = 'bg-blue-600';   text = `Win ${(w*100).toFixed(0)}% vs odds ${(potOdds*100).toFixed(0)}% — call`; }
    else                          { action = 'FOLD';  color = 'bg-red-700';    text = `Win ${(w*100).toFixed(0)}% < odds ${(potOdds*100).toFixed(0)}% — fold`; }
  } else {
    // No bet/pot info — use raw win prob
    if (boardCards.length === 0) {
      if (w > 0.68)      { action = 'RAISE'; color = 'bg-emerald-600'; text = `Сильная рука преф (${(w*100).toFixed(0)}%)`; }
      else if (w > 0.50) { action = 'CALL';  color = 'bg-blue-600';   text = `Выше среднего (${(w*100).toFixed(0)}%)`; }
      else               { action = 'FOLD';  color = 'bg-red-700';    text = `Слабая рука (${(w*100).toFixed(0)}%)`; }
    } else {
      if (w > 0.65)      { action = 'RAISE'; color = 'bg-emerald-600'; text = `Win ${(w*100).toFixed(0)}% — поднимай`; }
      else if (w > 0.40) { action = 'CALL';  color = 'bg-blue-600';   text = `Win ${(w*100).toFixed(0)}% — коллируй`; }
      else               { action = 'FOLD';  color = 'bg-red-700';    text = `Win ${(w*100).toFixed(0)}% — фолд`; }
    }
  }
  return { winProb: w, rec: { action, color, text } };
}

// ─── Component ────────────────────────────────────────────────────────────────

const suitSym  = (s: string) => ({ h:'♥', d:'♦', c:'♣', s:'♠' }[s] ?? s);
const suitCls  = (s: string) => s === 'h' || s === 'd' ? 'text-red-400' : 'text-zinc-200';
const rankLabel = (r: number) => ({ 14:'A',13:'K',12:'Q',11:'J',10:'T' }[r] ?? String(r));

export function ScreenScan() {
  const [phase, setPhase]         = useState<Phase>('idle');
  const [regions, setRegions]     = useState<CardRegion[]>([]);
  const [calStep, setCalStep]     = useState(0);
  const [result, setResult]       = useState<ScanResult | null>(null);
  const [error, setError]         = useState<string | null>(null);
  const [scanCount, setScanCount] = useState(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [intervalSecs, setIntervalSecs] = useState(5);
  const [players, setPlayers]     = useState(4);
  const [potSize, setPotSize]     = useState<number | null>(null);
  const [betToCall, setBetToCall] = useState<number | null>(null);

  const videoRef    = useRef<HTMLVideoElement>(null);
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const workerRef   = useRef<Worker | null>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // ── Start screen capture ──────────────────────────────────────────────────
  const startCapture = useCallback(async () => {
    setError(null);
    setPhase('requesting');
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 5, max: 10 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();

      stream.getVideoTracks()[0].addEventListener('ended', () => stopAll());

      setPhase('calibrating');
      setCalStep(0);
      setRegions([]);
    } catch (err: any) {
      if (err?.name === 'NotAllowedError') {
        setError('Доступ к экрану отклонён. Разреши захват экрана и попробуй снова.');
      } else {
        setError(err?.message ?? 'Не удалось запустить захват экрана');
      }
      setPhase('idle');
    }
  }, []);

  // ── Stop everything ───────────────────────────────────────────────────────
  const stopAll = useCallback(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setPhase('idle');
    setRegions([]);
    setCalStep(0);
    setResult(null);
    setError(null);
  }, []);

  // ── Calibration tap ───────────────────────────────────────────────────────
  const handleVideoTap = useCallback((e: React.MouseEvent<HTMLVideoElement>) => {
    if (phase !== 'calibrating') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = (e.clientX - rect.left)  / rect.width;
    const cy = (e.clientY - rect.top)   / rect.height;
    const step = CALIBRATION_STEPS[calStep];

    const newRegions = [...regions, { label: step.label, cx, cy }];
    setRegions(newRegions);

    const next = calStep + 1;
    if (next >= CALIBRATION_STEPS.length) {
      loadOcr(newRegions);
    } else {
      setCalStep(next);
    }
  }, [phase, calStep, regions]);

  const skipCard = useCallback(() => {
    if (calStep < 2) return;
    const next = calStep + 1;
    if (next >= CALIBRATION_STEPS.length) {
      loadOcr(regions);
    } else {
      setCalStep(next);
    }
  }, [calStep, regions]);

  // ── Load Tesseract ────────────────────────────────────────────────────────
  const loadOcr = useCallback(async (finalRegions: CardRegion[]) => {
    setPhase('loading-ocr');
    try {
      if (!workerRef.current) {
        const worker = await createWorker('eng', 1, { logger: () => {} });
        await worker.setParameters({
          tessedit_char_whitelist: 'AaKkQqJjTt23456789',
          tessedit_pageseg_mode: '10' as any,
        });
        workerRef.current = worker;
      }
      setRegions(finalRegions);
      setPhase('ready');
    } catch {
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
      // Draw current frame to offscreen canvas
      canvas.width  = video.videoWidth  || 1280;
      canvas.height = video.videoHeight || 720;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(video, 0, 0);

      // Card size estimate (~9% of frame height)
      const cardH = Math.round(canvas.height * 0.10);
      const cardW = Math.round(cardH * 0.69);

      const detected: DetectedCard[] = [];
      for (const region of regions) {
        const cardCanvas = extractCardRegion(canvas, region.cx, region.cy, cardW, cardH);
        const rankCanvas = extractRankArea(cardCanvas);
        const { data }   = await worker.recognize(rankCanvas);
        const rawText    = data.text.trim();
        const rank       = parseRank(rawText);
        const { suit }   = detectSuit(cardCanvas);
        const card       = rank ? (() => { try { return parseCard(`${rank}${suit}`); } catch { return null; } })() : null;
        detected.push({ rank: rank ?? '?', suit, card, raw: rawText });
      }

      const holeCards  = detected.slice(0, 2).filter(d => d.card).map(d => d.card!);
      const boardCards = detected.slice(2).filter(d => d.card).map(d => d.card!);

      const res = recommend(holeCards, boardCards, players, potSize, betToCall);

      setResult({
        holeCards, boardCards,
        winProb:        res?.winProb ?? null,
        recommendation: res?.rec ?? null,
        raw: detected,
        ts: new Date().toLocaleTimeString(),
      });
      setScanCount(n => n + 1);
    } catch (err: any) {
      setError(err?.message ?? 'Ошибка сканирования');
    } finally {
      setAnalyzing(false);
    }
  }, [analyzing, regions, players, potSize, betToCall]);

  // ── Auto-scan loop ────────────────────────────────────────────────────────
  const startScanning = useCallback(() => {
    setPhase('scanning');
    scanFrame();
    intervalRef.current = setInterval(scanFrame, intervalSecs * 1000);
  }, [scanFrame, intervalSecs]);

  const stopScanning = useCallback(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    setPhase('ready');
  }, []);

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
        <div className="flex flex-col items-center justify-center flex-1 gap-6 p-6 text-center max-w-lg mx-auto">
          <div className="text-5xl">🖥️</div>
          <div>
            <h2 className="text-2xl font-bold mb-2">Авто-скан экрана</h2>
            <p className="text-zinc-500 text-sm leading-relaxed">
              Захватывает твой экран прямо в браузере, читает карты через OCR и
              выдаёт совет FOLD / CALL / RAISE — без интернета, без ИИ, без API-ключей.
            </p>
          </div>

          <div className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-4 text-left space-y-2">
            <p className="text-zinc-400 text-xs font-bold uppercase tracking-widest mb-3">Как работает</p>
            {[
              'Открой TON Poker в Telegram Desktop',
              'Нажми «Начать» — браузер попросит поделиться экраном',
              'Выбери окно Telegram',
              'Кликни один раз на каждую карту для калибровки',
              'Получай советы автоматически каждые N секунд',
            ].map((s, i) => (
              <div key={i} className="flex gap-2 text-sm text-zinc-400">
                <span className="text-emerald-400 font-bold shrink-0">{i+1}.</span>
                <span>{s}</span>
              </div>
            ))}
          </div>

          <button
            onClick={startCapture}
            className="px-10 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold text-sm transition-colors shadow-[0_0_20px_rgba(5,150,105,0.3)]"
          >
            Начать захват экрана
          </button>
          {error && <p className="text-red-400 text-sm">{error}</p>}
        </div>
      )}

      {/* ── REQUESTING ── */}
      {phase === 'requesting' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <div className="w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-zinc-400 text-sm">Ожидание разрешения доступа к экрану...</p>
        </div>
      )}

      {/* ── SCREEN PREVIEW (calibrating / ready / scanning) ── */}
      {(phase === 'calibrating' || phase === 'ready' || phase === 'scanning' || phase === 'loading-ocr') && (
        <div className="flex flex-col lg:flex-row flex-1 gap-0">

          {/* LEFT: screen video preview */}
          <div className="relative flex-1 bg-black overflow-hidden min-h-[40vh]">
            <video
              ref={videoRef}
              className={cn(
                'w-full h-full object-contain',
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
                className="absolute w-6 h-6 rounded-full border-2 border-white bg-emerald-500/80 -translate-x-3 -translate-y-3 pointer-events-none z-10"
                style={{ left: `${r.cx * 100}%`, top: `${r.cy * 100}%` }}
              >
                <span className="absolute text-[8px] font-bold text-white left-7 top-0.5 whitespace-nowrap bg-black/60 px-1 rounded">
                  {r.label}
                </span>
              </div>
            ))}

            {/* Scanning region dots */}
            {(phase === 'ready' || phase === 'scanning') && regions.map((r, i) => (
              <div
                key={i}
                className={cn(
                  'absolute w-4 h-4 rounded-full border border-white -translate-x-2 -translate-y-2 pointer-events-none z-10',
                  i < 2 ? 'bg-emerald-500/60' : 'bg-blue-500/60'
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
                {/* Progress dots */}
                <div className="flex justify-center gap-1.5">
                  {CALIBRATION_STEPS.map((_, i) => (
                    <div key={i} className={cn(
                      'w-2 h-2 rounded-full transition-colors',
                      i < calStep ? 'bg-emerald-500' : i === calStep ? 'bg-white' : 'bg-zinc-700'
                    )} />
                  ))}
                </div>
              </div>
            )}

            {/* Loading OCR */}
            {phase === 'loading-ocr' && (
              <div className="absolute inset-0 bg-black/75 flex flex-col items-center justify-center gap-3 z-20">
                <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                <p className="text-sm text-zinc-300">Загрузка OCR движка...</p>
                <p className="text-xs text-zinc-500">Один раз, ~5 сек</p>
              </div>
            )}

            {/* Status bar overlay */}
            {(phase === 'ready' || phase === 'scanning') && (
              <div className="absolute top-2 left-2 right-2 flex items-center justify-between z-20">
                <div className="flex items-center gap-2 bg-black/70 rounded-full px-3 py-1 backdrop-blur-sm">
                  {phase === 'scanning'
                    ? <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    : <span className="w-2 h-2 rounded-full bg-zinc-500" />
                  }
                  <span className="text-xs text-zinc-300">
                    {phase === 'scanning' ? `Скан #${scanCount}` : 'Готово к скану'}
                  </span>
                  {analyzing && <span className="text-xs text-amber-400 animate-pulse">OCR...</span>}
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

          {/* RIGHT: controls + results */}
          {(phase === 'ready' || phase === 'scanning') && (
            <div className="w-full lg:w-80 bg-zinc-950 border-t lg:border-t-0 lg:border-l border-zinc-800 flex flex-col overflow-y-auto">

              {/* RECOMMENDATION */}
              {result?.recommendation ? (
                <div className={cn(
                  'p-6 text-center transition-all duration-300',
                  result.recommendation.color
                )}>
                  <div className="text-5xl font-black tracking-widest text-white drop-shadow-lg">
                    {result.recommendation.action}
                  </div>
                  <div className="text-white/80 text-sm mt-1">{result.recommendation.text}</div>
                  {result.winProb !== null && (
                    <div className="mt-2 text-white/60 text-xs">
                      Вероятность победы: {(result.winProb * 100).toFixed(0)}%
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-6 text-center bg-zinc-900 border-b border-zinc-800">
                  <div className="text-zinc-500 text-sm">
                    {phase === 'scanning' ? 'Анализирую...' : 'Нажми «Запустить»'}
                  </div>
                </div>
              )}

              <div className="p-3 space-y-3 flex-1">

                {/* SCAN CONTROLS */}
                <div className="flex gap-2">
                  {phase === 'ready' ? (
                    <button
                      onClick={startScanning}
                      className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg font-bold text-sm transition-colors"
                    >
                      ▶ Запустить (каждые {intervalSecs}с)
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={scanFrame}
                        disabled={analyzing}
                        className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded-lg font-bold text-xs transition-colors"
                      >
                        {analyzing ? 'OCR...' : 'Скан сейчас'}
                      </button>
                      <button
                        onClick={stopScanning}
                        className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-xs text-zinc-400"
                      >
                        Пауза
                      </button>
                    </>
                  )}
                </div>

                {/* INTERVAL */}
                <div className="flex items-center gap-2">
                  <span className="text-zinc-500 text-xs">Каждые:</span>
                  {[3, 5, 10].map(s => (
                    <button
                      key={s}
                      onClick={() => setIntervalSecs(s)}
                      className={cn(
                        'px-2.5 py-1 rounded text-xs border transition-colors',
                        intervalSecs === s
                          ? 'bg-emerald-700 border-emerald-600 text-white'
                          : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:border-zinc-500'
                      )}
                    >
                      {s}с
                    </button>
                  ))}
                </div>

                {/* MANUAL POT/BET INPUTS */}
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-2">
                  <p className="text-zinc-500 text-xs uppercase tracking-widest">Размеры ставок</p>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-zinc-600 text-xs block mb-1">Пот ($)</label>
                      <input
                        type="number"
                        min={0}
                        placeholder="—"
                        value={potSize ?? ''}
                        onChange={e => setPotSize(e.target.value ? Number(e.target.value) : null)}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:border-emerald-600"
                      />
                    </div>
                    <div>
                      <label className="text-zinc-600 text-xs block mb-1">Коллировать ($)</label>
                      <input
                        type="number"
                        min={0}
                        placeholder="—"
                        value={betToCall ?? ''}
                        onChange={e => setBetToCall(e.target.value ? Number(e.target.value) : null)}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:border-emerald-600"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-zinc-600 text-xs">Игроков:</label>
                    <input
                      type="range" min={2} max={9} value={players}
                      onChange={e => setPlayers(Number(e.target.value))}
                      className="flex-1 accent-emerald-500"
                    />
                    <span className="text-zinc-300 text-xs w-4">{players}</span>
                  </div>
                </div>

                {/* DETECTED CARDS */}
                {result && (
                  <div className="space-y-2">
                    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
                      <p className="text-zinc-500 text-xs uppercase tracking-widest mb-2">Твои карты</p>
                      {result.holeCards.length > 0 ? (
                        <div className="flex gap-2">
                          {result.holeCards.map((card, i) => (
                            <div key={i} className="w-10 h-14 bg-zinc-100 rounded flex flex-col items-center justify-center border border-zinc-300 shadow">
                              <span className={cn('text-sm font-black leading-none', suitCls(card.suit))}>{rankLabel(card.rank)}</span>
                              <span className={cn('text-sm leading-none', suitCls(card.suit))}>{suitSym(card.suit)}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-zinc-600 text-xs">Карты не распознаны</p>
                      )}
                    </div>

                    {result.boardCards.length > 0 && (
                      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
                        <p className="text-zinc-500 text-xs uppercase tracking-widest mb-2">Борд</p>
                        <div className="flex gap-1.5 flex-wrap">
                          {result.boardCards.map((card, i) => (
                            <div key={i} className="w-9 h-12 bg-zinc-100 rounded flex flex-col items-center justify-center border border-zinc-300 shadow">
                              <span className={cn('text-xs font-black leading-none', suitCls(card.suit))}>{rankLabel(card.rank)}</span>
                              <span className={cn('text-xs leading-none', suitCls(card.suit))}>{suitSym(card.suit)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* OCR debug */}
                    <details className="text-zinc-700">
                      <summary className="text-xs cursor-pointer hover:text-zinc-400 select-none">
                        OCR debug
                      </summary>
                      <div className="mt-1 space-y-0.5 pl-2">
                        {result.raw.map((d, i) => (
                          <p key={i} className="text-xs">
                            {CALIBRATION_STEPS[i]?.label ?? `Card ${i}`}: "{d.raw}" → {d.rank}{suitSym(d.suit)} {d.card ? '✓' : '✗'}
                          </p>
                        ))}
                      </div>
                    </details>

                    <p className="text-zinc-700 text-xs">Скан {result.ts}</p>
                  </div>
                )}

                {error && (
                  <div className="bg-red-950/50 border border-red-800 text-red-400 rounded-lg p-2 text-xs">
                    {error}
                  </div>
                )}

                {/* RECALIBRATE */}
                <button
                  onClick={() => {
                    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
                    setPhase('calibrating');
                    setRegions([]);
                    setCalStep(0);
                    setResult(null);
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
