import React, { useState } from 'react';
import { Card as CardType, RANK_CHARS, SUIT_CHARS, createDeck } from '@/lib/poker';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Plus } from 'lucide-react';

interface CardDisplayProps {
  card: CardType | null;
  onClick?: () => void;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function CardDisplay({ card, onClick, className, size = 'md' }: CardDisplayProps) {
  const isRed = card?.suit === 'h' || card?.suit === 'd';
  
  const sizeClasses = {
    sm: 'w-10 h-14 text-sm',
    md: 'w-14 h-20 text-lg',
    lg: 'w-20 h-28 text-2xl'
  };

  if (!card) {
    return (
      <button
        onClick={onClick}
        className={cn(
          "flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-white/20 bg-black/20 text-white/40 hover:bg-black/40 hover:border-white/40 transition-colors",
          sizeClasses[size],
          className
        )}
      >
        <Plus className="w-5 h-5 mb-1" />
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      className={cn(
        "relative flex flex-col justify-between p-1 rounded-lg bg-white shadow-md border border-gray-200 font-semibold tracking-tighter cursor-pointer hover:-translate-y-1 transition-transform",
        isRed ? 'text-red-600' : 'text-slate-900',
        sizeClasses[size],
        className
      )}
    >
      <div className="absolute top-1 left-1 leading-none text-left">
        <div className="text-[0.9em]">{RANK_CHARS[card.rank]}</div>
        <div className="text-[0.7em] leading-none">{SUIT_CHARS[card.suit]}</div>
      </div>
      <div className="absolute bottom-1 right-1 leading-none text-right rotate-180">
        <div className="text-[0.9em]">{RANK_CHARS[card.rank]}</div>
        <div className="text-[0.7em] leading-none">{SUIT_CHARS[card.suit]}</div>
      </div>
    </button>
  );
}

interface CardPickerProps {
  selectedCard: CardType | null;
  onSelect: (card: CardType | null) => void;
  disabledCards: CardType[];
  trigger?: React.ReactNode;
}

export function CardPicker({ selectedCard, onSelect, disabledCards, trigger }: CardPickerProps) {
  const [open, setOpen] = useState(false);
  const deck = createDeck();
  
  // Group by suit for better display
  const suits = ['c', 'd', 'h', 's'] as const;
  
  const handleSelect = (card: CardType | null) => {
    onSelect(card);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || <CardDisplay card={selectedCard} />}
      </DialogTrigger>
      <DialogContent className="max-w-3xl bg-zinc-900 border-zinc-800 text-white p-6 rounded-xl">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold font-mono text-zinc-100">Select Card</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 mt-4">
          <Button 
            variant="outline" 
            className="w-full border-zinc-700 bg-zinc-800/50 hover:bg-zinc-700 text-zinc-300"
            onClick={() => handleSelect(null)}
          >
            Clear Slot
          </Button>
          
          <div className="grid grid-rows-4 gap-3">
            {suits.map(suit => (
              <div key={suit} className="flex gap-2 overflow-x-auto pb-1">
                {deck.filter(c => c.suit === suit).map(card => {
                  const isDisabled = disabledCards.some(dc => dc.rank === card.rank && dc.suit === card.suit);
                  const isSelected = selectedCard?.rank === card.rank && selectedCard?.suit === card.suit;
                  
                  return (
                    <div key={`${card.rank}-${card.suit}`} className={cn(
                      "transition-opacity",
                      isDisabled && !isSelected ? "opacity-20 pointer-events-none" : "opacity-100"
                    )}>
                      <CardDisplay 
                        card={card} 
                        size="md"
                        onClick={() => handleSelect(card)}
                        className={cn(
                          isSelected && "ring-2 ring-primary ring-offset-2 ring-offset-zinc-900 scale-105"
                        )}
                      />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
