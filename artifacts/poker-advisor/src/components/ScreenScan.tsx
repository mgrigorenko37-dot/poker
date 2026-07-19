/**
 * ScreenScan — fully automatic poker screen analysis via Gemini Vision.
 *
 * Flow:
 *  1. User clicks "Start" → browser screen-share picker
 *  2. Every 2.5 s: capture frame → auto-detect green table → JPEG crop
 *  3. POST /api/vision/scan → Gemini Flash reads cards + amounts
 *  4. GTO analysis on server → Telegram push + WebSocket broadcast
 *  5. Display advice in UI
 *
 * No manual calibration. No Tesseract. Works with any poker client.
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { parseCard, type Card } from '@/lib/poker';
import type { Position } from '@/lib/poker-gto';
import { TelegramSetup } from '@/components/TelegramSetup';
import { CardPicker } from '@/components/CardPicker';

// ─── Types ────────────────────────────────────────────────────────────────────
type Phase = 'idle' | 'requesting' | 'scanning';

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
  handCategory: string;
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

// ─── Display helpers ──────────────────────────────────────────────────────────
const suitSym   = (s: string) => ({ h:'♥', d:'♦', c:'♣', s:'♠' }[s] ?? s);
const suitCls   = (s: string) => s === 'h' || s === 'd' ? 'text-red-400' : 'text-zinc-200';
const rankLabel = (r: number) => ({ 14:'A', 13:'K', 12:'Q', 11:'J', 10:'T' }[r] ?? String(r));

// ─── Frame diff (skip unchanged frames) ──────────────────────────────────────
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

// ─── Auto table detection ─────────────────────────────────────────────────────
// Finds the bounding box of the poker table by locating green felt pixels.
// Downsamples to 320px wide for speed (~1 ms on a 1080p frame).
function findTableBounds(
  canvas: HTMLCanvasElement,
): { x: number; y: number; w: number; h: number } | null {
  const W = canvas.width, H = canvas.height;
  const scale = Math.min(1, 320 / W);
  const sw = Math.round(W * scale), sh = Math.round(H * scale);

  const tmp = document.createElement('canvas');
  tmp.width = sw; tmp.height = sh;
  tmp.getContext('2d')!.drawImage(canvas, 0, 0, sw, sh);
  const { data } = tmp.getContext('2d')!.getImageData(0, 0, sw, sh);

  let minX = sw, maxX = 0, minY = sh, maxY = 0, count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2];
    // Green felt: G dominant, moderate luminance, not too bright (avoid HUD/UI)
    const isGreen = g > 55 && g > r * 1.2 && g > b * 1.05 && r < 200 && b < 200 && g < 240;
    if (isGreen) {
      const px = (i >> 2) % sw;
      const py = (i >> 2) / sw | 0;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      count++;
    }
  }

  // Need at least 5% green pixels to call it a table
  if (count < sw * sh * 0.05) return null;

  const pad = Math.round(30 / scale);
  return {
    x: Math.max(0, Math.round(minX / scale) - pad),
    y: Math.max(0, Math.round(minY / scale) - pad),
    w: Math.min(W, Math.round((maxX - minX) / scale) + pad * 2),
    h: Math.min(H, Math.round((maxY - minY) / scale) + pad * 2),
  };
}

// Crop a region from canvas and return a base64 JPEG string (no data: prefix).
function cropToJpeg(src: HTMLCanvasElement, x: number, y: number, w: number, h: number, quality = 0.88): string {
  const dst = document.createElement('canvas');
  // Cap at 960px wide to keep payload small (Gemini doesn't need more)
  const scale = Math.min(1, 960 / w);
  dst.width  = Math.round(w * scale);
  dst.height = Math.round(h * scale);
  const ctx = dst.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, x, y, w, h, 0, 0, dst.width, dst.height);
  return dst.toDataURL('image/jpeg', quality).split(',')[1];
}

// ─── Component ────────────────────────────────────────────────────────────────
export function ScreenScan() {
  const [phase, setPhase]             = useState<Phase>('idle');
  const [result, setResult]           = useState<ScanResult | null>(null);
  const [holeCards, setHoleCards]     = useState<Card[]>([]);
  const [boardCards, setBoardCards]   = useState<Card[]>([]);
  // Strings as returned by server — used for CardPicker overrides
  const [holeStrs, setHoleStrs]       = useState<string[]>([]);
  const [boardStrs, setBoardStrs]     = useState<string[]>([]);
  const [error, setError]             = useState<string | null>(null);
  const [analyzing, setAnalyzing]     = useState(false);
  const [lastScan, setLastScan]       = useState<string | null>(null);
  const [scanCount, setScanCount]     = useState(0);
  const [tableFound, setTableFound]   = useState<boolean | null>(null);

  // Game params — user can override, or let Gemini read them from screen
  const [position, setPosition]       = useState<Position>('BTN');
  const [players, setPlayers]         = useState(4);
  const [potSize, setPotSize]         = useState<number | null>(null);
  const [betToCall, setBetToCall]     = useState<number | null>(null);
  // Track which values came from OCR (show camera icon)
  const [autoPot, setAutoPot]         = useState(false);
  const [autoBet, setAutoBet]         = useState(false);
  const [autoPlayers, setAutoPlayers] = useState(false);

  const videoRef    = useRef<HTMLVideoElement>(null);
  const canvasRef   = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const streamRef   = useRef<MediaStream | null>(null);
  const loopRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevPx      = useRef<Uint8ClampedArray | null>(null);
  const busyRef     = useRef(false);

  // Manual card overrides (user tap-to-correct)
  const overrides   = useRef<Map<string, string>>(new Map()); // slot → card string

  // ── Stop ──────────────────────────────────────────────────────────────────
  const stopAll = useCallback(() => {
    if (loopRef.current) { clearInterval(loopRef.current); loopRef.current = null; }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    prevPx.current = null;
    busyRef.current = false;
    overrides.current.clear();
    setPhase('idle');
    setAnalyzing(false);
    setTableFound(null);
  }, []);

  // ── Scan tick ─────────────────────────────────────────────────────────────
  const scanTick = useCallback(async () => {
    if (busyRef.current) return;
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || video.readyState < 2) return;

    // Draw current frame
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    canvas.width = vw; canvas.height = vh;
    canvas.getContext('2d')!.drawImage(video, 0, 0);

    // Skip if frame barely changed
    const ctx  = canvas.getContext('2d')!;
    const px   = ctx.getImageData(0, 0, Math.min(vw, 640), Math.min(vh, 360)).data;
    if (prevPx.current && frameDiff(prevPx.current, px) < 0.015) return;
    prevPx.current = px.slice();

    // Find green table
    const bounds = findTableBounds(canvas);
    setTableFound(bounds !== null);

    let jpeg: string;
    if (bounds) {
      jpeg = cropToJpeg(canvas, bounds.x, bounds.y, bounds.w, bounds.h);
    } else {
      // No green detected — send scaled-down full frame
      jpeg = cropToJpeg(canvas, 0, 0, vw, vh, 0.80);
    }

    busyRef.current = true;
    setAnalyzing(true);

    try {
      const res = await fetch('/api/vision/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: jpeg,
          position,
          players,
          potSizeOverride:    potSize  ?? undefined,
          betToCallOverride:  betToCall ?? undefined,
        }),
      });
      const data = await res.json();

      if (!data.ok) {
        // Gemini couldn't see cards this frame — keep last result
        return;
      }

      const newResult = data as ScanResult;
      setResult(newResult);
      setScanCount(c => c + 1);
      setLastScan(new Date().toLocaleTimeString());

      // Parse cards for display
      const hParsed = (newResult.holeCards as string[]).map(s => { try { return parseCard(s); } catch { return null; } }).filter(Boolean) as Card[];
      const bParsed = (newResult.boardCards as string[]).map(s => { try { return parseCard(s); } catch { return null; } }).filter(Boolean) as Card[];

      // Apply manual overrides
      const finalHole = hParsed.map((c, i) => {
        const ov = overrides.current.get(`hole_${i}`);
        return ov ? (parseCard(ov) ?? c) : c;
      });

      setHoleCards(finalHole);
      setBoardCards(bParsed);
      setHoleStrs(newResult.holeCards);
      setBoardStrs(newResult.boardCards);

      // Sync auto-detected values (only if user hasn't manually set them)
      if (newResult.potSize > 0 && potSize === null) {
        setPotSize(newResult.potSize); setAutoPot(true);
      }
      if (newResult.betToCall > 0 && betToCall === null) {
        setBetToCall(newResult.betToCall); setAutoBet(true);
      }
      if (newResult.players > 0) {
        setPlayers(newResult.players); setAutoPlayers(true);
      }
    } catch (err: any) {
      // Network or server error — ignore this tick
      console.warn('vision/scan error:', err?.message);
    } finally {
      busyRef.current = false;
      setAnalyzing(false);
    }
  }, [position, players, potSize, betToCall]);

  // Keep scanTick ref fresh without recreating the interval
  const scanTickRef = useRef(scanTick);
  useEffect(() => { scanTickRef.current = scanTick; }, [scanTick]);

  // ── Start capture ─────────────────────────────────────────────────────────
  const startCapture = useCallback(async () => {
    setError(null);
    setPhase('requesting');
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 5, max: 10 }, displaySurface: 'window' } as MediaTrackConstraints,
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      stream.getVideoTracks()[0].addEventListener('ended', stopAll);
      await video.play().catch(() => {});
      setPhase('scanning');

      // Start scan loop — 2.5 s interval
      loopRef.current = setInterval(() => { scanTickRef.current(); }, 2500);
      // First tick immediately after a short wait for video to populate
      setTimeout(() => { scanTickRef.current(); }, 800);
    } catch (err: any) {
      setError(
        err?.name === 'NotAllowedError'
          ? 'Доступ отклонён — разреши захват экрана и попробуй снова'
          : err?.message ?? 'Не удалось захватить экран',
      );
      setPhase('idle');
    }
  }, [stopAll]);

  // ── Manual card correction ────────────────────────────────────────────────
  const handleHoleOverride = useCallback((idx: number, card: Card) => {
    const str = `${'23456789TJQKA'[card.rank - 2]}${'hdcs'[['h','d','c','s'].indexOf(card.suit)]}`;
    overrides.current.set(`hole_${idx}`, str);
    setHoleCards(prev => prev.map((c, i) => i === idx ? card : c));
  }, []);

  const advice = result;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      {/* Hidden video element for screen capture */}
      <video ref={videoRef} style={{ display: 'none' }} playsInline muted />

      {/* ── IDLE ── */}
      {phase === 'idle' && (
        <div className="flex flex-col items-center justify-center flex-1 gap-6 p-6 text-center">
          <div className="w-16 h-16 bg-emerald-900/40 border border-emerald-700/50 rounded-2xl flex items-center justify-center text-3xl">
            🎯
          </div>
          <div>
            <h2 className="text-zinc-100 text-lg font-bold mb-2">Авто-сканирование</h2>
            <p className="text-zinc-500 text-sm leading-relaxed max-w-xs">
              Запусти захват экрана — Gemini сам найдёт карты,
              посчитает эквити и пришлёт совет в Telegram.
              Никакой ручной калибровки.
            </p>
          </div>
          <button
            onClick={startCapture}
            className="w-full max-w-xs py-3 bg-emerald-600 hover:bg-emerald-500 rounded-xl text-white font-bold text-base transition-colors"
          >
            ▶ Начать сканирование
          </button>
          {error && (
            <p className="text-red-400 text-sm px-4">{error}</p>
          )}
          <TelegramSetup />
        </div>
      )}

      {/* ── REQUESTING ── */}
      {phase === 'requesting' && (
        <div className="flex flex-col items-center justify-center flex-1 gap-4 p-6 text-center">
          <div className="w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-zinc-400 text-sm">Выбери окно с покером в диалоге браузера…</p>
        </div>
      )}

      {/* ── SCANNING ── */}
      {phase === 'scanning' && (
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
            <div className="flex items-center gap-2">
              <span className={cn(
                'w-2 h-2 rounded-full',
                analyzing ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400 animate-pulse'
              )} />
              <span className="text-zinc-400 text-xs">
                {analyzing ? 'Анализирую…' : tableFound === false ? '⚠ Стол не найден' : `Сканирую • ${scanCount} раздач`}
              </span>
            </div>
            <button onClick={stopAll} className="text-zinc-600 hover:text-zinc-400 text-xs transition-colors">
              ✕ Стоп
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3">

            {/* No table warning */}
            {tableFound === false && (
              <div className="bg-amber-950/40 border border-amber-800/50 rounded-lg p-3 text-sm text-amber-400">
                <p className="font-bold mb-1">⚠ Зелёный стол не обнаружен</p>
                <p className="text-amber-600 text-xs">Убедись что окно с покером видно на экране. Отправляю весь кадр — анализ продолжается.</p>
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
                {advice.usedRangeVsRange && (
                  <div className="text-[10px] text-zinc-600 italic mt-1.5">
                    Против диапазона виллана (~{advice.villainRangePct}% рук)
                  </div>
                )}
              </div>
            )}

            {/* Advice details */}
            {advice?.details?.length ? (
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

            {/* Bluff read */}
            {advice?.bluffRead && (
              <div className={cn('rounded-lg p-3 border',
                advice.bluffRead.label === 'Вероятно блеф'    ? 'bg-orange-950/50 border-orange-800/50' :
                advice.bluffRead.label === 'Похоже на вэлью'  ? 'bg-blue-950/50 border-blue-800/50' :
                'bg-zinc-900 border-zinc-800'
              )}>
                <p className="text-zinc-400 text-xs font-bold uppercase tracking-wider mb-1">Read виллана</p>
                <p className="text-sm font-bold text-zinc-100">{advice.bluffRead.label}</p>
                <div className="mt-1.5 space-y-1">
                  {advice.bluffRead.reasons.map((r, i) => (
                    <p key={i} className="text-zinc-500 text-xs">▸ {r}</p>
                  ))}
                </div>
                <p className="text-zinc-700 text-[10px] mt-1.5 italic">
                  Эвристика по сайзингу/борду — доверяй математике больше
                </p>
              </div>
            )}

            {/* Detected cards — tap to correct */}
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

            {/* No cards yet */}
            {!advice && !analyzing && (
              <div className="text-center py-8">
                <p className="text-zinc-600 text-sm">Жду карты на экране…</p>
                <p className="text-zinc-700 text-xs mt-1">Открой покерный стол и начни раздачу</p>
              </div>
            )}

            {/* Game params */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-2">
              <p className="text-zinc-500 text-xs uppercase tracking-widest">Параметры игры</p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-zinc-600 text-xs flex items-center gap-1 mb-1">
                    Пот
                    {autoPot && <span className="text-amber-400" title="Читается с экрана">📷</span>}
                  </label>
                  <input
                    type="number" min={0} placeholder="—"
                    value={potSize ?? ''}
                    onChange={e => { setAutoPot(false); setPotSize(e.target.value ? Number(e.target.value) : null); }}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-emerald-600"
                  />
                </div>
                <div>
                  <label className="text-zinc-600 text-xs flex items-center gap-1 mb-1">
                    Колл
                    {autoBet && <span className="text-amber-400" title="Читается с экрана">📷</span>}
                  </label>
                  <input
                    type="number" min={0} placeholder="—"
                    value={betToCall ?? ''}
                    onChange={e => { setAutoBet(false); setBetToCall(e.target.value ? Number(e.target.value) : null); }}
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
                <label className="text-zinc-600 text-xs shrink-0 flex items-center gap-1">
                  Игроков: {players}
                  {autoPlayers && <span className="text-purple-400" title="Определено с экрана">👥</span>}
                </label>
                <input
                  type="range" min={2} max={9} value={players}
                  onChange={e => { setAutoPlayers(false); setPlayers(Number(e.target.value)); }}
                  className="flex-1 accent-emerald-500"
                />
              </div>
            </div>

            {/* Last scan time */}
            {lastScan && (
              <div className="flex items-center justify-between text-zinc-700 text-xs">
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  LIVE → телефон
                </span>
                <span>{lastScan}</span>
              </div>
            )}

            {/* Telegram */}
            <TelegramSetup />
          </div>
        </div>
      )}
    </div>
  );
}
