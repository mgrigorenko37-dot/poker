import React, { useState } from 'react';
import { PREFLOP_EQUITY } from '@/lib/poker';
import { getPreflopFrequencies, type Position } from '@/lib/poker-gto';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const POSITIONS: Position[] = ['UTG', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB'];

export function PreflopChart() {
  const [position, setPosition] = useState<Position>('BTN');
  const [facingRaise, setFacingRaise] = useState(false);
  const [hoveredHand, setHoveredHand] = useState<string | null>(null);

  const ranks = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
  
  const getHandFromGrid = (row: number, col: number) => {
    if (row === col) return `${ranks[row]}${ranks[col]}`;
    if (col > row) return `${ranks[row]}${ranks[col]}s`;
    return `${ranks[col]}${ranks[row]}o`;
  };

  // Blends raise (green) / call (yellow) / fold (dark) colors by their exact
  // GTO frequency, instead of one flat color per hand — a hand raised 40% of
  // the time actually looks like a 40% mix, not a solid "raise" cell.
  const getCellStyle = (hand: string): React.CSSProperties => {
    const freq = getPreflopFrequencies(hand, position, facingRaise);
    const raiseColor = [16, 185, 129];  // emerald-500
    const callColor = [234, 179, 8];    // yellow-500
    const foldColor = [39, 39, 42];     // zinc-800
    const r = raiseColor.map((c, i) => c * freq.raise + callColor[i] * freq.call + foldColor[i] * freq.fold);
    return { backgroundColor: `rgb(${r[0]}, ${r[1]}, ${r[2]})` };
  };

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-8 font-mono">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold text-zinc-100">Pre-flop Starting Hands</h2>
          <p className="text-zinc-400 text-sm">GTO-матрица частот (не бинарный порог) — цвет = смесь raise/call/fold</p>
        </div>
        
        <div className="flex items-center gap-3">
          <button
            onClick={() => setFacingRaise(f => !f)}
            className={cn(
              'px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider border transition-colors',
              facingRaise ? 'bg-purple-900/50 border-purple-700 text-purple-300' : 'bg-zinc-900 border-zinc-800 text-zinc-500'
            )}
          >
            {facingRaise ? 'Против рейза' : 'RFI (открытие)'}
          </button>
          <span className="text-zinc-400 text-sm tracking-widest uppercase">Position</span>
          <Select value={position} onValueChange={(v) => setPosition(v as Position)}>
            <SelectTrigger className="w-32 bg-zinc-900 border-zinc-800 text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-zinc-900 border-zinc-800 text-zinc-300">
              {POSITIONS.map(p => (
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
                      style={getCellStyle(hand)}
                      className="w-[7.69%] aspect-square flex items-center justify-center text-xs font-medium cursor-crosshair border border-zinc-900/50 transition-colors text-white/90 hover:brightness-125"
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
                  {(() => {
                    const freq = getPreflopFrequencies(hoveredHand, position, facingRaise);
                    return (
                      <>
                        <div className="flex justify-between items-center">
                          <span className="text-emerald-500 uppercase text-xs tracking-widest">{facingRaise ? '3bet' : 'Raise'}</span>
                          <span className="text-zinc-200 font-bold">{(freq.raise * 100).toFixed(0)}%</span>
                        </div>
                        {facingRaise && (
                          <div className="flex justify-between items-center">
                            <span className="text-yellow-500 uppercase text-xs tracking-widest">Call</span>
                            <span className="text-zinc-200 font-bold">{(freq.call * 100).toFixed(0)}%</span>
                          </div>
                        )}
                        <div className="flex justify-between items-center">
                          <span className="text-zinc-500 uppercase text-xs tracking-widest">Fold</span>
                          <span className="text-zinc-200 font-bold">{(freq.fold * 100).toFixed(0)}%</span>
                        </div>
                        {freq.isMixed && (
                          <div className="text-xs text-zinc-500 italic pt-2 border-t border-zinc-800">
                            Смешанная стратегия — граница диапазона, солвер не играет эту руку 100%/0%
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-zinc-600 italic text-sm text-center">
                Hover over the chart to see hand details and exact frequencies.
              </div>
            )}
          </Card>
          
          <div className="flex flex-wrap gap-4 text-xs text-zinc-400">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-emerald-600 rounded-sm"></div> {facingRaise ? '3bet' : 'Raise'}
            </div>
            {facingRaise && (
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 bg-yellow-600 rounded-sm"></div> Call
              </div>
            )}
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-zinc-800 rounded-sm border border-zinc-700"></div> Fold
            </div>
            <div className="text-zinc-600">Цвет — смесь частот, не бинарный порог</div>
          </div>
        </div>
      </div>
    </div>
  );
}
