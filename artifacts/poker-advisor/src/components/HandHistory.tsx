import React, { useState, useEffect } from 'react';
import { Card as CardType, RANK_CHARS, SUIT_CHARS } from '@/lib/poker';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface HistoryItem {
  id: string;
  holeCards: CardType[];
  boardCards: CardType[];
  winProb: number;
  date: string;
}

export function HandHistory() {
  const [history, setHistory] = useState<HistoryItem[]>([]);

  useEffect(() => {
    const data = localStorage.getItem('poker_history');
    if (data) {
      try {
        setHistory(JSON.parse(data));
      } catch (e) {}
    }
  }, []);

  const clearHistory = () => {
    localStorage.removeItem('poker_history');
    setHistory([]);
  };

  const renderCard = (c: CardType, idx: number) => {
    const isRed = c.suit === 'h' || c.suit === 'd';
    return (
      <span key={idx} className={cn(
        "inline-flex items-center justify-center w-8 h-10 bg-white rounded shadow-sm text-sm font-bold border border-zinc-200 mx-0.5",
        isRed ? "text-red-600" : "text-black"
      )}>
        {RANK_CHARS[c.rank]}<span className="text-[10px] ml-0.5">{SUIT_CHARS[c.suit]}</span>
      </span>
    );
  };

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-6 font-mono">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-zinc-100">Session History</h2>
          <p className="text-zinc-400 text-sm">Recently analyzed hands</p>
        </div>
        {history.length > 0 && (
          <Button 
            variant="outline" 
            onClick={clearHistory}
            className="border-zinc-800 hover:bg-zinc-800 text-zinc-400 hover:text-white"
          >
            <Trash2 className="w-4 h-4 mr-2" />
            Clear
          </Button>
        )}
      </div>

      {history.length === 0 ? (
        <Card className="bg-zinc-900 border-zinc-800 p-12 text-center">
          <p className="text-zinc-500">No hands analyzed yet. Start with the Hand Analyzer.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {history.map((item) => (
            <Card key={item.id} className="bg-zinc-900 border-zinc-800 p-4 flex flex-col md:flex-row items-center justify-between gap-4 transition-colors hover:bg-zinc-800/50">
              
              <div className="flex items-center gap-6 w-full md:w-auto">
                <div>
                  <div className="text-xs text-zinc-500 mb-1 uppercase tracking-widest">Hole</div>
                  <div className="flex">{item.holeCards.map((c, i) => renderCard(c, i))}</div>
                </div>
                
                {item.boardCards.length > 0 && (
                  <div>
                    <div className="text-xs text-zinc-500 mb-1 uppercase tracking-widest">Board</div>
                    <div className="flex">{item.boardCards.map((c, i) => renderCard(c, i))}</div>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-6 w-full md:w-auto justify-between md:justify-end border-t md:border-t-0 border-zinc-800 pt-3 md:pt-0">
                <div className="text-right">
                  <div className="text-xs text-zinc-500 uppercase tracking-widest">Equity</div>
                  <div className={cn(
                    "text-xl font-bold",
                    item.winProb > 0.6 ? "text-emerald-400" :
                    item.winProb > 0.4 ? "text-yellow-400" : "text-red-400"
                  )}>
                    {(item.winProb * 100).toFixed(1)}%
                  </div>
                </div>
                <div className="text-xs text-zinc-600">
                  {new Date(item.date).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                </div>
              </div>

            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
