import React, { useState, useEffect, useRef } from 'react';
import { Card as CardType, evaluateHand, runMonteCarloSim, calculateOuts, getPreflopEquity, SimulationResult, HandRank, RANK_CHARS, SUIT_CHARS } from '@/lib/poker';
import { getGTOPreflopAdvice, type Position } from '@/lib/poker-gto';
import { CardPicker, CardDisplay } from './CardPicker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// CFR types
// ---------------------------------------------------------------------------

interface CfrResult {
  action: string;                         // 'check' | 'fold' | 'call' | 'bet33' | 'bet75' | 'allin'
  frequencies: Record<string, number>;    // e.g. { bet75: 0.73, check: 0.27 }
  ev: number;
  equity: number;
  mc_equity: number;
  iterations: number;
  elapsed_ms: number;
  used_range: boolean;
  villain_range_pct: number | null;
  error?: string;
}

const CFR_ACTION_DISPLAY: Record<string, string> = {
  check: 'CHECK',
  fold:  'FOLD',
  call:  'CALL',
  bet33: 'BET 33%',
  bet75: 'BET 75%',
  allin: 'ALL IN',
};

const CFR_ACTION_COLOR: Record<string, string> = {
  fold:  'bg-red-700',
  check: 'bg-zinc-600',
  call:  'bg-blue-600',
  bet33: 'bg-emerald-600',
  bet75: 'bg-emerald-600',
  allin: 'bg-amber-500',
};

const CFR_FREQ_COLOR: Record<string, string> = {
  fold:  'bg-red-700',
  check: 'bg-zinc-500',
  call:  'bg-blue-600',
  bet33: 'bg-emerald-600',
  bet75: 'bg-emerald-500',
  allin: 'bg-amber-500',
};

// ---------------------------------------------------------------------------
// Helper: Card → "Ah" string
// ---------------------------------------------------------------------------
function cardToStr(c: CardType): string {
  return `${RANK_CHARS[c.rank]}${c.suit}`;
}

// ---------------------------------------------------------------------------
// CFR Frequencies bar
// ---------------------------------------------------------------------------
function CfrFreqBar({ frequencies }: { frequencies: Record<string, number> }) {
  const entries = Object.entries(frequencies).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-2">
      {/* Segmented bar */}
      <div className="flex h-5 w-full rounded overflow-hidden gap-px">
        {entries.map(([action, freq]) => (
          <div
            key={action}
            className={cn('transition-all duration-500', CFR_FREQ_COLOR[action] ?? 'bg-zinc-600')}
            style={{ width: `${freq * 100}%` }}
          />
        ))}
      </div>
      {/* Labels */}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {entries.map(([action, freq]) => (
          <span key={action} className="flex items-center gap-1.5 text-xs text-zinc-400">
            <span className={cn('inline-block w-2 h-2 rounded-sm', CFR_FREQ_COLOR[action] ?? 'bg-zinc-600')} />
            {CFR_ACTION_DISPLAY[action] ?? action}
            <span className="text-zinc-300 font-mono">{(freq * 100).toFixed(0)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HandAnalyzer() {
  const [holeCards, setHoleCards] = useState<(CardType | null)[]>([null, null]);
  const [boardCards, setBoardCards] = useState<(CardType | null)[]>([null, null, null, null, null]);
  
  const [position, setPosition] = useState('BTN');
  const [numPlayers, setNumPlayers] = useState(6);
  const [potSize, setPotSize] = useState<number>(100);
  const [betToCall, setBetToCall] = useState<number>(50);
  const [myStack, setMyStack] = useState<number>(1000);
  const [villainStack, setVillainStack] = useState<number>(1000);
  const [stackBBs, setStackBBs] = useState<number>(100);

  const [simResult, setSimResult] = useState<SimulationResult | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const simTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // CFR state
  const [cfrResult, setCfrResult] = useState<CfrResult | null>(null);
  const [isCFRLoading, setIsCFRLoading] = useState(false);
  const cfrAbortRef = useRef<AbortController | null>(null);
  const cfrTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Villain profile state
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [vpip, setVpip]               = useState(28);   // % рук, которые виллан входит в банк
  const [pfr, setPfr]                 = useState(20);   // % рук, с которыми поднимает префлоп
  const [af, setAf]                   = useState(2.5);  // Aggression Factor (бет+рейз / колл)
  const [foldToCbet, setFoldToCbet]   = useState(55);  // % фолд на C-bet
  const [cbet, setCbet]               = useState(65);  // % C-bet виллана

  const validHoleCards = holeCards.filter(Boolean) as CardType[];
  const validBoardCards = boardCards.filter(Boolean) as CardType[];
  const allUsedCards = [...validHoleCards, ...validBoardCards];

  const currentEval = evaluateHand(validHoleCards, validBoardCards);
  const outs = calculateOuts(validHoleCards, validBoardCards);

  // ── Local Monte Carlo equity ──────────────────────────────────────────────
  useEffect(() => {
    if (simTimeoutRef.current) clearTimeout(simTimeoutRef.current);

    if (validHoleCards.length === 2) {
      setIsSimulating(true);
      simTimeoutRef.current = setTimeout(() => {
        const result = runMonteCarloSim(validHoleCards, validBoardCards, numPlayers, 5000);
        setSimResult(result);
        setIsSimulating(false);
        
        const historyItem = {
          id: Date.now().toString(),
          holeCards: validHoleCards,
          boardCards: validBoardCards,
          winProb: result.winProb,
          date: new Date().toISOString()
        };
        const existingStr = localStorage.getItem('poker_history');
        const existing = existingStr ? JSON.parse(existingStr) : [];
        if (existing.length === 0 || existing[0].winProb !== result.winProb) {
          localStorage.setItem('poker_history', JSON.stringify([historyItem, ...existing].slice(0, 50)));
        }
      }, 300);
    } else {
      setSimResult(null);
      setIsSimulating(false);
    }
    
    return () => { if (simTimeoutRef.current) clearTimeout(simTimeoutRef.current); };
  }, [JSON.stringify(validHoleCards), JSON.stringify(validBoardCards), numPlayers]);

  // ── CFR postflop call ─────────────────────────────────────────────────────
  useEffect(() => {
    // CFR только постфлоп (3/4/5 карт борда) и при наличии банка
    const isPostflop = validBoardCards.length === 3 || validBoardCards.length === 4 || validBoardCards.length === 5;
    const isPushFold  = validBoardCards.length === 0 && stackBBs <= 20;

    if (validHoleCards.length !== 2 || !isPostflop || isPushFold) {
      setCfrResult(null);
      return;
    }

    // Дебаунс 500ms — чтобы не стрелять при каждом нажатии цифры
    if (cfrTimerRef.current) clearTimeout(cfrTimerRef.current);
    if (cfrAbortRef.current) cfrAbortRef.current.abort();

    cfrTimerRef.current = setTimeout(() => {
      const controller = new AbortController();
      cfrAbortRef.current = controller;
      setIsCFRLoading(true);
      setCfrResult(null);

      const holeStrings  = validHoleCards.map(cardToStr);
      const boardStrings = validBoardCards.map(cardToStr);

      fetch('/api/cfr/solve', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  controller.signal,
        body: JSON.stringify({
          holeCards:     holeStrings,
          boardCards:    boardStrings,
          pot:           potSize > 0 ? potSize : 100,
          stack:         myStack > 0 ? myStack : 1000,
          cfrIterations: 150,
          villainProfile: {
            vpip:         vpip / 100,
            pfr:          pfr / 100,
            af,
            fold_to_cbet: foldToCbet / 100,
            cbet:         cbet / 100,
          },
        }),
      })
        .then(r => r.json())
        .then((data: CfrResult) => {
          setCfrResult(data);
          setIsCFRLoading(false);
        })
        .catch(e => {
          if (e.name !== 'AbortError') {
            setCfrResult(null);
            setIsCFRLoading(false);
          }
        });
    }, 500);

    return () => {
      if (cfrTimerRef.current) clearTimeout(cfrTimerRef.current);
      if (cfrAbortRef.current) cfrAbortRef.current.abort();
    };
  }, [JSON.stringify(validHoleCards), JSON.stringify(validBoardCards), potSize, myStack, stackBBs, vpip, pfr, af, foldToCbet, cbet]);

  const updateHoleCard = (index: number, card: CardType | null) => {
    const newCards = [...holeCards];
    newCards[index] = card;
    setHoleCards(newCards);
  };

  const updateBoardCard = (index: number, card: CardType | null) => {
    const newCards = [...boardCards];
    newCards[index] = card;
    setBoardCards(newCards);
  };

  const potOdds = betToCall > 0 ? (betToCall / (potSize + betToCall)) : 0;

  // ── Recommendation: CFR > push/fold > heuristic ───────────────────────────
  let recommendation = { action: 'CHECK', color: 'bg-zinc-600', text: 'Waiting for inputs' };
  let usingCFR = false;

  if (cfrResult && !cfrResult.error) {
    usingCFR = true;
    const a = cfrResult.action;
    recommendation = {
      action: CFR_ACTION_DISPLAY[a] ?? a.toUpperCase(),
      color:  CFR_ACTION_COLOR[a] ?? 'bg-zinc-600',
      text:   `MCCFR · EV ${cfrResult.ev > 0 ? '+' : ''}${cfrResult.ev} · equity ${cfrResult.mc_equity}%`,
    };
  } else if (validHoleCards.length === 2 && validBoardCards.length === 0 && stackBBs <= 20) {
    const pfAdvice = getGTOPreflopAdvice(validHoleCards, position as Position, betToCall > 0, stackBBs);
    if (pfAdvice.action === 'RAISE') {
      recommendation = { action: 'PUSH ALL-IN', color: 'bg-amber-500', text: pfAdvice.reason };
    } else if (pfAdvice.action === 'CALL') {
      recommendation = { action: 'CALL PUSH', color: 'bg-blue-600', text: pfAdvice.reason };
    } else {
      recommendation = { action: 'FOLD', color: 'bg-red-700', text: pfAdvice.reason };
    }
  } else if (simResult) {
    const winProb = simResult.winProb;
    if (betToCall === 0) {
      if (winProb > 0.6) recommendation = { action: 'RAISE', color: 'bg-emerald-600', text: 'Strong equity. Build the pot.' };
      else recommendation = { action: 'CHECK', color: 'bg-zinc-500', text: 'Check and see.' };
    } else {
      if (winProb > 0.95 || (currentEval && currentEval.handRank >= HandRank.FULL_HOUSE)) {
        recommendation = { action: 'ALL-IN', color: 'bg-amber-500 text-black', text: 'Premium holding. Maximize value.' };
      } else if (winProb > potOdds + 0.15) {
        recommendation = { action: 'RAISE', color: 'bg-emerald-600', text: 'Equity strongly exceeds pot odds.' };
      } else if (winProb > potOdds + 0.02) {
        recommendation = { action: 'CALL', color: 'bg-blue-600', text: `Profitable call (Win ${Math.round(winProb*100)}% > Odds ${Math.round(potOdds*100)}%)` };
      } else {
        recommendation = { action: 'FOLD', color: 'bg-red-600', text: `Negative EV (Win ${Math.round(winProb*100)}% < Odds ${Math.round(potOdds*100)}%)` };
      }
    }
  }

  const formatProb = (prob: number) => (prob * 100).toFixed(1) + '%';
  
  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 p-4 max-w-7xl mx-auto font-mono text-zinc-300">
      
      {/* LEFT COLUMN - INPUTS */}
      <div className="lg:col-span-5 space-y-6">
        
        {/* CARDS INPUT */}
        <Card className="bg-zinc-900 border-zinc-800 p-5 space-y-5">
          <div>
            <Label className="text-zinc-400 mb-3 block text-sm tracking-widest uppercase">Hole Cards</Label>
            <div className="flex gap-4">
              <CardPicker selectedCard={holeCards[0]} onSelect={c => updateHoleCard(0, c)} disabledCards={allUsedCards} />
              <CardPicker selectedCard={holeCards[1]} onSelect={c => updateHoleCard(1, c)} disabledCards={allUsedCards} />
            </div>
          </div>
          
          <div>
            <Label className="text-zinc-400 mb-3 block text-sm tracking-widest uppercase">Board Cards</Label>
            <div className="flex flex-wrap gap-3">
              {[0, 1, 2, 3, 4].map(i => (
                <CardPicker 
                  key={i} 
                  selectedCard={boardCards[i]} 
                  onSelect={c => updateBoardCard(i, c)} 
                  disabledCards={allUsedCards} 
                />
              ))}
            </div>
          </div>
        </Card>

        {/* SITUATION INPUTS */}
        <Card className="bg-zinc-900 border-zinc-800 p-5 space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-zinc-400 text-xs tracking-widest uppercase">Position</Label>
              <Select value={position} onValueChange={setPosition}>
                <SelectTrigger className="bg-zinc-950 border-zinc-800">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-zinc-900 border-zinc-800 text-zinc-300">
                  {['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB'].map(p => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            
            <div className="space-y-2">
              <Label className="text-zinc-400 text-xs tracking-widest uppercase">Players ({numPlayers})</Label>
              <Slider 
                min={2} max={9} step={1} 
                value={[numPlayers]} 
                onValueChange={(v) => setNumPlayers(v[0])}
                className="pt-2"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-zinc-400 text-xs tracking-widest uppercase">
                Stack (BB)
                {stackBBs <= 20 && <span className="ml-2 text-amber-400 normal-case">— push/fold</span>}
              </Label>
              <Input
                type="number"
                value={stackBBs}
                onChange={e => setStackBBs(Math.max(1, Number(e.target.value) || 1))}
                className="bg-zinc-950 border-zinc-800 font-mono text-lg"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-zinc-400 text-xs tracking-widest uppercase">Pot Size ($)</Label>
              <Input 
                type="number" 
                value={potSize} 
                onChange={e => setPotSize(Number(e.target.value) || 0)}
                className="bg-zinc-950 border-zinc-800 font-mono text-lg"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-zinc-400 text-xs tracking-widest uppercase">Bet to Call ($)</Label>
              <Input 
                type="number" 
                value={betToCall} 
                onChange={e => setBetToCall(Number(e.target.value) || 0)}
                className="bg-zinc-950 border-zinc-800 font-mono text-lg"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-zinc-400 text-xs tracking-widest uppercase">My Stack ($)</Label>
              <Input
                type="number"
                value={myStack}
                onChange={e => setMyStack(Math.max(1, Number(e.target.value) || 1))}
                className="bg-zinc-950 border-zinc-800 font-mono text-lg"
              />
            </div>
          </div>
        </Card>

        {/* VILLAIN PROFILE — collapsible */}
        <Card className="bg-zinc-900 border-zinc-800 overflow-hidden">
          <button
            onClick={() => setIsProfileOpen(o => !o)}
            className="w-full flex items-center justify-between px-5 py-3 hover:bg-zinc-800/50 transition-colors"
          >
            <span className="text-zinc-400 text-xs uppercase tracking-widest font-bold">Профиль оппонента</span>
            {isProfileOpen
              ? <ChevronUp className="w-4 h-4 text-zinc-500" />
              : <ChevronDown className="w-4 h-4 text-zinc-500" />}
          </button>

          {isProfileOpen && (
            <div className="px-5 pb-5 space-y-4 border-t border-zinc-800">
              <p className="text-zinc-600 text-xs mt-3">
                Используется CFR-солвером для node-locking — стратегия виллана подстраивается под его стиль.
              </p>

              {/* VPIP / PFR */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <Label className="text-zinc-400 text-xs uppercase tracking-widest">VPIP</Label>
                    <span className="text-zinc-300 text-xs font-mono">{vpip}%</span>
                  </div>
                  <input type="range" min={10} max={80} step={1} value={vpip}
                    onChange={e => setVpip(Number(e.target.value))}
                    className="w-full accent-emerald-500" />
                  <div className="flex justify-between text-zinc-700 text-[10px]">
                    <span>Тайт</span><span>Лус</span>
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <Label className="text-zinc-400 text-xs uppercase tracking-widest">PFR</Label>
                    <span className="text-zinc-300 text-xs font-mono">{pfr}%</span>
                  </div>
                  <input type="range" min={5} max={60} step={1} value={pfr}
                    onChange={e => setPfr(Number(e.target.value))}
                    className="w-full accent-emerald-500" />
                  <div className="flex justify-between text-zinc-700 text-[10px]">
                    <span>Пассив</span><span>Агресс</span>
                  </div>
                </div>
              </div>

              {/* AF / Fold to C-bet */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <Label className="text-zinc-400 text-xs uppercase tracking-widest">AF</Label>
                    <span className="text-zinc-300 text-xs font-mono">{af.toFixed(1)}</span>
                  </div>
                  <input type="range" min={0.5} max={6} step={0.1} value={af}
                    onChange={e => setAf(Number(e.target.value))}
                    className="w-full accent-emerald-500" />
                  <div className="flex justify-between text-zinc-700 text-[10px]">
                    <span>Пассив</span><span>Агресс</span>
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between">
                    <Label className="text-zinc-400 text-xs uppercase tracking-widest">Fold to CB</Label>
                    <span className="text-zinc-300 text-xs font-mono">{foldToCbet}%</span>
                  </div>
                  <input type="range" min={20} max={90} step={1} value={foldToCbet}
                    onChange={e => setFoldToCbet(Number(e.target.value))}
                    className="w-full accent-emerald-500" />
                  <div className="flex justify-between text-zinc-700 text-[10px]">
                    <span>Стейшен</span><span>Фолдер</span>
                  </div>
                </div>
              </div>

              {/* C-bet frequency */}
              <div className="space-y-1">
                <div className="flex justify-between">
                  <Label className="text-zinc-400 text-xs uppercase tracking-widest">C-bet %</Label>
                  <span className="text-zinc-300 text-xs font-mono">{cbet}%</span>
                </div>
                <input type="range" min={20} max={90} step={1} value={cbet}
                  onChange={e => setCbet(Number(e.target.value))}
                  className="w-full accent-emerald-500" />
                <div className="flex justify-between text-zinc-700 text-[10px]">
                  <span>Редко</span><span>Часто</span>
                </div>
              </div>

              {/* Quick presets */}
              <div className="flex gap-2 flex-wrap pt-1">
                {([
                  { label: 'Рек',   vpip: 24, pfr: 18, af: 3.0, ftc: 55, cb: 60 },
                  { label: 'Тайт',  vpip: 16, pfr: 13, af: 2.0, ftc: 65, cb: 50 },
                  { label: 'Лус',   vpip: 40, pfr: 22, af: 2.5, ftc: 45, cb: 70 },
                  { label: 'Манья', vpip: 55, pfr: 35, af: 4.5, ftc: 35, cb: 80 },
                ] as const).map(p => (
                  <button key={p.label}
                    onClick={() => { setVpip(p.vpip); setPfr(p.pfr); setAf(p.af); setFoldToCbet(p.ftc); setCbet(p.cb); }}
                    className="text-xs px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* RIGHT COLUMN - RESULTS */}
      <div className="lg:col-span-7 space-y-6">
        
        {/* MAIN DECISION BADGE */}
        <Card className="bg-zinc-900 border-zinc-800 overflow-hidden">
          <div className={cn(
            "p-6 flex flex-col items-center justify-center min-h-[140px] transition-colors duration-500",
            recommendation.color,
          )}>
            <div className="flex items-center gap-3 mb-2">
              <div className="text-5xl font-black tracking-tight drop-shadow-sm">
                {recommendation.action}
              </div>
              {isCFRLoading && (
                <Loader2 className="w-6 h-6 animate-spin opacity-70" />
              )}
            </div>
            <div className="text-sm opacity-90 font-medium text-center">
              {recommendation.text}
            </div>
            {usingCFR && (
              <div className="mt-1 text-[11px] opacity-60 tracking-widest uppercase">
                MCCFR · Python solver
              </div>
            )}
          </div>

          {/* CFR frequencies bar — показываем только когда есть результат */}
          {cfrResult && !cfrResult.error && Object.keys(cfrResult.frequencies).length > 1 && (
            <div className="px-5 py-4 border-t border-zinc-800 bg-zinc-950/60">
              <div className="text-zinc-500 text-[10px] tracking-widest uppercase mb-3">
                Частоты действий (GTO mix)
              </div>
              <CfrFreqBar frequencies={cfrResult.frequencies} />
              <div className="mt-3 flex items-center justify-between text-[11px] text-zinc-600">
                <span>{cfrResult.iterations} итераций CFR · {cfrResult.elapsed_ms}ms</span>
                {cfrResult.used_range && cfrResult.villain_range_pct != null && (
                  <span>range vs range · виллейн ~{cfrResult.villain_range_pct}% рук</span>
                )}
              </div>
            </div>
          )}
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* STATS PANEL */}
          <Card className="bg-zinc-900 border-zinc-800 p-5 space-y-6">
            <div>
              <div className="text-zinc-500 text-xs tracking-widest uppercase mb-1">Win Probability</div>
              <div className="flex items-end gap-3 mb-2">
                <span className="text-4xl font-bold text-white">
                  {simResult ? formatProb(simResult.winProb) : '--%'}
                </span>
                {isSimulating && <Loader2 className="w-5 h-5 animate-spin text-zinc-500 mb-2" />}
              </div>
              
              <div className="h-2 w-full bg-zinc-800 rounded-full overflow-hidden">
                <div 
                  className={cn(
                    "h-full transition-all duration-1000",
                    simResult?.winProb && simResult.winProb > 0.6 ? 'bg-emerald-500' : 
                    simResult?.winProb && simResult.winProb > 0.4 ? 'bg-yellow-500' : 'bg-red-500'
                  )}
                  style={{ width: simResult ? `${simResult.winProb * 100}%` : '0%' }}
                />
              </div>
              
              <div className="flex justify-between mt-2 text-xs text-zinc-500">
                <span>Tie: {simResult ? formatProb(simResult.tieProb) : '--%'}</span>
                <span>Pot Odds: {formatProb(potOdds)}</span>
              </div>
              {simResult?.usedRangeVsRange && (
                <div className="mt-2 text-[11px] text-zinc-600 italic">
                  Симуляция против диапазона виллана (~{simResult.villainRangePct}% рук), не "любые две карты"
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-zinc-800">
              <div className="text-zinc-500 text-xs tracking-widest uppercase mb-2">Current Hand</div>
              <div className="text-xl text-zinc-200">
                {currentEval ? currentEval.handName : 'Waiting...'}
              </div>
              {currentEval && (
                <div className="flex gap-1 mt-3">
                  {currentEval.bestCards.map((c, i) => (
                    <span key={i} className={cn(
                      "px-2 py-1 rounded text-sm bg-zinc-950 border border-zinc-800",
                      (c.suit === 'h' || c.suit === 'd') ? 'text-red-400' : 'text-zinc-300'
                    )}>
                      {RANK_CHARS[c.rank]}{SUIT_CHARS[c.suit]}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </Card>

          {/* OUTS & EV PANEL */}
          <Card className="bg-zinc-900 border-zinc-800 p-5 space-y-6">
            <div>
              <div className="text-zinc-500 text-xs tracking-widest uppercase mb-2">Outs to Improve ({outs.length})</div>
              {outs.length > 0 ? (
                <div className="flex flex-wrap gap-1 max-h-[140px] overflow-y-auto pr-2 custom-scrollbar">
                  {outs.map((c, i) => (
                    <span key={i} className={cn(
                      "text-xs px-1.5 py-0.5 rounded border border-zinc-800/50 bg-zinc-950/50",
                      (c.suit === 'h' || c.suit === 'd') ? 'text-red-400/80' : 'text-zinc-400'
                    )}>
                      {RANK_CHARS[c.rank]}{SUIT_CHARS[c.suit]}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-zinc-600 italic">No direct outs, or board is empty.</div>
              )}
            </div>
            
            <div className="pt-4 border-t border-zinc-800">
              <div className="text-zinc-500 text-xs tracking-widest uppercase mb-2">Math Breakdown</div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-zinc-400">Pot Size:</span>
                  <span className="text-zinc-200">${potSize}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">To Call:</span>
                  <span className="text-zinc-200">${betToCall}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">Required Equity:</span>
                  <span className="text-zinc-200">{formatProb(potOdds)}</span>
                </div>
                {/* CFR EV когда доступен, иначе — расчётный EV */}
                {cfrResult && !cfrResult.error ? (
                  <div className="flex justify-between mt-2 pt-2 border-t border-zinc-800">
                    <span className="text-zinc-400">EV (MCCFR):</span>
                    <span className={cn("font-bold", cfrResult.ev >= 0 ? "text-emerald-400" : "text-red-400")}>
                      {cfrResult.ev >= 0 ? '+' : ''}{cfrResult.ev}
                    </span>
                  </div>
                ) : simResult && betToCall > 0 ? (
                  <div className="flex justify-between mt-2 pt-2 border-t border-zinc-800">
                    <span className="text-zinc-400">Expected Value:</span>
                    <span className={cn("font-bold", simResult.winProb > potOdds ? "text-emerald-400" : "text-red-400")}>
                      {simResult.winProb > potOdds ? '+' : '-'}${Math.abs((simResult.winProb * (potSize + betToCall)) - betToCall).toFixed(2)}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
