export type Suit = 'c' | 'd' | 'h' | 's';
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
  rank: Rank;
  suit: Suit;
}

// Hand rankings
export const HandRank = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  THREE_OF_A_KIND: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_OF_A_KIND: 7,
  STRAIGHT_FLUSH: 8,
  ROYAL_FLUSH: 9,
} as const;

export type HandRankType = (typeof HandRank)[keyof typeof HandRank];

export const RANK_CHARS = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A'
};

export const SUIT_CHARS = {
  c: '♣', d: '♦', h: '♥', s: '♠'
};

export function createDeck(): Card[] {
  const deck: Card[] = [];
  const suits: Suit[] = ['c', 'd', 'h', 's'];
  for (let rank = 2; rank <= 14; rank++) {
    for (const suit of suits) {
      deck.push({ rank: rank as Rank, suit });
    }
  }
  return deck;
}

export function formatCard(card: Card): string {
  return `${RANK_CHARS[card.rank]}${SUIT_CHARS[card.suit]}`;
}

export function parseCard(cardStr: string): Card {
  const rankChar = cardStr[0];
  const suitChar = cardStr[1].toLowerCase() as Suit;
  let rank = 2;
  for (const [r, c] of Object.entries(RANK_CHARS)) {
    if (c === rankChar) {
      rank = parseInt(r);
      break;
    }
  }
  return { rank: rank as Rank, suit: suitChar };
}

// Hand Evaluator logic

export interface HandEvaluation {
  handRank: HandRankType;
  handName: string;
  score: number;
  bestCards: Card[];
}

// Generates all combinations of size k from array arr
function getCombinations<T>(arr: T[], k: number): T[][] {
  const results: T[][] = [];
  function helper(start: number, combo: T[]) {
    if (combo.length === k) {
      results.push([...combo]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      helper(i + 1, combo);
      combo.pop();
    }
  }
  helper(0, []);
  return results;
}

export function evaluate5Cards(cards: Card[]): HandEvaluation {
  // sort descending by rank
  const sorted = [...cards].sort((a, b) => b.rank - a.rank);
  
  const isFlush = sorted.every(c => c.suit === sorted[0].suit);
  
  // check straight
  let isStraight = true;
  for (let i = 0; i < 4; i++) {
    if (sorted[i].rank - 1 !== sorted[i+1].rank) {
      isStraight = false;
      break;
    }
  }
  
  // Special case: A 5 4 3 2 straight
  if (!isStraight && sorted[0].rank === 14 && sorted[1].rank === 5 && sorted[2].rank === 4 && sorted[3].rank === 3 && sorted[4].rank === 2) {
    isStraight = true;
    // rotate so 5 is the highest
    const ace = sorted.shift()!;
    sorted.push(ace);
  }

  // Count frequencies
  const counts = new Map<number, number>();
  for (const c of sorted) {
    counts.set(c.rank, (counts.get(c.rank) || 0) + 1);
  }
  
  const frequencies = Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]; // sort by count desc
    return b[0] - a[0]; // then by rank desc
  });

  let rank: HandRankType = HandRank.HIGH_CARD;
  let name = "High Card";

  if (isFlush && isStraight) {
    rank = sorted[0].rank === 14 ? HandRank.ROYAL_FLUSH : HandRank.STRAIGHT_FLUSH;
    name = rank === HandRank.ROYAL_FLUSH ? "Royal Flush" : "Straight Flush";
  } else if (frequencies[0][1] === 4) {
    rank = HandRank.FOUR_OF_A_KIND;
    name = "Four of a Kind";
  } else if (frequencies[0][1] === 3 && frequencies[1][1] === 2) {
    rank = HandRank.FULL_HOUSE;
    name = "Full House";
  } else if (isFlush) {
    rank = HandRank.FLUSH;
    name = "Flush";
  } else if (isStraight) {
    rank = HandRank.STRAIGHT;
    name = "Straight";
  } else if (frequencies[0][1] === 3) {
    rank = HandRank.THREE_OF_A_KIND;
    name = "Three of a Kind";
  } else if (frequencies[0][1] === 2 && frequencies[1][1] === 2) {
    rank = HandRank.TWO_PAIR;
    name = "Two Pair";
  } else if (frequencies[0][1] === 2) {
    rank = HandRank.PAIR;
    name = "Pair";
  }

  // Score format: rank (4 bits) | 5x card values (4 bits each) 
  // We use the frequency sorted cards so pairs/trips dominate the score
  let score = rank * 0x100000;
  let shift = 16;
  const bestCardsForScore: Card[] = [];
  
  for (const [r, count] of frequencies) {
    for (let i = 0; i < count; i++) {
      score += (r === 14 && isStraight && sorted[0].rank === 5 ? 1 : r) * Math.pow(16, shift/4);
      shift -= 4;
      bestCardsForScore.push(sorted.find(c => c.rank === r && !bestCardsForScore.includes(c))!);
    }
  }

  return {
    handRank: rank,
    handName: name,
    score,
    bestCards: sorted // Just return the 5 cards that make up this hand
  };
}

export function evaluateHand(holeCards: Card[], communityCards: Card[]): HandEvaluation | null {
  const allCards = [...holeCards, ...communityCards];
  if (allCards.length < 5) return null;
  if (allCards.length === 5) return evaluate5Cards(allCards);

  const combos = getCombinations(allCards, 5);
  let bestEval: HandEvaluation | null = null;

  for (const combo of combos) {
    const ev = evaluate5Cards(combo);
    if (!bestEval || ev.score > bestEval.score) {
      bestEval = ev;
    }
  }

  return bestEval;
}

// Preflop Equities vs Random Hand (9-max) for standard 169 hands.
// Approximate values. 
// Hand key: "AKs", "AKo", "AA"
export const PREFLOP_EQUITY: Record<string, number> = {
  "AA": 85.2, "KK": 82.4, "QQ": 79.9, "JJ": 77.4, "TT": 75.0, "99": 71.6, "88": 68.9, "77": 65.7, "66": 62.7, "55": 59.6, "44": 56.2, "33": 52.8, "22": 49.3,
  "AKs": 67.0, "AQs": 66.1, "AJs": 65.3, "ATs": 64.6, "A9s": 62.6, "A8s": 61.6, "A7s": 60.5, "A6s": 59.1, "A5s": 59.9, "A4s": 58.9, "A3s": 57.9, "A2s": 56.8,
  "AKo": 65.3, "AQo": 64.4, "AJo": 63.5, "ATo": 62.7, "A9o": 60.5, "A8o": 59.3, "A7o": 58.1, "A6o": 56.6, "A5o": 57.4, "A4o": 56.3, "A3o": 55.2, "A2o": 54.0,
  "KQs": 63.3, "KJs": 62.5, "KTs": 61.8, "K9s": 59.9, "K8s": 58.5, "K7s": 57.8, "K6s": 56.7, "K5s": 55.7, "K4s": 54.4, "K3s": 53.3, "K2s": 52.1,
  "KQo": 61.3, "KJo": 60.4, "KTo": 59.7, "K9o": 57.5, "K8o": 56.0, "K7o": 55.1, "K6o": 53.9, "K5o": 52.8, "K4o": 51.5, "K3o": 50.2, "K2o": 49.0,
  "QJs": 60.2, "QTs": 59.4, "Q9s": 57.7, "Q8s": 56.2, "Q7s": 54.9, "Q6s": 54.1, "Q5s": 52.8, "Q4s": 51.6, "Q3s": 50.4, "Q2s": 49.2,
  "QJo": 58.0, "QTo": 57.1, "Q9o": 55.1, "Q8o": 53.5, "Q7o": 52.1, "Q6o": 51.2, "Q5o": 49.8, "Q4o": 48.5, "Q3o": 47.3, "Q2o": 46.0,
  "JTs": 57.4, "J9s": 55.8, "J8s": 54.3, "J7s": 53.2, "J6s": 51.7, "J5s": 50.6, "J4s": 49.2, "J3s": 48.1, "J2s": 46.9,
  "JTo": 55.0, "J9o": 53.2, "J8o": 51.5, "J7o": 50.2, "J6o": 48.6, "J5o": 47.4, "J4o": 46.0, "J3o": 44.7, "J2o": 43.4,
  "T9s": 54.0, "T8s": 52.6, "T7s": 51.5, "T6s": 50.0, "T5s": 48.7, "T4s": 47.2, "T3s": 46.1, "T2s": 44.9,
  "T9o": 51.3, "T8o": 49.7, "T7o": 48.4, "T6o": 46.8, "T5o": 45.4, "T4o": 43.8, "T3o": 42.6, "T2o": 41.3,
  "98s": 50.7, "97s": 49.7, "96s": 48.4, "95s": 47.1, "94s": 45.5, "93s": 44.5, "92s": 43.1,
  "98o": 47.8, "97o": 46.6, "96o": 45.2, "95o": 43.8, "94o": 42.1, "93o": 40.9, "92o": 39.4,
  "87s": 48.1, "86s": 47.0, "85s": 45.8, "84s": 44.3, "83s": 43.2, "82s": 42.0,
  "87o": 44.9, "86o": 43.7, "85o": 42.4, "84o": 40.8, "83o": 39.5, "82o": 38.3,
  "76s": 45.6, "75s": 44.6, "74s": 43.3, "73s": 42.1, "72s": 40.8,
  "76o": 42.3, "75o": 41.1, "74o": 39.7, "73o": 38.4, "72o": 36.9,
  "65s": 43.7, "64s": 42.6, "63s": 41.5, "62s": 40.2,
  "65o": 40.2, "64o": 39.0, "63o": 37.8, "62o": 36.4,
  "54s": 41.9, "53s": 40.9, "52s": 39.8,
  "54o": 38.3, "53o": 37.1, "52o": 35.9,
  "43s": 39.5, "42s": 38.5,
  "43o": 35.7, "42o": 34.6,
  "32s": 37.1,
  "32o": 33.1,
};

export function getHandKey(c1: Card, c2: Card): string {
  const r1 = c1.rank;
  const r2 = c2.rank;
  const suited = c1.suit === c2.suit;
  const high = Math.max(r1, r2) as Rank;
  const low = Math.min(r1, r2) as Rank;
  
  if (high === low) {
    return `${RANK_CHARS[high]}${RANK_CHARS[low]}`;
  }
  return `${RANK_CHARS[high]}${RANK_CHARS[low]}${suited ? 's' : 'o'}`;
}

export function getPreflopEquity(holeCards: Card[]): number {
  if (holeCards.length !== 2) return 0;
  const key = getHandKey(holeCards[0], holeCards[1]);
  return PREFLOP_EQUITY[key] || 50;
}

// Determine recommended action Preflop based on position and equity
export function getPreflopAction(equity: number, position: string): string {
  if (equity >= 65) return "RAISE";
  if (equity >= 60) {
    return ['BTN', 'CO', 'HJ', 'SB'].includes(position) ? "RAISE" : "CALL";
  }
  if (equity >= 54) {
    return ['BTN', 'CO'].includes(position) ? "CALL" : "FOLD";
  }
  return "FOLD";
}

// Monte Carlo simulator
export interface SimulationResult {
  wins: number;
  losses: number;
  ties: number;
  total: number;
  winProb: number;
  tieProb: number;
}

export function runMonteCarloSim(
  holeCards: Card[], 
  boardCards: Card[], 
  numPlayers: number = 2,
  iterations: number = 1000
): SimulationResult {
  if (holeCards.length !== 2) return { wins: 0, losses: 0, ties: 0, total: 0, winProb: 0, tieProb: 0 };
  
  // If preflop, use lookups for speed if we only need approx vs 1 random hand
  // But since we want to handle numPlayers, we'll run the sim.
  
  const knownCards = new Set([...holeCards, ...boardCards].map(c => `${c.rank}${c.suit}`));
  const deck = createDeck().filter(c => !knownCards.has(`${c.rank}${c.suit}`));
  
  let wins = 0;
  let losses = 0;
  let ties = 0;

  for (let i = 0; i < iterations; i++) {
    // shuffle a copy of remaining deck
    const simDeck = [...deck];
    for (let j = simDeck.length - 1; j > 0; j--) {
      const k = Math.floor(Math.random() * (j + 1));
      [simDeck[j], simDeck[k]] = [simDeck[k], simDeck[j]];
    }
    
    let deckIdx = 0;
    
    // deal remaining board cards
    const simBoard = [...boardCards];
    while (simBoard.length < 5) {
      simBoard.push(simDeck[deckIdx++]);
    }
    
    const myEval = evaluateHand(holeCards, simBoard);
    const myScore = myEval ? myEval.score : 0;
    
    let highestOpponentScore = -1;
    let tieCount = 0;
    
    // deal for opponents
    for (let p = 1; p < numPlayers; p++) {
      const oppHole = [simDeck[deckIdx++], simDeck[deckIdx++]];
      const oppEval = evaluateHand(oppHole, simBoard);
      const oppScore = oppEval ? oppEval.score : 0;
      
      if (oppScore > highestOpponentScore) {
        highestOpponentScore = oppScore;
      }
    }
    
    if (myScore > highestOpponentScore) {
      wins++;
    } else if (myScore < highestOpponentScore) {
      losses++;
    } else {
      ties++;
    }
  }
  
  return {
    wins,
    losses,
    ties,
    total: iterations,
    winProb: wins / iterations,
    tieProb: ties / iterations
  };
}

export function calculateOuts(holeCards: Card[], boardCards: Card[]): Card[] {
  if (holeCards.length !== 2 || boardCards.length === 0 || boardCards.length >= 5) return [];
  
  const knownCards = new Set([...holeCards, ...boardCards].map(c => `${c.rank}${c.suit}`));
  const deck = createDeck().filter(c => !knownCards.has(`${c.rank}${c.suit}`));
  
  const currentEval = evaluateHand(holeCards, boardCards);
  if (!currentEval) return [];
  
  const outs: Card[] = [];
  
  for (const card of deck) {
    const nextBoard = [...boardCards, card];
    const newEval = evaluateHand(holeCards, nextBoard);
    if (newEval && newEval.handRank > currentEval.handRank) {
      outs.push(card);
    }
  }
  
  return outs;
}
