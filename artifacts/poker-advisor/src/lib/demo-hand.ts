/** Synthetic observations for exercising the calculator without a poker account.
 * Actions and hidden-player status are invented, not reconstructed from a video.
 * Only the final visible cards are inspired by the supplied TON screenshot. */
export interface DemoFrame {
  id: string;
  title: string;
  note: string;
  holeCards: string[];
  boardCards: string[];
  opponents: { active: boolean; cards: string[] }[];
  calculable: boolean;
}

export const DEMO_HAND: readonly DemoFrame[] = [
  {
    id: 'preflop', title: 'Префлоп', note: 'Два соперника в раздаче. Их карты пока скрыты.',
    holeCards: ['7c', '9h'], boardCards: [],
    opponents: [{ active: true, cards: [] }, { active: true, cards: [] }], calculable: true,
  },
  {
    id: 'dealing', title: 'Анимация флопа', note: 'Пока видны две карты борда. Старый расчёт скрывается до завершения анимации.',
    holeCards: ['7c', '9h'], boardCards: ['9c', '4c'],
    opponents: [{ active: true, cards: [] }, { active: true, cards: [] }], calculable: false,
  },
  {
    id: 'flop', title: 'Флоп', note: 'Три общие карты подтверждены. У героя пара девяток.',
    holeCards: ['7c', '9h'], boardCards: ['9c', '4c', '2d'],
    opponents: [{ active: true, cards: [] }, { active: true, cards: [] }], calculable: true,
  },
  {
    id: 'fold', title: 'Соперник сбросил карты', note: 'В расчёте остаётся один соперник. Его карты ещё неизвестны.',
    holeCards: ['7c', '9h'], boardCards: ['9c', '4c', '2d'],
    opponents: [{ active: true, cards: [] }, { active: false, cards: [] }], calculable: true,
  },
  {
    id: 'turn', title: 'Тёрн', note: 'На борде появилась четвёртая карта.',
    holeCards: ['7c', '9h'], boardCards: ['9c', '4c', '2d', '3d'],
    opponents: [{ active: true, cards: [] }, { active: false, cards: [] }], calculable: true,
  },
  {
    id: 'river', title: 'Ривер', note: 'Борд полный. Пока рука соперника скрыта, перебираются допустимые руки.',
    holeCards: ['7c', '9h'], boardCards: ['9c', '4c', '2d', '3d', 'Kd'],
    opponents: [{ active: true, cards: [] }, { active: false, cards: [] }], calculable: true,
  },
  {
    id: 'showdown', title: 'Вскрытие', note: 'Соперник открыл 4♠ 4♦. Его тройка четвёрок побеждает пару девяток.',
    holeCards: ['7c', '9h'], boardCards: ['9c', '4c', '2d', '3d', 'Kd'],
    opponents: [{ active: true, cards: ['4s', '4d'] }, { active: false, cards: [] }], calculable: true,
  },
  {
    id: 'ended', title: 'Раздача завершена', note: 'Карты убраны. Вероятность завершённой раздачи больше не показывается.',
    holeCards: [], boardCards: [],
    opponents: [{ active: true, cards: [] }, { active: true, cards: [] }], calculable: false,
  },
];
