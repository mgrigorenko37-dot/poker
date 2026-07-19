/**
 * ScreenScanLocal — pixel-based card detection, zero AI API calls.
 *
 * Flow:
 *  1. Start screen share → calibrate hole card positions (2 clicks)
 *  2. Optional: calibrate first board card position (1 click → 5 zones auto-estimated)
 *  3. Every 200 ms: frame-diff check → if changed, run detectCard() locally
 *  4. POST /api/vision/scan-cards with detected card strings → GTO analysis + Telegram
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { parseCard, type Card } from '@/lib/poker';
import type { Position } from '@/lib/poker-gto';
import { TelegramSetup } from '@/components/TelegramSetup';
import { CardPicker } from '@/components/CardPicker';
import {
  buildRankTemplates,
  detectCard,
  buildCalibration,
  saveCalibration,
  loadCalibration,
  clearCalibration,
  type Calibration,
  type CardZone,
  type RankTemplates,
} from '@/lib/card-detector';

// ── Display helpers ──────────────────────────────────────────────────────────
const suitSym   = (s: string) => ({ h: '♥', d: '♦', c: '♣', s: '♠' }[s] ?? s);
const suitCls   = (s: string) => s === 'h' || s === 'd' ? 'text-red-400' : 'text-zinc-200';
const rankLabel = (r: number) => ({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T' }[r] ?? String(r));

// ── Frame diff ────────────────────────────────────────────────────────────────
function frameDiff(prev: Uint8ClampedArray, curr: Uint8ClampedArray): number {
  const step = 16 * 4;
  const len  = Math.min(prev.length, curr.length);
  let diff = 0, total = 0;
  for (let i = 0; i < len; i += step) {
    if (Math.abs(prev[i] - curr[i]) + Math.abs(prev[i+1] - curr[i+1]) + Math.abs(prev[i+2] - curr[i+2]) > 30) diff++;
    total++;
  }
  return total > 0 ? diff / total : 0;
}

// ── Types ─────────────────────────────────────────────────────────────────────
type Phase = 'idle' | 'requesting' | 'calibrating' | 'scanning';
type CalibStep = 'hole1' | 'hole2' | 'board1' | 'done';

interface ScanResult {
  holeCards: string[];
  boardCards: string[];
  action: string;
  displayText: string;
  color: string;
  details: string[];
  equity: number;
  potOdds: number | null;
  mdf: number | null;
  handName: string;
  draws: { totalOuts: number; discountedOuts: number; description: string; equityRiverClean: number; antiOutsNote?: string } | null;
  bluffRead: { label: string; reasons: string[] } | null;
  potSize: number;
  betToCall: number;
  players: number;
  position: string;
  usedRangeVsRange: boolean;
  villainRangePct: number;
  ts: number;
}

// ── Component ─────────────────────────────────────────────────────────────────
export function ScreenScanLocal() {
  const [phase, setPhase]           = useState<Phase>('idle');
  const [calibStep, setCalibStep]   = useState<CalibStep>('hole1');
  const [result, setResult]         = useState<ScanResult | null>(null);
  const [holeCards, setHoleCards]   = useState<Card[]>([]);
  const [boardCards, setBoardCards] = useState<Card[]>([]);
  const [error, setError]           = useState<string | null>(null);
  const [analyzing, setAnalyzing]   = useState(false);
  const [scanCount, setScanCount]   = useState(0);
  const [lastScan, setLastScan]     = useState<string | null>(null);
  const [debugCards, setDebugCards] = useState<string[]>([]);

  // Game params
  const [position, setPosition]     = useState<Position>('BTN');
  const [players, setPlayers]       = useState(4);
  const [potSize, setPotSize]       = useState<number | null>(null);
  const [betToCall, setBetToCall]   = useState<number | null>(null);

  // Calibration clicks (in VIDEO pixel space, not DOM space)
  const calibClicks = useRef<{ x: number; y: number }[]>([]);
  const calibRef    = useRef<Calibration | null>(null);
  const templatesRef = useRef<RankTemplates | null>(null);

  const videoRef       = useRef<HTMLVideoElement>(null);
  const canvasRef      = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const overlayRef     = useRef<HTMLCanvasElement>(null);
  const streamRef      = useRef<MediaStream | null>(null);
  const loopRef        = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchCanvasRef = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const watchPxRef     = useRef<Uint8ClampedArray | null>(null);
  const lastScanTimeRef = useRef<number>(0);
  const busyRef        = useRef(false);
  const hasCardsRef    = useRef(false);

  const overrides = useRef<Map<string, string>>(new Map());

  // ── Stop ───────────────────────────────────────────────────────────────────
  const stopAll = useCallback(() => {
    if (loopRef.current) { clearInterval(loopRef.current); loopRef.current = null; }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    watchPxRef.current = null;
    busyRef.current = false;
    hasCardsRef.current = false;
    lastScanTimeRef.current = 0;
    overrides.current.clear();
    setPhase('idle');
    setAnalyzing(false);
    setCalibStep('hole1');
    calibClicks.current = [];
    fetch('/api/vision/reset', { method: 'POST' }).catch(() => {});
  }, []);

  // ── Scan tick: detect cards locally → send to server for GTO ───────────────
  const scanTick = useCallback(async () => {
    if (busyRef.current) return;
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    const calib  = calibRef.current;
    const templates = templatesRef.current;
    if (!video || video.readyState < 2 || !calib || !templates) return;

    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;

    canvas.width = vw; canvas.height = vh;
    canvas.getContext('2d')!.drawImage(video, 0, 0);

    // Detect hole cards
    const detectedHole: string[] = [];
    for (const zone of calib.holeZones) {
      const card = detectCard(canvas, zone, templates);
      if (card) detectedHole.push(card);
    }

    if (detectedHole.length !== 2) {
      // No hole cards visible — might be between hands
      return;
    }

    // Apply manual overrides
    const finalHole = detectedHole.map((c, i) => {
      const ov = overrides.current.get(`hole_${i}`);
      return ov ?? c;
    });

    // Detect board cards if calibrated
    const detectedBoard: string[] = [];
    if (calib.boardZones) {
      for (const zone of calib.boardZones) {
        const card = detectCard(canvas, zone, templates);
        if (card) detectedBoard.push(card);
      }
    }

    setDebugCards([...finalHole, ...detectedBoard]);
    lastScanTimeRef.current = Date.now();
    busyRef.current = true;
    setAnalyzing(true);

    try {
      const res = await fetch('/api/vision/scan-cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          holeCards: finalHole,
          boardCards: detectedBoard,
          potSize:   potSize   ?? undefined,
          betToCall: betToCall ?? undefined,
          players,
          position,
        }),
      });

      if (!res.ok) { lastScanTimeRef.current = Date.now() + 3_000; return; }
      let data: any;
      try { data = await res.json(); } catch { return; }
      if (!data.ok) return;

      const newResult = data as ScanResult;
      setResult(newResult);
      setScanCount(c => c + 1);
      setLastScan(new Date().toLocaleTimeString());
      hasCardsRef.current = true;

      const hParsed = (newResult.holeCards as string[])
        .map(s => { try { return parseCard(s); } catch { return null; } })
        .filter(Boolean) as Card[];
      const bParsed = (newResult.boardCards as string[])
        .map(s => { try { return parseCard(s); } catch { return null; } })
        .filter(Boolean) as Card[];
      setHoleCards(hParsed);
      setBoardCards(bParsed);
    } catch (err: any) {
      console.warn('scan-cards error:', err?.message);
    } finally {
      busyRef.current = false;
      setAnalyzing(false);
    }
  }, [position, players, potSize, betToCall]);

  const scanTickRef = useRef(scanTick);
  useEffect(() => { scanTickRef.current = scanTick; }, [scanTick]);

  // ── Start screen share ─────────────────────────────────────────────────────
  const startCapture = useCallback(async () => {
    setError(null);
    setPhase('requesting');
    fetch('/api/vision/reset', { method: 'POST' }).catch(() => {});
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 10, max: 15 }, displaySurface: 'window' } as MediaTrackConstraints,
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      stream.getVideoTracks()[0].addEventListener('ended', stopAll);
      await video.play().catch(() => {});

      // Lazy build templates
      if (!templatesRef.current) {
        templatesRef.current = buildRankTemplates();
      }

      // Check if we have saved calibration for this resolution
      await new Promise(r => setTimeout(r, 400)); // wait for video to stabilize
      const vw = video.videoWidth, vh = video.videoHeight;
      const saved = loadCalibration(vw, vh);
      if (saved) {
        calibRef.current = saved;
        setPhase('scanning');
        startScanLoop();
      } else {
        setPhase('calibrating');
        setCalibStep('hole1');
        calibClicks.current = [];
      }
    } catch (err: any) {
      setError(
        err?.name === 'NotAllowedError'
          ? 'Доступ отклонён — разреши захват экрана'
          : err?.message ?? 'Не удалось захватить экран',
      );
      setPhase('idle');
    }
  }, [stopAll]);

  // ── Start scan loop ────────────────────────────────────────────────────────
  const startScanLoop = useCallback(() => {
    const wc = watchCanvasRef.current;
    wc.width = 64; wc.height = 36;
    const video = videoRef.current!;

    loopRef.current = setInterval(() => {
      if (!video || video.readyState < 2) return;
      wc.getContext('2d')!.drawImage(video, 0, 0, 64, 36);
      const px = wc.getContext('2d')!.getImageData(0, 0, 64, 36).data as Uint8ClampedArray;
      const diff = watchPxRef.current ? frameDiff(watchPxRef.current, px) : 1;
      watchPxRef.current = px.slice();

      const threshold = hasCardsRef.current ? 0.04 : 0.015;
      if (diff < threshold) return;
      const now = Date.now();
      if (busyRef.current) return;
      if (now - lastScanTimeRef.current < 600) return;
      scanTickRef.current();
    }, 200);

    setTimeout(() => scanTickRef.current(), 600);
  }, []);

  // ── Draw calibration overlay ────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'calibrating') return;
    const overlay = overlayRef.current;
    const video   = videoRef.current;
    if (!overlay || !video) return;

    const draw = () => {
      const ow = overlay.width, oh = overlay.height;
      const ctx = overlay.getContext('2d')!;
      ctx.clearRect(0, 0, ow, oh);
      // Draw video frame as background
      if (video.readyState >= 2) {
        ctx.globalAlpha = 1;
        ctx.drawImage(video, 0, 0, ow, oh);
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, ow, oh);
        ctx.globalAlpha = 1;
      }

      // Draw confirmed clicks
      const clicks = calibClicks.current;
      clicks.forEach((pt, i) => {
        // Map from video space to overlay space
        const scaleX = ow / (video.videoWidth || ow);
        const scaleY = oh / (video.videoHeight || oh);
        const dx = pt.x * scaleX, dy = pt.y * scaleY;
        ctx.beginPath();
        ctx.arc(dx, dy, 14, 0, Math.PI * 2);
        ctx.strokeStyle = i < 2 ? '#10b981' : '#f59e0b';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.fillStyle = i < 2 ? '#10b981' : '#f59e0b';
        ctx.font = 'bold 13px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(i < 2 ? `К${i + 1}` : 'B1', dx, dy);
      });
    };
    const id = setInterval(draw, 80);
    return () => clearInterval(id);
  }, [phase]);

  // ── Handle calibration click on overlay ───────────────────────────────────
  const handleCalibClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const overlay = overlayRef.current;
    const video   = videoRef.current;
    if (!overlay || !video) return;

    const rect = overlay.getBoundingClientRect();
    const domX = e.clientX - rect.left;
    const domY = e.clientY - rect.top;
    // Convert to video pixel space
    const scaleX = (video.videoWidth  || overlay.width)  / overlay.width;
    const scaleY = (video.videoHeight || overlay.height) / overlay.height;
    const vidX = domX * scaleX;
    const vidY = domY * scaleY;

    calibClicks.current = [...calibClicks.current, { x: vidX, y: vidY }];
    const clicks = calibClicks.current;

    if (calibStep === 'hole1') {
      setCalibStep('hole2');
    } else if (calibStep === 'hole2') {
      setCalibStep('board1');
    } else if (calibStep === 'board1') {
      // Build calibration with board
      const calib = buildCalibration(clicks[0], clicks[1], clicks[2], video.videoWidth, video.videoHeight);
      calibRef.current = calib;
      saveCalibration(calib);
      setCalibStep('done');
      setPhase('scanning');
      startScanLoop();
    }
  }, [calibStep, startScanLoop]);

  // ── Skip board calibration ────────────────────────────────────────────────
  const skipBoardCalib = useCallback(() => {
    const clicks = calibClicks.current;
    const video  = videoRef.current;
    if (clicks.length < 2 || !video) return;
    const calib = buildCalibration(clicks[0], clicks[1], null, video.videoWidth, video.videoHeight);
    calibRef.current = calib;
    saveCalibration(calib);
    setCalibStep('done');
    setPhase('scanning');
    startScanLoop();
  }, [startScanLoop]);

  // ── Manual hole card override ─────────────────────────────────────────────
  const handleHoleOverride = useCallback((idx: number, card: Card) => {
    const str = `${'23456789TJQKA'[card.rank - 2]}${'hdcs'[['h','d','c','s'].indexOf(card.suit)]}`;
    overrides.current.set(`hole_${idx}`, str);
    setHoleCards(prev => prev.map((c, i) => i === idx ? card : c));
  }, []);

  const advice = result;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      <video ref={videoRef} style={{ display: 'none' }} playsInline muted />

      {/* IDLE */}
      {phase === 'idle' && (
        <div className="flex flex-col items-center justify-center flex-1 gap-6 p-6 text-center">
          <div className="w-16 h-16 bg-blue-900/40 border border-blue-700/50 rounded-2xl flex items-center justify-center text-3xl">
            🔬
          </div>
          <div>
            <h2 className="text-zinc-100 text-lg font-bold mb-2">Локальный детектор</h2>
            <p className="text-zinc-500 text-sm leading-relaxed max-w-xs">
              Карты читаются по пикселям — без AI, без API.
              Быстро, бесплатно, работает оффлайн.
              Нужна одноразовая калибровка позиций карт.
            </p>
          </div>
          <button
            onClick={startCapture}
            className="w-full max-w-xs py-3 bg-blue-600 hover:bg-blue-500 rounded-xl text-white font-bold text-base transition-colors"
          >
            ▶ Начать
          </button>
          {error && <p className="text-red-400 text-sm px-4">{error}</p>}
          <TelegramSetup />
        </div>
      )}

      {/* REQUESTING */}
      {phase === 'requesting' && (
        <div className="flex flex-col items-center justify-center flex-1 gap-4 p-6 text-center">
          <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-zinc-400 text-sm">Выбери окно с покером…</p>
        </div>
      )}

      {/* CALIBRATING */}
      {phase === 'calibrating' && (
        <div className="flex flex-col h-full">
          {/* Instruction bar */}
          <div className="px-3 py-2 border-b border-zinc-800 bg-zinc-900">
            <p className="text-zinc-300 text-sm font-medium">
              {calibStep === 'hole1' && '👆 Кликни на центр ЛЕВОЙ карты в руке'}
              {calibStep === 'hole2' && '👆 Кликни на центр ПРАВОЙ карты в руке'}
              {calibStep === 'board1' && '👆 Кликни на ПЕРВУЮ карту флопа — или пропусти'}
            </p>
            {calibStep === 'board1' && (
              <div className="flex gap-2 mt-1.5">
                <p className="text-zinc-600 text-xs flex-1">
                  Без борда карты флопа нужно вводить вручную
                </p>
                <button
                  onClick={skipBoardCalib}
                  className="text-xs text-zinc-500 hover:text-zinc-300 underline shrink-0"
                >
                  Пропустить →
                </button>
              </div>
            )}
          </div>

          {/* Canvas overlay */}
          <div className="flex-1 relative overflow-hidden bg-black">
            <canvas
              ref={(el) => {
                (overlayRef as any).current = el;
                if (el) {
                  el.width  = el.offsetWidth  || 640;
                  el.height = el.offsetHeight || 360;
                }
              }}
              onClick={handleCalibClick}
              className="w-full h-full cursor-crosshair"
              style={{ touchAction: 'none' }}
            />
          </div>

          <div className="px-3 py-2 border-t border-zinc-800 flex justify-between items-center">
            <span className="text-zinc-600 text-xs">
              {calibClicks.current.length}/{ calibStep === 'board1' ? 2 : calibStep === 'hole2' ? 1 : 0} кликов
            </span>
            <button
              onClick={stopAll}
              className="text-zinc-600 hover:text-zinc-400 text-xs"
            >
              Отмена
            </button>
          </div>
        </div>
      )}

      {/* SCANNING */}
      {phase === 'scanning' && (
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
            <div className="flex items-center gap-2">
              <span className={cn(
                'w-2 h-2 rounded-full',
                analyzing ? 'bg-amber-400 animate-pulse' : 'bg-blue-400 animate-pulse'
              )} />
              <span className="text-zinc-400 text-xs">
                {analyzing ? 'Анализирую…' : `Локальный детектор • ${scanCount} раздач`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { clearCalibration(); stopAll(); }}
                className="text-zinc-700 hover:text-zinc-500 text-[10px] border border-zinc-800 rounded px-1.5 py-0.5"
              >
                Перекалибровать
              </button>
              <button onClick={stopAll} className="text-zinc-600 hover:text-zinc-400 text-xs">
                ✕
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3">

            {/* Debug: what was detected */}
            {debugCards.length > 0 && (
              <div className="bg-zinc-900 border border-zinc-800 rounded px-3 py-1.5 flex gap-1 items-center flex-wrap">
                <span className="text-zinc-600 text-[10px] uppercase tracking-widest mr-1">Пиксели:</span>
                {debugCards.map((c, i) => (
                  <span key={i} className="text-zinc-400 text-xs font-mono">{c}</span>
                ))}
              </div>
            )}

            {/* Action badge */}
            {advice && (
              <div className={cn(
                'rounded-xl p-4 text-center',
                advice.color === 'green'  ? 'bg-emerald-900/50 border border-emerald-700/60' :
                advice.color === 'red'    ? 'bg-red-900/50 border border-red-700/60' :
                advice.color === 'yellow' ? 'bg-amber-900/50 border border-amber-700/60' :
                'bg-zinc-900 border border-zinc-800'
              )}>
                <div className={cn(
                  'text-2xl font-black tracking-wide',
                  advice.color === 'green'  ? 'text-emerald-300' :
                  advice.color === 'red'    ? 'text-red-300' :
                  advice.color === 'yellow' ? 'text-amber-300' :
                  'text-zinc-100'
                )}>
                  {advice.displayText}
                </div>
                {advice.handName && (
                  <div className="text-zinc-400 text-xs mt-1">{advice.handName}</div>
                )}
              </div>
            )}

            {/* Win probability */}
            {advice && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-zinc-500 text-xs uppercase tracking-widest">Win Prob</span>
                  <span className={cn('text-xl font-black',
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
            {advice?.details?.length ? (
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-1.5">
                {advice.details.map((d, i) => (
                  <div key={i} className="flex gap-2 text-sm text-zinc-300">
                    <span className="text-blue-500 shrink-0">▸</span>
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

            {/* Draws */}
            {advice?.draws && advice.draws.totalOuts > 0 && (
              <div className="bg-teal-950/50 border border-teal-800/50 rounded-lg p-3">
                <p className="text-teal-400 text-xs font-bold mb-1">ДРОУ</p>
                <p className="text-teal-300 text-sm">{advice.draws.description}</p>
                <p className="text-teal-600 text-xs mt-1">
                  {advice.draws.discountedOuts} outs → ~{advice.draws.equityRiverClean}%
                </p>
              </div>
            )}

            {/* Bluff read */}
            {advice?.bluffRead && (
              <div className={cn('rounded-lg p-3 border',
                advice.bluffRead.label === 'Вероятно блеф' ? 'bg-orange-950/50 border-orange-800/50' :
                'bg-zinc-900 border-zinc-800'
              )}>
                <p className="text-zinc-400 text-xs font-bold uppercase tracking-wider mb-1">Read виллана</p>
                <p className="text-sm font-bold text-zinc-100">{advice.bluffRead.label}</p>
                {advice.bluffRead.reasons.map((r, i) => (
                  <p key={i} className="text-zinc-500 text-xs mt-0.5">▸ {r}</p>
                ))}
              </div>
            )}

            {/* Detected cards */}
            {(holeCards.length > 0 || boardCards.length > 0) && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-2">
                {holeCards.length > 0 && (
                  <div>
                    <p className="text-zinc-600 text-xs uppercase tracking-widest mb-1.5">
                      Мои карты <span className="text-zinc-700 normal-case">(тапни чтобы исправить)</span>
                    </p>
                    <div className="flex gap-2">
                      {holeCards.map((c, i) => (
                        <CardPicker
                          key={i}
                          selectedCard={c}
                          disabledCards={[...holeCards, ...boardCards].filter(x => x !== c)}
                          onSelect={(card) => card && handleHoleOverride(i, card)}
                          trigger={
                            <button className="w-10 h-14 bg-zinc-100 rounded flex flex-col items-center justify-center border border-zinc-300 shadow hover:ring-2 hover:ring-blue-500 transition-shadow">
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

            {!advice && !analyzing && (
              <div className="text-center py-8">
                <p className="text-zinc-600 text-sm">Жду карты на экране…</p>
                <p className="text-zinc-700 text-xs mt-1">
                  {calibRef.current?.boardZones
                    ? 'Наблюдаю за рукой и бордом'
                    : 'Борд не откалиброван — введи вручную ниже'}
                </p>
              </div>
            )}

            {/* Game params */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-2">
              <p className="text-zinc-500 text-xs uppercase tracking-widest">Параметры игры</p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-zinc-600 text-xs block mb-1">Пот</label>
                  <input
                    type="number" min={0} placeholder="—"
                    value={potSize ?? ''}
                    onChange={e => setPotSize(e.target.value ? Number(e.target.value) : null)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-blue-600"
                  />
                </div>
                <div>
                  <label className="text-zinc-600 text-xs block mb-1">Колл</label>
                  <input
                    type="number" min={0} placeholder="—"
                    value={betToCall ?? ''}
                    onChange={e => setBetToCall(e.target.value ? Number(e.target.value) : null)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-blue-600"
                  />
                </div>
              </div>
              <div>
                <label className="text-zinc-600 text-xs block mb-1">Позиция</label>
                <select
                  value={position}
                  onChange={e => setPosition(e.target.value as Position)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-blue-600"
                >
                  {(['UTG','MP','HJ','CO','BTN','SB','BB'] as Position[]).map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-zinc-600 text-xs shrink-0">Игроков: {players}</label>
                <input
                  type="range" min={2} max={9} value={players}
                  onChange={e => setPlayers(Number(e.target.value))}
                  className="flex-1 accent-blue-500"
                />
              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}
