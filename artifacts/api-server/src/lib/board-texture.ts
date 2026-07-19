/**
 * Board Texture Analyzer — Phase 6
 *
 * Classifies the flop/turn/river and generates actionable strategy notes
 * based on:
 *   • Flush draw danger (2+ same suit = draw present, 3 = monotone)
 *   • Straight draw danger (connected cards within 5 ranks)
 *   • Paired board (one rank appears twice)
 *   • Board height (A/K high vs low rag boards)
 *   • Who "connects" — hero's hole cards vs the board
 *
 * The output shapes:
 *   • C-bet interpretation: what villain's c-bet means on this board
 *   • Hero response: how to react given our hand vs this texture
 *   • Telegram line: compact Russian summary
 */

import type { Card, Rank } from './poker';

// ── Types ─────────────────────────────────────────────────────────────────────

export type WetnessLevel =
  | 'bone_dry'   // rainbow, disconnected, no draws possible
  | 'dry'        // very few draws, low connectivity
  | 'moderate'   // one draw type present
  | 'wet'        // multiple draws, connected
  | 'very_wet'   // coordinated + flush draw
  | 'monotone';  // all same suit — flush already possible

export interface BoardTexture {
  /** Raw score 0–10 (higher = more draws/danger) */
  wetnessScore: number;
  wetness: WetnessLevel;
  /** Board label for display */
  label: string;

  // ── Draw flags ────────────────────────────────────────────────────────────
  isMonotone: boolean;       // 3+ same suit on flop, or 4+ on turn
  hasFlushDraw: boolean;     // 2 of same suit on flop
  hasOESD: boolean;          // open-ended straight draw on board
  hasGutshot: boolean;       // gutshot straight draw on board
  isPaired: boolean;         // board has a paired rank
  isTripped: boolean;        // board has trips (rare)
  isDoublePaired: boolean;   // board has two different pairs

  // ── Height ────────────────────────────────────────────────────────────────
  highCard: Rank;
  isHighBoard: boolean;      // highest board card >= Jack
  isLowBoard: boolean;       // highest board card <= 9

  // ── Range connection ──────────────────────────────────────────────────────
  /** How well hero's hole cards connect (0–3: none/weak/ok/strong) */
  heroConnection: 0 | 1 | 2 | 3;
  heroConnectionNote: string;

  // ── Strategy notes ────────────────────────────────────────────────────────
  /** What villain's c-bet/bet means on this board */
  cbetInterpretation: string;
  /** How hero should respond on this texture */
  heroStrategyNote: string;
  /** Short Telegram line */
  telegramLine: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function suitCounts(cards: Card[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const c of cards) m[c.suit] = (m[c.suit] ?? 0) + 1;
  return m;
}

function rankCounts(cards: Card[]): Record<number, number> {
  const m: Record<number, number> = {};
  for (const c of cards) m[c.rank] = (m[c.rank] ?? 0) + 1;
  return m;
}

/** True if sorted ranks form an open-ended straight draw (4 to a straight, 2 ends open) */
function hasOESDOnBoard(ranks: number[]): boolean {
  const sorted = [...new Set(ranks)].sort((a, b) => a - b);
  for (let i = 0; i <= sorted.length - 2; i++) {
    // Check any two distinct board ranks as anchors for a 4-straight
    for (let j = i + 1; j < sorted.length; j++) {
      const span = sorted[j] - sorted[i];
      if (span <= 3) {
        // These two cards are within 3 of each other — a straight draw can connect them
        // OESD: need exactly 4 consecutive ranks with 2 open ends
        const lo = sorted[i] - (3 - span);
        const hi = sorted[j] + (3 - span);
        if (lo >= 2 && hi <= 14) return true;
      }
    }
  }
  return false;
}

function hasGutshotOnBoard(ranks: number[]): boolean {
  const unique = [...new Set(ranks)].sort((a, b) => a - b);
  // Look for any 4-card window (span of 4) that contains at least 2 board cards but has a gap
  for (let low = 2; low <= 11; low++) {
    const window = [low, low + 1, low + 2, low + 3, low + 4];
    const hits = window.filter(r => unique.includes(r)).length;
    const outs = window.filter(r => !unique.includes(r)).length;
    if (hits >= 2 && outs === 1) return true; // exactly one gap → gutshot possible
  }
  return false;
}

// ── Hero connection scoring ───────────────────────────────────────────────────

function scoreHeroConnection(hole: Card[], board: Card[]): { score: 0 | 1 | 2 | 3; note: string } {
  if (hole.length < 2 || board.length === 0) {
    return { score: 0, note: '' };
  }

  const boardRanks = new Set(board.map(c => c.rank));
  const boardSuits = board.map(c => c.suit);

  let score = 0;
  const notes: string[] = [];

  // Pair/trips on board with hole card
  for (const h of hole) {
    if (boardRanks.has(h.rank)) {
      score += 2;
      notes.push('пара/трипс с доской');
      break;
    }
  }

  // Flush draw with hole cards
  const suitMap: Record<string, number> = {};
  for (const c of board) suitMap[c.suit] = (suitMap[c.suit] ?? 0) + 1;
  for (const h of hole) {
    if ((suitMap[h.suit] ?? 0) >= 2) {
      score += 1;
      notes.push('флеш-дро');
      break;
    }
  }

  // Straight draw with hole cards (at least one hole card within 4 ranks of 2 board cards)
  const allRanks = [...board.map(c => c.rank), ...hole.map(c => c.rank)];
  const uniqueAll = [...new Set(allRanks)].sort((a, b) => a - b);
  let straightDraw = false;
  for (let i = 0; i < uniqueAll.length - 1; i++) {
    if (uniqueAll[i + 1] - uniqueAll[i] <= 4) {
      // Check if at least one hole card contributes to this stretch
      const holeRanks = new Set(hole.map(c => c.rank));
      if (holeRanks.has(uniqueAll[i]) || holeRanks.has(uniqueAll[i + 1])) {
        straightDraw = true;
        break;
      }
    }
  }
  if (straightDraw) {
    score += 1;
    notes.push('стрит-дро');
  }

  const clampedScore = Math.min(3, score) as 0 | 1 | 2 | 3;
  const note = notes.length > 0 ? `Рука подключена: ${notes.join(', ')}` : 'Рука не подключена к доске';

  return { score: clampedScore, note };
}

// ── Wetness scoring ───────────────────────────────────────────────────────────

function computeWetness(
  flushDraw: boolean,
  monotone: boolean,
  oesd: boolean,
  gutshot: boolean,
  paired: boolean,
  highBoard: boolean,
): { score: number; level: WetnessLevel } {
  if (monotone) return { score: 10, level: 'monotone' };

  let score = 0;
  if (flushDraw) score += 4;
  if (oesd)      score += 3;
  if (gutshot)   score += 2;
  if (highBoard) score += 1;
  if (paired)    score -= 1; // paired boards reduce draw equity

  score = Math.max(0, Math.min(9, score));

  const level: WetnessLevel =
    score >= 7 ? 'very_wet' :
    score >= 5 ? 'wet' :
    score >= 3 ? 'moderate' :
    score >= 1 ? 'dry' :
    'bone_dry';

  return { score, level };
}

// ── C-bet interpretation ──────────────────────────────────────────────────────

function getCbetInterpretation(
  wetness: WetnessLevel,
  paired: boolean,
  highBoard: boolean,
  betSizePct: number | null,
): string {
  if (wetness === 'monotone') {
    return 'На монотонной доске: чек = часто дро. Бет = сделанная рука или блеф на пропуске. Чек-рейз = как правило натс/дро.';
  }
  if (wetness === 'very_wet' || wetness === 'wet') {
    return 'Влажная доска: C-бет — часто блеф или полублеф с дро. Чек-рейз = монстр или нат-дро. Не фолдуй с хорошим дро.';
  }
  if (paired) {
    return 'Спаренная доска: блефы более эффективны (он часто пропустил). Его рейз/чек-рейз = трипс/фулл-хаус.';
  }
  if (wetness === 'bone_dry' || wetness === 'dry') {
    return highBoard
      ? 'Сухая высокая доска: C-бет стандартен. Его чек = слабость. Атакуй терн.'
      : 'Сухая низкая доска: C-бет = обычно топ-пара+. Его чек = воздух или slow-play монстра.';
  }
  return 'Умеренная доска: C-бет — вэлью или полублеф. Читай бай-сайзинг.';
}

function getHeroStrategyNote(
  wetness: WetnessLevel,
  heroConnection: 0 | 1 | 2 | 3,
  paired: boolean,
  highBoard: boolean,
): string {
  if (heroConnection >= 3) {
    return 'Рука сильно подключена. Бетируй для вэлью, не замедляй.';
  }
  if (heroConnection === 2) {
    return wetness === 'wet' || wetness === 'very_wet'
      ? 'Полублеф-дро или пара: бетируй с напором, защищай эквити.'
      : 'Средняя сила руки. Вэлью-бет, но будь готов к фолду при рейзе.';
  }
  if (heroConnection === 1) {
    return wetness === 'bone_dry' || wetness === 'dry'
      ? 'Рука не подключена на сухой доске. Блеф возможен, но осторожно.'
      : 'Слабое подключение на влажной доске. Осторожно — у оппонента дро.';
  }
  // score 0 — no connection
  if (wetness === 'bone_dry') return 'Нет подключения. Блеф рабочий на сухой доске — мало кто попал.';
  if (wetness === 'monotone') return 'Нет флеш-дро. Монотонная доска опасна — у оппонента часто дро или уже флеш.';
  return 'Нет подключения. Фолд под давлением. Блеф только с пропуском у оппонента.';
}

// ── Wetness label ─────────────────────────────────────────────────────────────

const WETNESS_LABEL: Record<WetnessLevel, string> = {
  bone_dry: '🏜️ Сухая доска',
  dry:      '🟤 Относительно сухая',
  moderate: '🟡 Умеренная',
  wet:      '🌊 Влажная',
  very_wet: '🌊🌊 Очень влажная',
  monotone: '🔵 Монотонная (флеш возможен)',
};

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Analyze board texture and generate strategy notes.
 *
 * @param board      3–5 board cards
 * @param hole       Hero's 2 hole cards (for connection analysis)
 * @param betSizePct Villain bet as % of pot (null = unknown)
 */
export function getBoardTexture(
  board: Card[],
  hole: Card[] = [],
  betSizePct: number | null = null,
): BoardTexture | null {
  if (board.length < 3) return null;

  const ranks = board.map(c => c.rank);
  const sc = suitCounts(board);
  const rc = rankCounts(board);

  // ── Suit analysis ─────────────────────────────────────────────────────────
  const maxSuitCount = Math.max(...Object.values(sc));
  const isMonotone   = maxSuitCount >= 3 && board.length === 3
                    || maxSuitCount >= 4;
  const hasFlushDraw = !isMonotone && maxSuitCount >= 2;

  // ── Straight draw analysis ────────────────────────────────────────────────
  const uniqueRanks = [...new Set(ranks)];
  const hasOESD    = hasOESDOnBoard(uniqueRanks);
  const hasGutshot = !hasOESD && hasGutshotOnBoard(uniqueRanks);

  // ── Pair analysis ─────────────────────────────────────────────────────────
  const rankCountVals = Object.values(rc);
  const isPaired       = rankCountVals.some(v => v === 2);
  const isTripped      = rankCountVals.some(v => v === 3);
  const isDoublePaired = rankCountVals.filter(v => v === 2).length === 2;

  // ── Height ────────────────────────────────────────────────────────────────
  const highCard   = Math.max(...ranks) as Rank;
  const isHighBoard = highCard >= 11; // J or higher
  const isLowBoard  = highCard <= 9;

  // ── Wetness ───────────────────────────────────────────────────────────────
  const { score: wetnessScore, level: wetness } = computeWetness(
    hasFlushDraw, isMonotone, hasOESD, hasGutshot, isPaired, isHighBoard
  );

  // ── Hero connection ───────────────────────────────────────────────────────
  const { score: heroConnection, note: heroConnectionNote } =
    scoreHeroConnection(hole, board);

  // ── Strategy notes ────────────────────────────────────────────────────────
  const cbetInterpretation = getCbetInterpretation(wetness, isPaired, isHighBoard, betSizePct);
  const heroStrategyNote   = getHeroStrategyNote(wetness, heroConnection, isPaired, isHighBoard);

  // ── Compact Telegram line ─────────────────────────────────────────────────
  const drawParts: string[] = [];
  if (isMonotone)    drawParts.push('флеш возможен');
  else if (hasFlushDraw) drawParts.push('флеш-дро');
  if (hasOESD)       drawParts.push('стрит-дро (OESD)');
  else if (hasGutshot) drawParts.push('гатшот');
  if (isTripped)     drawParts.push('трипс на доске');
  else if (isDoublePaired) drawParts.push('две пары на доске');
  else if (isPaired) drawParts.push('спаренная');

  const heightStr = isHighBoard ? 'высокая' : isLowBoard ? 'низкая' : 'средняя';
  const drawStr   = drawParts.length > 0 ? ` · ${drawParts.join(', ')}` : '';
  const telegramLine = `${WETNESS_LABEL[wetness]} (${heightStr})${drawStr}`;

  return {
    wetnessScore,
    wetness,
    label: WETNESS_LABEL[wetness],
    isMonotone,
    hasFlushDraw,
    hasOESD,
    hasGutshot,
    isPaired,
    isTripped,
    isDoublePaired,
    highCard,
    isHighBoard,
    isLowBoard,
    heroConnection,
    heroConnectionNote,
    cbetInterpretation,
    heroStrategyNote,
    telegramLine,
  };
}
