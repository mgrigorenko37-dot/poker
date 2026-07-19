/**
 * ScreenScanLocal — pixel-based card detection, zero AI, zero calibration.
 *
 * Flow:
 *  1. Start screen share (same picker as AI mode)
 *  2. Every 200 ms: frame-diff check → if changed, run autoDetectCards() to find
 *     white rectangles on the green table, then detectCard() on each found zone
 *  3. POST /api/vision/scan-cards with detected strings → GTO analysis + Telegram
 *  4. No calibration step, no API key needed
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
  autoDetectCards,
  type CardZone,
  type RankTemplates,
} from '@/lib/card-detector';

// ── Re-use the same green-table finder from ScreenScan ────────────────────────
function findTableBounds(canvas: HTMLCanvasElement): { x: number; y: number; w: number; h: number } | null {
  const W = canvas.width, H = canvas.height;
  const scale = Math.min(1, 320 / W);
  const sw = Math.round(W * scale), sh = Math.round(H * scale);
  const tmp = document.createElement('canvas');
  tmp.width = sw; tmp.height = sh;
  tmp.getContext('2d')!.drawImage(canvas, 0, 0, sw, sh);
  const { data } = tmp.getContext('2d')!.getImageData(0, 0, sw, sh);
  let minX = sw, maxX = 0, minY = sh, maxY = 0, count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (g > 55 && g > r * 1.2 && g > b * 1.05 && r < 200 && b < 200 && g < 240) {
      const px = (i >> 2) % sw, py = (i >> 2) / sw | 0;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      count++;
    }
  }
  // Lowered from 5% → 2% — dark/blue tables have less green
  if (count < sw * sh * 0.02) return null;
  const pad = Math.round(30 / scale);
  return {
    x: Math.max(0, Math.round(minX / scale) - pad),
    y: Math.max(0, Math.round(minY / scale) - pad),
    w: Math.min(W, Math.round((maxX - minX) / scale) + pad * 2),
    h: Math.min(H, Math.round((maxY - minY) / scale) + pad * 2),
  };
}

// ── Frame diff ────────────────────────────────────────────────────────────────
function frameDiff(prev: Uint8ClampedArray, curr: Uint8ClampedArray): number {
  const step = 16 * 4, len = Math.min(prev.length, curr.length);
  let diff = 0, total = 0;
  for (let i = 0; i < len; i += step) {
    if (Math.abs(prev[i] - curr[i]) + Math.abs(prev[i+1] - curr[i+1]) + Math.abs(prev[i+2] - curr[i+2]) > 30) diff++;
    total++;
  }
  return total > 0 ? diff / total : 0;
}

// ── Display helpers ───────────────────────────────────────────────────────────
const suitSym   = (s: string) => ({ h: '♥', d: '♦', c: '♣', s: '♠' }[s] ?? s);
const suitCls   = (s: string) => s === 'h' || s === 'd' ? 'text-red-400' : 'text-zinc-200';
const rankLabel = (r: number) => ({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T' }[r] ?? String(r));

// ── Types ─────────────────────────────────────────────────────────────────────
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
  const [result, setResult]         = useState<ScanResult | null>(null);
  const [holeCards, setHoleCards]   = useState<Card[]>([]);
  const [boardCards, setBoardCards] = useState<Card[]>([]);
  const [error, setError]           = useState<string | null>(null);
  const [analyzing, setAnalyzing]   = useState(false);
  const [scanCount, setScanCount]   = useState(0);
  const [tableFound, setTableFound] = useState<boolean | null>(null);
  const [debugCards, setDebugCards] = useState<string[]>([]);
  // Detailed scan diagnostics shown to user so they can see what's failing
  const [scanStatus, setScanStatus] = useState<string | null>(null);

  const [position, setPosition]   = useState<Position>('BTN');
  const [players, setPlayers]     = useState(4);
  const [potSize, setPotSize]     = useState<number | null>(null);
  const [betToCall, setBetToCall] = useState<number | null>(null);
  const [autoPot, setAutoPot]     = useState(false);
  const [autoBet, setAutoBet]     = useState(false);

  const videoRef        = useRef<HTMLVideoElement>(null);
  const canvasRef       = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const streamRef       = useRef<MediaStream | null>(null);
  const loopRef         = useRef<ReturnType<typeof setInterval> | null>(null);
  const watchCanvasRef  = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const watchPxRef      = useRef<Uint8ClampedArray | null>(null);
  const lastScanTimeRef = useRef<number>(0);
  const busyRef         = useRef(false);
  const hasCardsRef     = useRef(false);
  const templatesRef    = useRef<RankTemplates | null>(null);
  const overrides       = useRef<Map<string, string>>(new Map());

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
    setTableFound(null);
    setScanStatus(null);
    fetch('/api/vision/reset', { method: 'POST' }).catch(() => {});
  }, []);

  // ── Scan tick ──────────────────────────────────────────────────────────────
  const scanTick = useCallback(async () => {
    if (busyRef.current) return;
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || video.readyState < 2) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;

    canvas.width = vw; canvas.height = vh;
    canvas.getContext('2d')!.drawImage(video, 0, 0);

    // Find green table
    const bounds = findTableBounds(canvas);
    setTableFound(bounds !== null);

    // Auto-detect card positions (no calibration)
    const templates = templatesRef.current!;
    const { holeZones, boardZones, debug } = autoDetectCards(canvas, bounds);

    if (!holeZones) {
      const tableStr = bounds ? `✅ Стол (${bounds.w}×${bounds.h}px)` : '❌ Стол не найден';
      const holeStr  = debug.holeRunsTotal === 0
        ? '❌ hole-зон: 0'
        : `⚠ hole-зон: ${debug.holeRunsTotal} (нужно 2)`;
      const boardStr = `board-зон: ${debug.boardRunsTotal}`;
      setScanStatus(`${tableStr} | ${holeStr} | ${boardStr}${debug.holeRunsTotal === 0 ? ' — убедись что идёт раздача' : ' — слишком много/мало зон'}`);
      return;
    }

    // Detect rank+suit for each found zone
    const rawHole: (string | null)[] = holeZones.map(z => detectCard(canvas, z, templates));

    // Apply manual overrides BEFORE null-check so user corrections always count
    const holeWithOverrides = rawHole.map((c, i) => overrides.current.get(`hole_${i}`) ?? c);

    // If any hole card still unreadable, show which slot failed and bail
    if (holeWithOverrides.some(c => c === null)) {
      const missing = holeWithOverrides.map((c, i) => c === null ? `карта ${i + 1}` : null).filter(Boolean).join(', ');
      setScanStatus(`OCR не читает: ${missing} — нажми на карту ниже для ручного ввода`);
      return;
    }

    const finalHole = holeWithOverrides as string[];

    const detectedBoard: string[] = boardZones
      .map(z => detectCard(canvas, z, templates))
      .filter((c): c is string => c !== null);

    setScanStatus(null);
    setDebugCards([...finalHole, ...detectedBoard]);
    lastScanTimeRef.current = Date.now();
    busyRef.current = true;
    setAnalyzing(true);

    try {
      const res = await fetch('/api/vision/scan-cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          holeCards:  finalHole,
          boardCards: detectedBoard,
          potSize:    potSize   ?? undefined,
          betToCall:  betToCall ?? undefined,
          players,
          position,
        }),
      });

      if (!res.ok) {
        let errMsg = `Ошибка сервера ${res.status}`;
        try { const j = await res.json(); errMsg = j?.error ?? errMsg; } catch { /* noop */ }
        setScanStatus(errMsg);
        lastScanTimeRef.current = Date.now() + 3_000;
        return;
      }
      let data: any;
      try { data = await res.json(); } catch { setScanStatus('Ошибка разбора ответа сервера'); return; }
      if (!data.ok) { setScanStatus(data.error ?? 'Сервер вернул ошибку'); return; }

      const newResult = data as ScanResult;
      setResult(newResult);
      setScanCount(c => c + 1);
      hasCardsRef.current = true;

      const hParsed = newResult.holeCards
        .map(s => { try { return parseCard(s); } catch { return null; } })
        .filter(Boolean) as Card[];
      const bParsed = newResult.boardCards
        .map(s => { try { return parseCard(s); } catch { return null; } })
        .filter(Boolean) as Card[];
      setHoleCards(hParsed);
      setBoardCards(bParsed);

      if (newResult.potSize > 0 && potSize === null)    { setPotSize(newResult.potSize);     setAutoPot(true); }
      if (newResult.betToCall > 0 && betToCall === null) { setBetToCall(newResult.betToCall); setAutoBet(true); }
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

      if (!templatesRef.current) templatesRef.current = buildRankTemplates();

      setPhase('scanning');

      // Fast watcher: 200 ms diff check
      const wc = watchCanvasRef.current;
      wc.width = 64; wc.height = 36;

      loopRef.current = setInterval(() => {
        if (!video || video.readyState < 2) return;
        wc.getContext('2d')!.drawImage(video, 0, 0, 64, 36);
        const px = wc.getContext('2d')!.getImageData(0, 0, 64, 36).data as Uint8ClampedArray;
        const diff = watchPxRef.current ? frameDiff(watchPxRef.current, px) : 1;
        watchPxRef.current = px.slice();
        const now = Date.now();
        if (busyRef.current || now - lastScanTimeRef.current < 700) return;
        // Always scan if: frame changed enough, OR it's been >4s since last scan (stable screen)
        const threshold = hasCardsRef.current ? 0.04 : 0.015;
        const forceByTimeout = now - lastScanTimeRef.current > 4_000;
        if (diff < threshold && !forceByTimeout) return;
        scanTickRef.current();
      }, 200);

      setTimeout(() => scanTickRef.current(), 600);
    } catch (err: any) {
      setError(
        err?.name === 'NotAllowedError'
          ? 'Доступ отклонён — разреши захват экрана'
          : err?.message ?? 'Не удалось захватить экран',
      );
      setPhase('idle');
    }
  }, [stopAll]);

  // ── Manual card override ───────────────────────────────────────────────────
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
              Карты читаются по пикселям прямо в браузере —
              без AI, без API, без калибровки.
              Нажми старт и выбери окно с покером.
            </p>
          </div>
          <button
            onClick={startCapture}
            className="w-full max-w-xs py-3 bg-blue-600 hover:bg-blue-500 rounded-xl text-white font-bold text-base transition-colors"
          >
            ▶ Начать сканирование
          </button>
          {error && <p className="text-red-400 text-sm px-4">{error}</p>}
          <TelegramSetup />
        </div>
      )}

      {/* REQUESTING */}
      {phase === 'requesting' && (
        <div className="flex flex-col items-center justify-center flex-1 gap-4 p-6 text-center">
          <div className="w-10 h-10 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-zinc-400 text-sm">Выбери окно с покером в диалоге браузера…</p>
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
                {analyzing
                  ? 'Анализирую…'
                  : tableFound === false
                    ? '⚠ Стол не найден'
                    : `Пиксели • ${scanCount} раздач`}
              </span>
            </div>
            <button onClick={stopAll} className="text-zinc-600 hover:text-zinc-400 text-xs">
              ✕ Стоп
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3">

            {/* No table warning */}
            {tableFound === false && (
              <div className="bg-amber-950/40 border border-amber-800/50 rounded-lg p-3 text-sm text-amber-400">
                <p className="font-bold mb-1">⚠ Зелёный стол не найден</p>
                <p className="text-amber-600 text-xs">Убедись что окно с покером видно на экране. Если стол не зелёный — это ок, детектор продолжает искать карты.</p>
              </div>
            )}

            {/* Scan status — shows WHY detection is failing */}
            {scanStatus && !analyzing && (
              <div className="bg-zinc-900 border border-yellow-800/40 rounded-lg px-3 py-2 flex items-start gap-2">
                <span className="text-yellow-500 shrink-0 mt-0.5">⚠</span>
                <span className="text-yellow-400 text-xs leading-relaxed">{scanStatus}</span>
              </div>
            )}

            {/* Debug bar — cards last seen by OCR */}
            {debugCards.length > 0 && (
              <div className="bg-zinc-900 border border-zinc-800 rounded px-3 py-1.5 flex gap-2 items-center flex-wrap">
                <span className="text-zinc-600 text-[10px] uppercase tracking-widest">OCR видит:</span>
                {debugCards.map((c, i) => (
                  <span key={i} className={cn('text-xs font-mono', i < 2 ? 'text-blue-300' : 'text-zinc-400')}>{c}</span>
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
                {advice.usedRangeVsRange && (
                  <div className="text-[10px] text-zinc-600 italic mt-1.5">
                    Против диапазона виллана (~{advice.villainRangePct}% рук)
                  </div>
                )}
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
                {advice.draws.antiOutsNote && (
                  <p className="text-teal-800 text-xs mt-1 italic">{advice.draws.antiOutsNote}</p>
                )}
              </div>
            )}

            {/* Bluff read */}
            {advice?.bluffRead && (
              <div className={cn('rounded-lg p-3 border',
                advice.bluffRead.label === 'Вероятно блеф' ? 'bg-orange-950/50 border-orange-800/50' :
                advice.bluffRead.label === 'Похоже на вэлью' ? 'bg-blue-950/50 border-blue-800/50' :
                'bg-zinc-900 border-zinc-800'
              )}>
                <p className="text-zinc-400 text-xs font-bold uppercase tracking-wider mb-1">Read виллана</p>
                <p className="text-sm font-bold text-zinc-100">{advice.bluffRead.label}</p>
                {advice.bluffRead.reasons.map((r, i) => (
                  <p key={i} className="text-zinc-500 text-xs mt-0.5">▸ {r}</p>
                ))}
              </div>
            )}

            {/* Detected cards (tap to correct) */}
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

            {/* Waiting state */}
            {!advice && !analyzing && (
              <div className="text-center py-8 space-y-1">
                <p className="text-zinc-600 text-sm">Жду карты на экране…</p>
                <p className="text-zinc-700 text-xs">Открой покерный стол и начни раздачу</p>
              </div>
            )}

            {/* Game params */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 space-y-2">
              <p className="text-zinc-500 text-xs uppercase tracking-widest">Параметры игры</p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-zinc-600 text-xs flex items-center gap-1 mb-1">
                    Пот {autoPot && <span className="text-amber-400" title="Авто">📷</span>}
                  </label>
                  <input
                    type="number" min={0} placeholder="—"
                    value={potSize ?? ''}
                    onChange={e => { setAutoPot(false); setPotSize(e.target.value ? Number(e.target.value) : null); }}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-blue-600"
                  />
                </div>
                <div>
                  <label className="text-zinc-600 text-xs flex items-center gap-1 mb-1">
                    Колл {autoBet && <span className="text-amber-400" title="Авто">📷</span>}
                  </label>
                  <input
                    type="number" min={0} placeholder="—"
                    value={betToCall ?? ''}
                    onChange={e => { setAutoBet(false); setBetToCall(e.target.value ? Number(e.target.value) : null); }}
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
