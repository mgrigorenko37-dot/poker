/**
 * SPR (Stack-to-Pot Ratio) Advisor — Phase 5
 *
 * SPR = effective stack / current pot
 *
 * SPR tells you how committed you are to the pot and what hand strength
 * justifies putting in the rest of your stack.
 *
 * Classic thresholds (Ed Miller / GTO standard):
 *   SPR < 2   → пот-коммитед с ЛЮБОЙ парой+
 *   SPR 2–4   → шов с топ-парой (хороший кикер)+
 *   SPR 4–10  → нужны две пары+ для шова
 *   SPR 10–20 → нужны сет+ или мощное дро
 *   SPR > 20  → натс или nut-draw; фолд на рейз без натса
 *
 * Preflop: stack depth in BBs determines open sizing and 3bet strategy.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type SPRZone =
  | 'critical'   // SPR < 1   — already committed
  | 'shallow'    // SPR 1–2   — top pair+ is a stack-off
  | 'low'        // SPR 2–4   — top pair good kicker is a shove
  | 'medium'     // SPR 4–10  — two pair+ to shove
  | 'high'       // SPR 10–20 — set+ or nutdraw
  | 'deep';      // SPR > 20  — nuts or fold to aggression

export type StackDepth =
  | 'jam'        // < 15 BB — push/fold territory
  | 'short'      // 15–25 BB — limited postflop
  | 'standard'   // 25–60 BB — normal
  | 'deep';      // > 60 BB  — SPR > 20 likely; deep stack play

export interface SPRAdvice {
  spr: number;
  zone: SPRZone;
  /** One-line commitment label, e.g. "топ-пара = шов" */
  commitment: string;
  /** Full strategy note for Telegram */
  strategy: string;
  /** Emoji indicator */
  emoji: string;
  /** Stack depth category (preflop context) */
  stackDepth: StackDepth | null;
  /** Effective stack in BBs (null when unknown) */
  stackBBs: number | null;
}

// ── Stack depth (preflop) ─────────────────────────────────────────────────────

function getStackDepth(stackBBs: number): StackDepth {
  if (stackBBs < 15) return 'jam';
  if (stackBBs < 25) return 'short';
  if (stackBBs < 60) return 'standard';
  return 'deep';
}

function stackDepthAdvice(depth: StackDepth, stackBBs: number): string {
  switch (depth) {
    case 'jam':
      return `Стэк ${stackBBs}BB — зона пуш/фолд. Преф: шов с AJ+, 77+. Нет постфлоп-игры.`;
    case 'short':
      return `Стэк ${stackBBs}BB — короткий. Преф: пуш с AQ+, TT+. Постфлоп: шов с топ-парой.`;
    case 'standard':
      return `Стэк ${stackBBs}BB — стандарт. Нормальный GTO-диапазон.`;
    case 'deep':
      return `Стэк ${stackBBs}BB — глубокий. SPR будет высоким — нужны натс или nut-draw для шова.`;
  }
}

// ── SPR zone classification ───────────────────────────────────────────────────

function classifyZone(spr: number): SPRZone {
  if (spr < 1)  return 'critical';
  if (spr < 2)  return 'shallow';
  if (spr < 4)  return 'low';
  if (spr < 10) return 'medium';
  if (spr < 20) return 'high';
  return 'deep';
}

interface ZoneProfile {
  commitment: string;
  strategy: string;
  emoji: string;
}

function getZoneProfile(zone: SPRZone, spr: number): ZoneProfile {
  const sprStr = spr.toFixed(1);
  switch (zone) {
    case 'critical':
      return {
        emoji: '🔥',
        commitment: 'Уже коммитед — шов с любой парой',
        strategy: `SPR ${sprStr} — ты уже всё выиграл или проиграл. Шов с любой парой+, дро, overcards. Не фолдуй ничего разумного.`,
      };
    case 'shallow':
      return {
        emoji: '🟠',
        commitment: 'Топ-пара = коммит',
        strategy: `SPR ${sprStr} — пот-коммитед. Топ-пара с любым кикером — шов. При рейзе: пуш или фолд, нет колла. Защищайся широко.`,
      };
    case 'low':
      return {
        emoji: '🟡',
        commitment: 'Топ-пара (хороший кикер) = шов',
        strategy: `SPR ${sprStr} — топ-пара с хорошим кикером или лучше оправдывает шов. Средняя пара — осторожно. При рейзе — топ-пара достаточна.`,
      };
    case 'medium':
      return {
        emoji: '🟢',
        commitment: '2 пары+ = шов',
        strategy: `SPR ${sprStr} — нужны две пары или лучше для комфортного шова. Топ-пару играй вэлью но осторожно. Замедляй пот с топ-парой при рейзе.`,
      };
    case 'high':
      return {
        emoji: '🔵',
        commitment: 'Сет+ или nut-draw = шов',
        strategy: `SPR ${sprStr} — нужны сет, стрит, флеш или nut-draw для шова. Топ-пара — пот-контроль. Фолдуй топ-пару под агрессией на позднем улице.`,
      };
    case 'deep':
      return {
        emoji: '🟣',
        commitment: 'Натс или фолд на рейз',
        strategy: `SPR ${sprStr} — глубокие стэки. Только натс или nut-flush-draw оправдывают большие банки. Топ-пара — тонкий вэлью, никакого шова. Фолд топ-пары под 3-бет на ривере.`,
      };
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Calculate SPR and generate advice.
 *
 * @param stackSize  Effective stack in chips (same unit as potSize). null = unknown.
 * @param potSize    Current pot. 0 = unknown.
 * @param bbSize     Big blind size (to estimate stackBBs). null = unknown.
 * @param isPreflop  Whether we're on the preflop (SPR not yet meaningful → use stack depth).
 */
export function getSPRAdvice(
  stackSize: number | null,
  potSize: number,
  bbSize: number | null = null,
  isPreflop = false,
): SPRAdvice | null {
  // Can't compute SPR without stack
  if (stackSize === null || stackSize <= 0) return null;

  // Estimate BB size: use provided, or try to infer from pot (rough)
  const bb = bbSize ?? (potSize > 0 ? null : null);

  // stackBBs estimate
  const stackBBs = bb && bb > 0 ? Math.round(stackSize / bb) : null;
  const stackDepth: StackDepth | null = stackBBs ? getStackDepth(stackBBs) : null;

  // Preflop: SPR is about stack depth, not pot ratio
  if (isPreflop) {
    if (!stackBBs) return null;
    const depth = getStackDepth(stackBBs);
    return {
      spr: 0,  // not meaningful preflop
      zone: depth === 'jam' ? 'critical' : depth === 'short' ? 'shallow' : 'medium',
      commitment: depth === 'jam' ? 'Зона пуш/фолд' : `Стэк ${stackBBs}BB`,
      strategy: stackDepthAdvice(depth, stackBBs),
      emoji: depth === 'jam' ? '🔥' : depth === 'short' ? '🟠' : '🟢',
      stackDepth: depth,
      stackBBs,
    };
  }

  // Postflop: need a real pot
  if (potSize <= 0) return null;

  const spr = Math.round((stackSize / potSize) * 10) / 10;
  const zone = classifyZone(spr);
  const profile = getZoneProfile(zone, spr);

  return {
    spr,
    zone,
    commitment: profile.commitment,
    strategy: profile.strategy,
    emoji: profile.emoji,
    stackDepth,
    stackBBs,
  };
}
