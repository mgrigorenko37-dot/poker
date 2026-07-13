import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useScanCards } from '@workspace/api-client-react';
import { Card as CardType, parseCard } from '@/lib/poker';
import { cn } from '@/lib/utils';
import { evaluateHand, runMonteCarloSim, calculateOuts, HandRank } from '@/lib/poker';

type ScanStatus = 'idle' | 'requesting' | 'scanning' | 'stopped';

interface ScanResult {
  holeCards: CardType[];
  communityCards: CardType[];
  potSize: number | null;
  betToCall: number | null;
  players: number | null;
  confidence: number;
  winProb: number | null;
  recommendation: { action: string; color: string; text: string } | null;
}

export function AutoScan() {
  const [status, setStatus] = useState<ScanStatus>('idle');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanCount, setScanCount] = useState(0);
  const [lastScanTime, setLastScanTime] = useState<string | null>(null);
  const [intervalSecs, setIntervalSecs] = useState(3);

  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const isScanningRef = useRef(false);

  const scanMutation = useScanCards();

  const captureFrame = useCallback((): string | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) return null;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);

    // Get base64 without the data:image/jpeg;base64, prefix
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    return dataUrl.split(',')[1];
  }, []);

  const analyzeFrame = useCallback(async () => {
    if (isScanningRef.current) return;
    isScanningRef.current = true;

    try {
      const imageBase64 = captureFrame();
      if (!imageBase64) {
        isScanningRef.current = false;
        return;
      }

      const data = await scanMutation.mutateAsync({ data: { imageBase64 } });

      // Parse cards
      const holeCards: CardType[] = [];
      const communityCards: CardType[] = [];

      for (const c of data.holeCards ?? []) {
        try { holeCards.push(parseCard(c)); } catch {}
      }
      for (const c of data.communityCards ?? []) {
        try { communityCards.push(parseCard(c)); } catch {}
      }

      // Calculate win probability
      let winProb: number | null = null;
      let recommendation: ScanResult['recommendation'] = null;

      if (holeCards.length === 2) {
        const players = data.players ?? 4;
        const simResult = runMonteCarloSim(holeCards, communityCards, players, 3000);
        winProb = simResult.winProb;

        const pot = data.potSize ?? 100;
        const call = data.betToCall ?? 0;
        const potOdds = call > 0 ? call / (pot + call) : 0;
        const currentEval = evaluateHand(holeCards, communityCards);

        if (call === 0) {
          if (winProb > 0.6) recommendation = { action: 'RAISE', color: 'bg-emerald-600', text: 'Strong equity — build the pot.' };
          else recommendation = { action: 'CHECK', color: 'bg-zinc-500', text: 'Check and see next card.' };
        } else if (currentEval && currentEval.handRank >= HandRank.FULL_HOUSE) {
          recommendation = { action: 'ALL-IN', color: 'bg-amber-500', text: 'Monster hand — maximize value.' };
        } else if (winProb > potOdds + 0.15) {
          recommendation = { action: 'RAISE', color: 'bg-emerald-600', text: `Win ${(winProb * 100).toFixed(0)}% vs odds ${(potOdds * 100).toFixed(0)}% — raise.` };
        } else if (winProb > potOdds + 0.02) {
          recommendation = { action: 'CALL', color: 'bg-blue-600', text: `Win ${(winProb * 100).toFixed(0)}% vs odds ${(potOdds * 100).toFixed(0)}% — call.` };
        } else {
          recommendation = { action: 'FOLD', color: 'bg-red-600', text: `Win ${(winProb * 100).toFixed(0)}% < odds ${(potOdds * 100).toFixed(0)}% — fold.` };
        }
      }

      setResult({
        holeCards,
        communityCards,
        potSize: data.potSize ?? null,
        betToCall: data.betToCall ?? null,
        players: data.players ?? null,
        confidence: data.confidence,
        winProb,
        recommendation,
      });
      setScanCount(n => n + 1);
      setLastScanTime(new Date().toLocaleTimeString());
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Scan failed');
    } finally {
      isScanningRef.current = false;
    }
  }, [captureFrame, scanMutation]);

  const startScan = useCallback(async () => {
    setError(null);
    setStatus('requesting');
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 5, max: 10 } },
        audio: false,
      });

      streamRef.current = stream;

      // Create hidden video element
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      videoRef.current = video;

      // Handle user stopping via browser UI
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        stopScan();
      });

      setStatus('scanning');
      setScanCount(0);

      // First scan immediately
      await analyzeFrame();

      // Then repeat
      intervalRef.current = setInterval(analyzeFrame, intervalSecs * 1000);
    } catch (err: any) {
      if (err?.name === 'NotAllowedError') {
        setError('Screen sharing was denied. Please allow screen access and try again.');
      } else {
        setError(err?.message ?? 'Failed to start screen capture');
      }
      setStatus('idle');
    }
  }, [analyzeFrame, intervalSecs]);

  const stopScan = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    videoRef.current = null;
    setStatus('stopped');
  }, []);

  useEffect(() => {
    return () => {
      stopScan();
    };
  }, [stopScan]);

  const suitColor = (suit: string) =>
    suit === 'h' || suit === 'd' ? 'text-red-400' : 'text-zinc-100';

  const suitSymbol = (suit: string) =>
    ({ h: '♥', d: '♦', c: '♣', s: '♠' }[suit] ?? suit);

  const rankLabel = (rank: number) =>
    ({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T' }[rank] ?? String(rank));

  return (
    <div className="max-w-3xl mx-auto p-4 font-mono space-y-6">

      {/* HEADER */}
      <div className="space-y-1">
        <h2 className="text-lg font-bold text-zinc-100 tracking-tight">Auto-Scan</h2>
        <p className="text-zinc-500 text-sm">
          Captures your screen every {intervalSecs}s, reads the poker table with AI, gives instant advice.
          No interaction with TON Poker — completely undetectable.
        </p>
      </div>

      {/* INSTRUCTIONS */}
      {status === 'idle' || status === 'stopped' ? (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
          <p className="text-zinc-400 text-sm font-bold uppercase tracking-widest">How it works</p>
          <ol className="space-y-2 text-sm text-zinc-400">
            <li><span className="text-emerald-400 mr-2">1.</span>Open Telegram Desktop and start your TON Poker game</li>
            <li><span className="text-emerald-400 mr-2">2.</span>Click "Start Auto-Scan" below</li>
            <li><span className="text-emerald-400 mr-2">3.</span>Browser asks to share screen — select the Telegram window</li>
            <li><span className="text-emerald-400 mr-2">4.</span>AI reads your cards every {intervalSecs} seconds and shows recommendations here</li>
          </ol>
          <p className="text-zinc-600 text-xs">Works best with Telegram Desktop. TON Poker cannot detect this.</p>
        </div>
      ) : null}

      {/* INTERVAL SELECTOR */}
      {status !== 'scanning' && (
        <div className="flex items-center gap-4">
          <span className="text-zinc-500 text-sm">Scan every:</span>
          {[2, 3, 5].map(s => (
            <button
              key={s}
              onClick={() => setIntervalSecs(s)}
              className={cn(
                'px-3 py-1 rounded text-sm border transition-colors',
                intervalSecs === s
                  ? 'bg-emerald-700 border-emerald-600 text-white'
                  : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:border-zinc-500'
              )}
            >
              {s}s
            </button>
          ))}
        </div>
      )}

      {/* CONTROLS */}
      <div className="flex gap-3">
        {status !== 'scanning' ? (
          <button
            data-testid="button-start-scan"
            onClick={startScan}
            className="flex items-center gap-2 px-6 py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold transition-colors text-sm"
          >
            <span className="w-2 h-2 rounded-full bg-white animate-pulse inline-block" />
            Start Auto-Scan
          </button>
        ) : (
          <button
            data-testid="button-stop-scan"
            onClick={stopScan}
            className="flex items-center gap-2 px-6 py-3 bg-red-700 hover:bg-red-600 text-white rounded-lg font-bold transition-colors text-sm"
          >
            <span className="w-2 h-2 rounded-full bg-white inline-block" />
            Stop Scanning
          </button>
        )}
      </div>

      {/* STATUS BAR */}
      {status === 'scanning' && (
        <div className="flex items-center gap-3 text-sm text-zinc-500">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse inline-block" />
          <span>Scanning... {scanCount} frame{scanCount !== 1 ? 's' : ''} analyzed</span>
          {lastScanTime && <span className="text-zinc-600">Last: {lastScanTime}</span>}
          {scanMutation.isPending && <span className="text-amber-400">Analyzing...</span>}
        </div>
      )}

      {/* ERROR */}
      {error && (
        <div className="bg-red-950/50 border border-red-800 text-red-400 rounded-lg p-3 text-sm">
          {error}
        </div>
      )}

      {/* HIDDEN CANVAS for frame capture */}
      <canvas ref={canvasRef} className="hidden" />

      {/* RESULTS */}
      {result && (
        <div className="space-y-4">

          {/* RECOMMENDATION */}
          {result.recommendation && (
            <div className={cn(
              'rounded-xl p-6 text-center transition-all duration-300',
              result.recommendation.color
            )}>
              <div className="text-4xl font-black tracking-widest text-white mb-1">
                {result.recommendation.action}
              </div>
              <div className="text-white/80 text-sm">{result.recommendation.text}</div>
            </div>
          )}

          {/* CARDS DETECTED */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
              <p className="text-zinc-500 text-xs uppercase tracking-widest mb-3">Your Cards</p>
              {result.holeCards.length > 0 ? (
                <div className="flex gap-2">
                  {result.holeCards.map((card, i) => (
                    <div key={i} className="w-12 h-16 bg-zinc-100 rounded flex flex-col items-center justify-center border border-zinc-300 shadow">
                      <span className={cn('text-lg font-black leading-none', suitColor(card.suit))}>
                        {rankLabel(card.rank)}
                      </span>
                      <span className={cn('text-lg leading-none', suitColor(card.suit))}>
                        {suitSymbol(card.suit)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-zinc-600 text-sm">Not detected</p>
              )}
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
              <p className="text-zinc-500 text-xs uppercase tracking-widest mb-3">Board Cards</p>
              {result.communityCards.length > 0 ? (
                <div className="flex gap-1.5 flex-wrap">
                  {result.communityCards.map((card, i) => (
                    <div key={i} className="w-10 h-14 bg-zinc-100 rounded flex flex-col items-center justify-center border border-zinc-300 shadow">
                      <span className={cn('text-sm font-black leading-none', suitColor(card.suit))}>
                        {rankLabel(card.rank)}
                      </span>
                      <span className={cn('text-sm leading-none', suitColor(card.suit))}>
                        {suitSymbol(card.suit)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-zinc-600 text-sm">Pre-flop / not visible</p>
              )}
            </div>
          </div>

          {/* STATS ROW */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {result.winProb !== null && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-center">
                <div className={cn(
                  'text-2xl font-black',
                  result.winProb > 0.6 ? 'text-emerald-400' : result.winProb > 0.4 ? 'text-amber-400' : 'text-red-400'
                )}>
                  {(result.winProb * 100).toFixed(0)}%
                </div>
                <div className="text-zinc-500 text-xs uppercase tracking-wider">Win Prob</div>
              </div>
            )}
            {result.potSize !== null && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-center">
                <div className="text-2xl font-black text-zinc-200">{result.potSize}</div>
                <div className="text-zinc-500 text-xs uppercase tracking-wider">Pot</div>
              </div>
            )}
            {result.betToCall !== null && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-center">
                <div className="text-2xl font-black text-zinc-200">{result.betToCall}</div>
                <div className="text-zinc-500 text-xs uppercase tracking-wider">To Call</div>
              </div>
            )}
            {result.players !== null && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-center">
                <div className="text-2xl font-black text-zinc-200">{result.players}</div>
                <div className="text-zinc-500 text-xs uppercase tracking-wider">Players</div>
              </div>
            )}
          </div>

          {/* CONFIDENCE */}
          <div className="flex items-center gap-3">
            <span className="text-zinc-600 text-xs uppercase tracking-widest">AI Confidence</span>
            <div className="flex-1 h-1.5 bg-zinc-800 rounded-full">
              <div
                className={cn(
                  'h-1.5 rounded-full transition-all duration-500',
                  result.confidence > 0.7 ? 'bg-emerald-500' : result.confidence > 0.4 ? 'bg-amber-500' : 'bg-red-500'
                )}
                style={{ width: `${result.confidence * 100}%` }}
              />
            </div>
            <span className="text-zinc-500 text-xs">{(result.confidence * 100).toFixed(0)}%</span>
          </div>

          {result.confidence < 0.5 && (
            <p className="text-amber-500/80 text-xs">
              Low confidence — make sure your hole cards are visible and face-up in the screenshot.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
