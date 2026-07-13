import React, { useState, useRef, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────
interface DrawInfo {
  flushDraw: boolean;
  oesd: boolean;
  gutshot: boolean;
  totalOuts: number;
  discountedOuts: number;
  equityRiver: number;
  equityRiverClean: number;
  antiOutsNote: string | null;
  description: string;
}

interface LiveAnalysis {
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
  handName: string | null;
  draws: DrawInfo | null;
  bluffRead: { label: string; score: number; reasons: string[] } | null;
  potSize: number | null;
  betToCall: number | null;
  players: number;
  position: string;
  sizing: string | null;
  ts: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/api/ws`;
}

const suitSym  = (s: string) => ({ h: '♥', d: '♦', c: '♣', s: '♠' }[s] ?? s);
const suitCls  = (s: string) => s === 'h' || s === 'd' ? 'text-red-400' : 'text-zinc-800';
const rankLabel = (s: string) => {
  const rank = s.slice(0, -1);
  return rank === 'T' ? '10' : rank;
};

function CardDisplay({ notation, size = 'md' }: { notation: string; size?: 'sm' | 'md' | 'lg' }) {
  const rank = notation.slice(0, -1);
  const suit = notation.slice(-1);
  const rankStr = rank === 'T' ? '10' : rank;
  const sizes = {
    sm: 'w-10 h-14 text-sm',
    md: 'w-12 h-16 text-base',
    lg: 'w-16 h-22 text-xl',
  };
  return (
    <div className={cn(
      'bg-white rounded-lg flex flex-col items-center justify-center border border-zinc-300 shadow-md font-bold',
      sizes[size]
    )}>
      <span className={cn('font-black leading-none', suitCls(suit))}>{rankStr}</span>
      <span className={cn('leading-none', suitCls(suit))}>{suitSym(suit)}</span>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
export function LiveView() {
  const [analysis, setAnalysis] = useState<LiveAnalysis | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    try {
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) return;
        setConnected(true);
        setReconnecting(false);
      };

      ws.onmessage = (e) => {
        if (!mountedRef.current) return;
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'analysis' && msg.data) {
            setAnalysis(msg.data);
            setLastUpdate(new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
          }
        } catch {}
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setConnected(false);
        setReconnecting(true);
        retryRef.current = setTimeout(connect, 2500);
      };

      ws.onerror = () => ws.close();
    } catch {
      setReconnecting(true);
      retryRef.current = setTimeout(connect, 2500);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      wsRef.current?.close();
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, [connect]);

  const actionBg = analysis?.color ?? 'bg-zinc-800';

  return (
    <div className="min-h-screen bg-[#0d1117] text-zinc-100 font-mono flex flex-col">

      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-950">
        <span className="text-xs font-bold text-zinc-500 tracking-widest">POKER TERMINAL • LIVE</span>
        <div className="flex items-center gap-2">
          {connected
            ? <><span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" /><span className="text-xs text-emerald-400">Подключено</span></>
            : reconnecting
              ? <><span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" /><span className="text-xs text-amber-400">Переподключение...</span></>
              : <><span className="w-2 h-2 rounded-full bg-red-500" /><span className="text-xs text-red-400">Офлайн</span></>
          }
        </div>
      </div>

      {!analysis ? (
        /* Waiting state */
        <div className="flex-1 flex flex-col items-center justify-center gap-6 px-6 text-center">
          <div className="text-6xl opacity-30">♠</div>
          <div>
            <h2 className="text-xl font-bold text-zinc-300 mb-2">Ожидание анализа</h2>
            <p className="text-zinc-600 text-sm leading-relaxed">
              {connected
                ? 'Запусти 🖥️ Экран на ПК — результаты появятся здесь в реальном времени'
                : 'Подключение к серверу...'}
            </p>
          </div>
          {connected && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 text-left text-sm text-zinc-500 space-y-1 max-w-xs">
              <p className="text-zinc-400 font-bold mb-2">Как использовать:</p>
              <p>1. Открой этот сайт на ПК</p>
              <p>2. Перейди на вкладку 🖥️ Экран</p>
              <p>3. Запусти авто-скан</p>
              <p>4. Здесь появится анализ 📱</p>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex flex-col">

          {/* BIG ACTION DISPLAY */}
          <div className={cn('py-8 px-6 text-center transition-all duration-500', actionBg)}>
            <div className="text-6xl font-black tracking-widest text-white drop-shadow-lg mb-1">
              {analysis.displayText}
            </div>
            {analysis.sizing && (
              <div className="text-white/70 text-lg font-bold">{analysis.sizing}</div>
            )}
            <div className="text-white/80 text-sm mt-2">{analysis.handCategory}</div>
          </div>

          {/* WIN PROBABILITY BAR */}
          <div className="px-4 py-3 bg-zinc-900 border-b border-zinc-800">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-zinc-500 uppercase tracking-wider">Вероятность победы</span>
              <span className={cn(
                'text-xl font-black',
                analysis.equity > 0.6 ? 'text-emerald-400' :
                analysis.equity > 0.4 ? 'text-amber-400' : 'text-red-400'
              )}>
                {(analysis.equity * 100).toFixed(0)}%
              </span>
            </div>
            <div className="h-3 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full transition-all duration-700',
                  analysis.equity > 0.6 ? 'bg-emerald-500' :
                  analysis.equity > 0.4 ? 'bg-amber-500' : 'bg-red-500'
                )}
                style={{ width: `${analysis.equity * 100}%` }}
              />
            </div>
          </div>

          {/* CARDS */}
          <div className="px-4 py-3 border-b border-zinc-800">
            <div className="flex gap-6">
              <div>
                <p className="text-zinc-600 text-xs uppercase tracking-widest mb-2">Мои карты</p>
                {analysis.holeCards.length > 0 ? (
                  <div className="flex gap-2">
                    {analysis.holeCards.map((c, i) => <CardDisplay key={i} notation={c} size="md" />)}
                  </div>
                ) : (
                  <p className="text-zinc-700 text-sm">Не распознаны</p>
                )}
              </div>
              {analysis.boardCards.length > 0 && (
                <div>
                  <p className="text-zinc-600 text-xs uppercase tracking-widest mb-2">Борд</p>
                  <div className="flex gap-1.5 flex-wrap">
                    {analysis.boardCards.map((c, i) => <CardDisplay key={i} notation={c} size="sm" />)}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* DETAILS */}
          <div className="px-4 py-3 space-y-2 flex-1">
            {analysis.details.map((d, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-emerald-500 mt-0.5 shrink-0">▸</span>
                <span className="text-sm text-zinc-300">{d}</span>
              </div>
            ))}

            {/* POT ODDS / MDF */}
            {(analysis.potOdds !== null || analysis.mdf !== null) && (
              <div className="grid grid-cols-2 gap-2 mt-3">
                {analysis.potOdds !== null && (
                  <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-center">
                    <div className="text-lg font-black text-zinc-200">{(analysis.potOdds * 100).toFixed(0)}%</div>
                    <div className="text-zinc-600 text-xs">Пот-оддс</div>
                  </div>
                )}
                {analysis.mdf !== null && (
                  <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-center">
                    <div className="text-lg font-black text-zinc-200">{(analysis.mdf * 100).toFixed(0)}%</div>
                    <div className="text-zinc-600 text-xs">MDF защита</div>
                  </div>
                )}
              </div>
            )}

            {/* DRAW INFO */}
            {analysis.draws && analysis.draws.totalOuts > 0 && (
              <div className="bg-teal-950/50 border border-teal-800/50 rounded-lg p-3">
                <p className="text-teal-400 text-xs font-bold uppercase tracking-wider mb-1">Дроу</p>
                <p className="text-teal-300 text-sm">{analysis.draws.description}</p>
                <p className="text-teal-500 text-xs mt-1">
                  {analysis.draws.discountedOuts} чистых outs (из {analysis.draws.totalOuts}) → ~{analysis.draws.equityRiverClean}% equity
                </p>
                {analysis.draws.antiOutsNote && (
                  <p className="text-teal-700 text-xs mt-1 italic">{analysis.draws.antiOutsNote}</p>
                )}
              </div>
            )}

            {/* BLUFF READ */}
            {analysis.bluffRead && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
                <p className="text-zinc-500 text-xs font-bold uppercase tracking-wider mb-1">Read виллана</p>
                <p className="text-zinc-100 text-sm font-bold">{analysis.bluffRead.label}</p>
              </div>
            )}
          </div>

          {/* FOOTER */}
          <div className="px-4 py-2 border-t border-zinc-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-zinc-700 text-xs">LIVE</span>
            </div>
            {lastUpdate && <span className="text-zinc-700 text-xs">{lastUpdate}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
