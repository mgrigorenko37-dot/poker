import React, { useState } from 'react';
import { PREFLOP_EQUITY, getPreflopAction } from '@/lib/poker';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function PreflopChart() {
  const [position, setPosition] = useState('BTN');
  const [hoveredHand, setHoveredHand] = useState<string | null>(null);

  const ranks = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
  
  const getHandFromGrid = (row: number, col: number) => {
    if (row === col) return `${ranks[row]}${ranks[col]}`;
    if (col > row) return `${ranks[row]}${ranks[col]}s`;
    return `${ranks[col]}${ranks[row]}o`;
  };

  const getCellColor = (hand: string, pos: string) => {
    const eq = PREFLOP_EQUITY[hand] || 0;
    const action = getPreflopAction(eq, pos);
    
    if (action === 'RAISE') return 'bg-emerald-600 hover:bg-emerald-500 text-emerald-50';
    if (action === 'CALL') return 'bg-yellow-600 hover:bg-yellow-500 text-yellow-50';
    return 'bg-zinc-800 hover:bg-zinc-700 text-zinc-500';
  };

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-8 font-mono">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold text-zinc-100">Pre-flop Starting Hands</h2>
          <p className="text-zinc-400 text-sm">Action matrix based on equity vs random hand</p>
        </div>
        
        <div className="flex items-center gap-3">
          <span className="text-zinc-400 text-sm tracking-widest uppercase">Position</span>
          <Select value={position} onValueChange={setPosition}>
            <SelectTrigger className="w-32 bg-zinc-900 border-zinc-800 text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-zinc-900 border-zinc-800 text-zinc-300">
              {['UTG', 'UTG+1', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB'].map(p => (
                <SelectItem key={p} value={p}>{p}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        <div className="md:col-span-2 overflow-x-auto">
          <div className="min-w-[600px] border border-zinc-800 rounded-lg overflow-hidden bg-zinc-950">
            {ranks.map((rowRank, rIndex) => (
              <div key={rowRank} className="flex">
                {ranks.map((colRank, cIndex) => {
                  const hand = getHandFromGrid(rIndex, cIndex);
                  return (
                    <div
                      key={hand}
                      onMouseEnter={() => setHoveredHand(hand)}
                      onMouseLeave={() => setHoveredHand(null)}
                      className={cn(
                        "w-[7.69%] aspect-square flex items-center justify-center text-xs font-medium cursor-crosshair border border-zinc-900/50 transition-colors",
                        getCellColor(hand, position)
                      )}
                    >
                      {hand}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <div className="md:col-span-1 space-y-6">
          <Card className="bg-zinc-900 border-zinc-800 p-6 h-full min-h-[300px]">
            {hoveredHand ? (
              <div className="space-y-4">
                <div className="text-5xl font-black text-white">{hoveredHand}</div>
                <div className="space-y-2 pt-4 border-t border-zinc-800">
                  <div className="flex justify-between">
                    <span className="text-zinc-500 uppercase text-xs tracking-widest">Base Equity</span>
                    <span className="text-zinc-200">{PREFLOP_EQUITY[hoveredHand]?.toFixed(1)}%</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-zinc-500 uppercase text-xs tracking-widest">Recommendation</span>
                    <span className={cn(
                      "px-2 py-1 rounded text-xs font-bold",
                      getPreflopAction(PREFLOP_EQUITY[hoveredHand], position) === 'RAISE' ? 'bg-emerald-900/50 text-emerald-400' :
                      getPreflopAction(PREFLOP_EQUITY[hoveredHand], position) === 'CALL' ? 'bg-yellow-900/50 text-yellow-400' :
                      'bg-zinc-800 text-zinc-400'
                    )}>
                      {getPreflopAction(PREFLOP_EQUITY[hoveredHand], position)}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-zinc-600 italic text-sm text-center">
                Hover over the chart to see hand details and exact equities.
              </div>
            )}
          </Card>
          
          <div className="flex flex-wrap gap-4 text-xs text-zinc-400">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-emerald-600 rounded-sm"></div> Raise
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-yellow-600 rounded-sm"></div> Call
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-zinc-800 rounded-sm border border-zinc-700"></div> Fold
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
