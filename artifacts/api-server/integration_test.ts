/**
 * integration_test.ts
 *
 * Полная симуляция покерного пайплайна без изменения существующих файлов.
 * Имитирует данные, которые приходят от Vision (Gemini-скан), и прогоняет их
 * через все модули в том же порядке, что и /api/vision/scan.
 *
 * Сценарий:
 *   Hero: J♥ 9♥  — топ-пара (девятки) с J-кикером
 *   Board: 9♦ 5♣ 2♠ — сухая низкая доска
 *   Pot: 40,  Hero stack: 60 (эффективный),  BB: 2
 *   Villain: Нит (VPIP ~12%, PFR ~8%, AF ~0.8)
 *   Action: Villain делает C-bet 20 (50% пота)
 *
 * Интересный вопрос: SPR 1.5 говорит "топ-пара = коммит",
 * но Нит на сухой доске даёт очень тайтый диапазон.
 * Пайплайн должен разрешить это противоречие через equity.
 */

import { parseCard, runMonteCarloSim } from './src/lib/poker.js';
import { getSPRAdvice }                from './src/lib/spr-advice.js';
import { getBoardTexture }             from './src/lib/board-texture.js';
import { narrowVillainRange }          from './src/lib/range-narrower.js';
import { getFullAdvice }               from './src/lib/poker-gto.js';
import { buildTelegramText }           from './src/lib/telegram-format.js';
import {
  resetOpponentProfile,
  commitHandToProfile,
  getOpponentSummary,
} from './src/lib/opponent-profile.js';
import type { VillainAction } from './src/lib/hand-state.js';

// ─────────────────────────────────────────────────────────────────────────────
// ШАГ 0: Сбросить состояние сессии (как при старте нового сеанса ScreenScan)
// ─────────────────────────────────────────────────────────────────────────────
resetOpponentProfile();

// ─────────────────────────────────────────────────────────────────────────────
// ШАГ 1: Засеять профиль оппонента (16 рук, имитация Нита)
//
// Нит: заходит в банк редко, в основном фолдирует.
// Когда играет — рейзит с сильными руками, пассивен постфлопе.
// ─────────────────────────────────────────────────────────────────────────────

// 12 рук — просто фолд на префлопе (нет VPIP, нет PFR)
const foldedPreflop: VillainAction[] = [
  { street: 'preflop', description: 'фолд', potSize: 0, betToCall: 0 },
];
for (let i = 0; i < 12; i++) {
  commitHandToProfile(foldedPreflop);
}

// 1 рука — рейз на префлопе (VPIP + PFR), C-bet на флопе, чек тёрн
// → cbet chance: +1 opportunity, +1 count
// → postflop: 1 bet (флоп), 1 call (тёрн)
commitHandToProfile([
  { street: 'preflop', description: 'рейз до 6', potSize: 0,  betToCall: 6  }, // PFR
  { street: 'flop',    description: 'бет 60%',   potSize: 30, betToCall: 20 }, // cbet
  { street: 'turn',    description: 'чек',        potSize: 70, betToCall: 0  }, // passive
]);

// 1 рука — рейз на префлопе (VPIP + PFR), нет C-bet (чек флоп)
// → cbet chance: +1 opportunity, +0 count → cbet% снижается
// → postflop: 0 bets, 1 call (флоп чек)
commitHandToProfile([
  { street: 'preflop', description: 'рейз до 4', potSize: 0,  betToCall: 4  }, // PFR
  { street: 'flop',    description: 'чек',        potSize: 20, betToCall: 0  }, // no cbet
]);

// 1 рука — лимп (VPIP, нет PFR), пассивный постфлоп
// → foldToCbet: +1 opportunity. флоп чек → +1 count (считается как fold-to-cbet)
// → postflop: 0 bets, 3 calls
commitHandToProfile([
  { street: 'preflop', description: 'лимп',  potSize: 2,  betToCall: 2 }, // VPIP (лимп)
  { street: 'flop',    description: 'чек',   potSize: 10, betToCall: 0 }, // passive
  { street: 'turn',    description: 'чек',   potSize: 10, betToCall: 0 },
  { street: 'river',   description: 'чек',   potSize: 10, betToCall: 0 },
]);

// Показываем что засеяли
const seededProfile = getOpponentSummary();
console.log('═══════════════════════════════════════════════════════════');
console.log('  INTEGRATION TEST — Покерный пайплайн end-to-end');
console.log('═══════════════════════════════════════════════════════════');
console.log('\n[ШАГ 1] Засеянный профиль оппонента (сессионный HUD):');
if (seededProfile) {
  console.log(`  Рук сыграно : ${seededProfile.handsPlayed}`);
  console.log(`  VPIP        : ${seededProfile.vpip}%  (цель ≈12%)`);
  console.log(`  PFR         : ${seededProfile.pfr}%   (цель ≈8%)`);
  console.log(`  AF          : ${seededProfile.af}     (цель ≈0.8)`);
  console.log(`  C-bet%      : ${seededProfile.cbet}%  (цель ≈60%)`);
  console.log(`  FtC-bet%    : ${seededProfile.ftCbet}%`);
  console.log(`  Тип         : ${seededProfile.playerType}`);
  console.log(`  Confidence  : ${seededProfile.confidence}`);
} else {
  console.log('  Профиль не накоплен (недостаточно рук)');
}

// ─────────────────────────────────────────────────────────────────────────────
// ШАГ 2: Входные данные от Vision (то, что пришло бы от Gemini-скана)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[ШАГ 2] Входные данные (мок Vision):');

const HERO_CARDS_STR  = ['Jh', '9h'];  // J♥ 9♥
const BOARD_CARDS_STR = ['9d', '5c', '2s'];  // 9♦ 5♣ 2♠

const POT_SIZE      = 40;
const VILLAIN_BET   = 20;   // C-bet 50% пота
const HERO_STACK    = 60;   // эффективный стэк (меньший из двух)
const BB_SIZE       = 2;
const PLAYERS       = 2;
const POSITION      = 'BTN';
const IS_PREFLOP    = false;

console.log(`  Карты героя  : J♥ 9♥`);
console.log(`  Доска        : 9♦ 5♣ 2♠`);
console.log(`  Пот          : ${POT_SIZE}`);
console.log(`  C-bet вилена : ${VILLAIN_BET}  (${Math.round(VILLAIN_BET / POT_SIZE * 100)}% пота)`);
console.log(`  Стэк героя   : ${HERO_STACK}`);
console.log(`  BB           : ${BB_SIZE}`);

// Парсим карты в формат {rank, suit}
const hole  = HERO_CARDS_STR.map(parseCard);
const board = BOARD_CARDS_STR.map(parseCard);

// ─────────────────────────────────────────────────────────────────────────────
// ШАГ 3: SPR — структурный анализ
// ─────────────────────────────────────────────────────────────────────────────
const sprAdvice = getSPRAdvice(HERO_STACK, POT_SIZE, BB_SIZE, IS_PREFLOP);

console.log('\n[ШАГ 3] SPR-анализ:');
if (sprAdvice) {
  console.log(`  SPR        : ${sprAdvice.spr}  (${sprAdvice.zone})`);
  console.log(`  Стэк       : ${sprAdvice.stackBBs}BB`);
  console.log(`  Вывод      : ${sprAdvice.emoji} ${sprAdvice.commitment}`);
  console.log(`  Стратегия  : ${sprAdvice.strategy}`);
} else {
  console.log('  SPR не вычислен (нет данных о стэке)');
}

// ─────────────────────────────────────────────────────────────────────────────
// ШАГ 4: Текстура доски
// ─────────────────────────────────────────────────────────────────────────────
const betSizePct    = Math.round((VILLAIN_BET / POT_SIZE) * 100);
const boardTexture  = getBoardTexture(board, hole, betSizePct);

console.log('\n[ШАГ 4] Текстура доски:');
if (boardTexture) {
  console.log(`  Влажность       : ${boardTexture.label}`);
  console.log(`  Flush draw      : ${boardTexture.hasFlushDraw}`);
  console.log(`  OESD            : ${boardTexture.hasOESD}`);
  console.log(`  Спаренная       : ${boardTexture.isPaired}`);
  console.log(`  Высокая доска   : ${boardTexture.isHighBoard}  (низкая: ${boardTexture.isLowBoard})`);
  console.log(`  Hero connection : ${boardTexture.heroConnection}/3  — ${boardTexture.heroConnectionNote}`);
  console.log(`  C-bet значит    : ${boardTexture.cbetInterpretation}`);
  console.log(`  Совет герою     : ${boardTexture.heroStrategyNote}`);
} else {
  console.log('  Текстура не вычислена (мало карт на борде)');
}

// ─────────────────────────────────────────────────────────────────────────────
// ШАГ 5: Сужение диапазона Нита (range-narrower использует засеянный профиль)
//
// Текущая рука: Нит рейзит префлоп (PFR), делает C-bet на флопе.
// Именно эти действия записываем в actionsThisHand.
// ─────────────────────────────────────────────────────────────────────────────
const actionsThisHand: VillainAction[] = [
  {
    street: 'preflop',
    description: 'рейз до 6',
    potSize: 4,
    betToCall: 6,
  },
  {
    street: 'flop',
    description: `бет ${betSizePct}% пота`,
    potSize: POT_SIZE,
    betToCall: VILLAIN_BET,
  },
];

const narrowed = narrowVillainRange(actionsThisHand, 'flop');

console.log('\n[ШАГ 5] Диапазон вилена (после profile-aware сужения):');
console.log(`  Ширина диапазона : ≈${narrowed.rangePct}% рук`);
console.log(`  Описание         : ${narrowed.description}`);
console.log(`  Confidence       : ${narrowed.confidence}`);
console.log(`  Тенденция        : ${narrowed.tendencyNote}`);
if (narrowed.profileNote) {
  console.log(`  Profile note     : ${narrowed.profileNote}`);
}
console.log(`  Кол-во hand keys : ${narrowed.rangeKeys.length} (для Монте-Карло)`);

// ─────────────────────────────────────────────────────────────────────────────
// ШАГ 6: Монте-Карло с суженным диапазоном Нита
// ─────────────────────────────────────────────────────────────────────────────
const sim = runMonteCarloSim(hole, board, PLAYERS, 2000, narrowed.rangeKeys);

console.log('\n[ШАГ 6] Монте-Карло (2000 итераций):');
console.log(`  Win probability  : ${Math.round(sim.winProb * 100)}%`);
console.log(`  Tie probability  : ${Math.round(sim.tieProb * 100)}%`);
console.log(`  Range vs Range   : ${sim.usedRangeVsRange}`);
console.log(`  Villain range%   : ${sim.villainRangePct}%`);

const potOdds = VILLAIN_BET / (POT_SIZE + VILLAIN_BET);
const heroEquity = sim.winProb;
console.log(`\n  Пот-оддс для колла : ${Math.round(potOdds * 100)}%  (нужно equity > ${Math.round(potOdds * 100)}%)`);
console.log(`  Equity героя       : ${Math.round(heroEquity * 100)}%`);
console.log(`  Математика         : ${heroEquity > potOdds ? '✅ КОЛЛ прибылен' : '❌ ФОЛД (недостаточно equity)'}`);

// ─────────────────────────────────────────────────────────────────────────────
// ШАГ 7: GTO-движок → финальный совет
// ─────────────────────────────────────────────────────────────────────────────
const advice = getFullAdvice(
  hole,
  board,
  POT_SIZE,
  VILLAIN_BET,
  PLAYERS,
  POSITION,
  sim,
  1.0,
  '',
);

console.log('\n[ШАГ 7] GTO-совет:');
console.log(`  Action      : ${advice.displayText ?? advice.action}`);
console.log(`  Sizing      : ${advice.sizing ?? '—'}`);
console.log(`  Hand name   : ${advice.handName ?? '—'}`);
console.log(`  EV          : ${advice.ev !== null ? advice.ev.toFixed(2) : '—'}`);
if (advice.draws) {
  const d = advice.draws;
  console.log(`  Draws       : fd=${d.flushDraw}, oesd=${d.oesd}, gs=${d.gutshot}, outs=${d.totalOuts}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ШАГ 8: Итоговое Telegram-сообщение
// ─────────────────────────────────────────────────────────────────────────────
const telegramPayload = {
  holeCards:   HERO_CARDS_STR,
  boardCards:  BOARD_CARDS_STR,
  displayText: advice.displayText,
  action:      advice.action,
  sizing:      advice.sizing,
  equity:      sim.winProb,
  potOdds:     advice.potOdds,
  position:    POSITION,
  players:     PLAYERS,
  potSize:     POT_SIZE,
  betToCall:   VILLAIN_BET,
  draws:       advice.draws,
  details:     advice.details,
  handHistory: {
    actions: actionsThisHand.map(a => ({
      street:      a.street,
      description: a.description,
      potSize:     a.potSize,
      betToCall:   a.betToCall,
    })),
  },
  villainRange: {
    description:  narrowed.description,
    categories:   narrowed.categories,
    confidence:   narrowed.confidence,
    tendencyNote: narrowed.tendencyNote,
    rangePct:     narrowed.rangePct,
    profileNote:  narrowed.profileNote,
  },
  opponentProfile: seededProfile,
  sprAdvice: sprAdvice ? {
    spr:        sprAdvice.spr,
    zone:       sprAdvice.zone,
    commitment: sprAdvice.commitment,
    strategy:   sprAdvice.strategy,
    emoji:      sprAdvice.emoji,
    stackBBs:   sprAdvice.stackBBs,
  } : null,
  boardTexture: boardTexture ? {
    wetness:           boardTexture.wetness,
    label:             boardTexture.label,
    hasFlushDraw:      boardTexture.hasFlushDraw,
    hasOESD:           boardTexture.hasOESD,
    hasGutshot:        boardTexture.hasGutshot,
    isPaired:          boardTexture.isPaired,
    isTripped:         boardTexture.isTripped,
    isHighBoard:       boardTexture.isHighBoard,
    heroConnection:    boardTexture.heroConnection,
    heroConnectionNote:boardTexture.heroConnectionNote,
    cbetInterpretation:boardTexture.cbetInterpretation,
    heroStrategyNote:  boardTexture.heroStrategyNote,
    telegramLine:      boardTexture.telegramLine,
  } : null,
};

const telegramMessage = buildTelegramText(telegramPayload);

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  ИТОГОВОЕ TELEGRAM-СООБЩЕНИЕ (что улетает боту):');
console.log('═══════════════════════════════════════════════════════════');
// Убираем HTML-теги для чистого вывода в консоль
console.log(telegramMessage.replace(/<b>(.*?)<\/b>/g, '$1').replace(/<i>(.*?)<\/i>/g, '$1'));
console.log('═══════════════════════════════════════════════════════════');
console.log('\n[ВЫВОД] Противоречие SPR vs профиль Нита:');
if (sprAdvice) {
  console.log(`  SPR ${sprAdvice.spr} говорит: "${sprAdvice.commitment}"`);
  console.log(`  Профиль Нита сузил диапазон до ≈${narrowed.rangePct}% рук`);
  console.log(`  Equity против этого диапазона: ${Math.round(heroEquity * 100)}%`);
  console.log(`  Пот-оддс: ${Math.round(potOdds * 100)}%`);
  const resolved = heroEquity > potOdds
    ? 'SPR выиграл — equity достаточно, КОЛЛ/ШОВ'
    : 'Профиль Нита выиграл — equity недостаточно, ФОЛД';
  console.log(`  Разрешение: ${resolved}`);
}
