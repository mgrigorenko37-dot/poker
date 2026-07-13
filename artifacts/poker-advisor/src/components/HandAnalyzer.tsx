import React, { useState, useEffect, useRef } from 'react';
import { Card as CardType, evaluateHand, runMonteCarloSim, calculateOuts, getPreflopEquity, SimulationResult, HandRank, RANK_CHARS, SUIT_CHARS } from '@/lib/poker';
import { CardPicker, CardDisplay } from './CardPicker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function HandAnalyzer() {
  const [holeCards, setHoleCards] = useState<(CardType | null)[]>([null, null]);
  const [boardCards, setBoardCards] = useState<(CardType | null)[]>([null, null, null, null, null]);
  
  const [position, setPosition] = useState('BTN');
  const [numPlayers, setNumPlayers] = useState(6);
  const [potSize, setPotSize] = useState<number>(100);
  const [betToCall, setBetToCall] = useState<number>(50);
  const [myStack, setMyStack] = useState<number>(1000);
  const [villainStack, setVillainStack] = useState<number>(1000);

  const [simResult, setSimResult] = useState<SimulationResult | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const simTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const validHoleCards = holeCards.filter(Boolean) as CardType[];
  const validBoardCards = boardCards.filter(Boolean) as CardType[];
  const allUsedCards = [...validHoleCards, ...validBoardCards];

  const currentEval = evaluateHand(validHoleCards, validBoardCards);
  const outs = calculateOuts(validHoleCards, validBoardCards);

  useEffect(() => {
    if (simTimeoutRef.current) {
      clearTimeout(simTimeoutRef.current);
    }

    if (validHoleCards.length === 2) {
      setIsSimulating(true);
      simTimeoutRef.current = setTimeout(() => {
        // Run sim
        const result = runMonteCarloSim(validHoleCards, validBoardCards, numPlayers, 5000);
        setSimResult(result);
        setIsSimulating(false);
        
        // Save to history if we have enough info
        const historyItem = {
          id: Date.now().toString(),
          holeCards: validHoleCards,
          boardCards: validBoardCards,
          winProb: result.winProb,
          date: new Date().toISOString()
        };
        const existingStr = localStorage.getItem('poker_history');
        const existing = existingStr ? JSON.parse(existingStr) : [];
        // Only save if it's a new state we haven't just saved
        if (existing.length === 0 || existing[0].winProb !== result.winProb) {
           localStorage.setItem('poker_history', JSON.stringify([historyItem, ...existing].slice(0, 50)));
        }
        
      }, 300);
    } else {
      setSimResult(null);
      setIsSimulating(false);
    }
    
    return () => {
      if (simTimeoutRef.current) clearTimeout(simTimeoutRef.current);
    }
  }, [JSON.stringify(validHoleCards), JSON.stringify(validBoardCards), numPlayers]);

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
  
  let recommendation = { action: 'CHECK', color: 'bg-zinc-600', text: 'Waiting for inputs' };
  
  if (simResult) {
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
              <Label className="text-zinc-400 text-xs tracking-widest uppercase">Pot Size ($)</Label>
              <Input 
                type="number" 
                value={potSize} 
                onChange={e => setPotSize(Number(e.target.value) || 0)}
                className="bg-zinc-950 border-zinc-800 font-mono text-lg"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-zinc-400 text-xs tracking-widest uppercase">Bet to Call ($)</Label>
              <Input 
                type="number" 
                value={betToCall} 
                onChange={e => setBetToCall(Number(e.target.value) || 0)}
                className="bg-zinc-950 border-zinc-800 font-mono text-lg"
              />
            </div>
          </div>
        </Card>
      </div>

      {/* RIGHT COLUMN - RESULTS */}
      <div className="lg:col-span-7 space-y-6">
        
        {/* MAIN DECISION BADGE */}
        <Card className="bg-zinc-900 border-zinc-800 overflow-hidden">
          <div className={cn("p-6 flex flex-col items-center justify-center min-h-[140px] transition-colors duration-500", recommendation.color)}>
            <div className="text-5xl font-black tracking-tight drop-shadow-sm mb-2">
              {recommendation.action}
            </div>
            <div className="text-sm opacity-90 font-medium">
              {recommendation.text}
            </div>
          </div>
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
              
              {/* Custom Gauge */}
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
                {simResult && betToCall > 0 && (
                  <div className="flex justify-between mt-2 pt-2 border-t border-zinc-800">
                    <span className="text-zinc-400">Expected Value:</span>
                    <span className={cn("font-bold", simResult.winProb > potOdds ? "text-emerald-400" : "text-red-400")}>
                      {simResult.winProb > potOdds ? '+' : '-'}${Math.abs((simResult.winProb * (potSize + betToCall)) - betToCall).toFixed(2)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
