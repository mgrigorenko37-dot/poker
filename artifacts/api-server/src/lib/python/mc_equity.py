"""
mc_equity.py — Этап 1: Python-аналог runMonteCarloSim из poker.ts

Логика и форматы карт полностью совпадают с TypeScript-версией:
  - Rank: 2–14 (int), Suit: 'c'|'d'|'h'|'s' (str)
  - Карта: tuple (rank: int, suit: str)
  - Результат: dict, совместимый с SimulationResult из poker.ts

Запускать напрямую для проверки:
  python mc_equity.py
"""

from __future__ import annotations

import random
import itertools
from typing import Optional

# ---------------------------------------------------------------------------
# Константы
# ---------------------------------------------------------------------------

SUITS = ('c', 'd', 'h', 's')
RANKS = tuple(range(2, 15))  # 2..14

# Маппинг строковых обозначений ранга в int
RANK_CHAR_TO_INT: dict[str, int] = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
    '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
}

HAND_RANK = {
    'HIGH_CARD':       0,
    'PAIR':            1,
    'TWO_PAIR':        2,
    'THREE_OF_A_KIND': 3,
    'STRAIGHT':        4,
    'FLUSH':           5,
    'FULL_HOUSE':      6,
    'FOUR_OF_A_KIND':  7,
    'STRAIGHT_FLUSH':  8,
    'ROYAL_FLUSH':     9,
}

# ---------------------------------------------------------------------------
# Карты
# ---------------------------------------------------------------------------

Card = tuple[int, str]  # (rank, suit)


def make_deck() -> list[Card]:
    return [(r, s) for r in RANKS for s in SUITS]


def parse_card(s: str) -> Card:
    """'Ah' → (14, 'h'),  'Tc' → (10, 'c')"""
    rank = RANK_CHAR_TO_INT[s[0].upper()]
    suit = s[1].lower()
    return (rank, suit)


def card_key(c: Card) -> str:
    return f"{c[0]}{c[1]}"


# ---------------------------------------------------------------------------
# Эвалюатор руки (точный аналог evaluate5Cards / evaluateHand из poker.ts)
# ---------------------------------------------------------------------------

def _evaluate5(cards: list[Card]) -> int:
    """Возвращает score (int) для ровно 5 карт. Больший = лучше."""
    sorted_cards = sorted(cards, key=lambda c: c[0], reverse=True)
    ranks = [c[0] for c in sorted_cards]
    suits = [c[1] for c in sorted_cards]

    is_flush = len(set(suits)) == 1

    is_straight = all(ranks[i] - 1 == ranks[i + 1] for i in range(4))
    # Wheel: A-5-4-3-2
    if not is_straight and ranks[0] == 14 and ranks[1:] == [5, 4, 3, 2]:
        is_straight = True
        ranks = [5, 4, 3, 2, 1]  # туз → 1 для оценки
        sorted_cards = [sorted_cards[1], sorted_cards[2],
                        sorted_cards[3], sorted_cards[4], sorted_cards[0]]

    # Подсчёт частот (rank → count)
    from collections import Counter
    cnt = Counter(ranks)
    # Сортируем: сначала по count desc, потом по rank desc
    freqs = sorted(cnt.items(), key=lambda x: (x[1], x[0]), reverse=True)

    top_count = freqs[0][1]
    second_count = freqs[1][1] if len(freqs) > 1 else 0

    if is_flush and is_straight:
        hand_rank = HAND_RANK['ROYAL_FLUSH'] if ranks[0] == 14 else HAND_RANK['STRAIGHT_FLUSH']
    elif top_count == 4:
        hand_rank = HAND_RANK['FOUR_OF_A_KIND']
    elif top_count == 3 and second_count == 2:
        hand_rank = HAND_RANK['FULL_HOUSE']
    elif is_flush:
        hand_rank = HAND_RANK['FLUSH']
    elif is_straight:
        hand_rank = HAND_RANK['STRAIGHT']
    elif top_count == 3:
        hand_rank = HAND_RANK['THREE_OF_A_KIND']
    elif top_count == 2 and second_count == 2:
        hand_rank = HAND_RANK['TWO_PAIR']
    elif top_count == 2:
        hand_rank = HAND_RANK['PAIR']
    else:
        hand_rank = HAND_RANK['HIGH_CARD']

    # Score = hand_rank * 0x100000 + r1*16^4 + r2*16^3 + ... + r5*16^0
    # Карты разложены по частотам (как в TS: пара доминирует над кикером)
    score = hand_rank * 0x100000
    shift = 4  # начинаем с 16^4
    for r, count in freqs:
        for _ in range(count):
            score += r * (16 ** shift)
            shift -= 1

    return score


def evaluate_hand(hole: list[Card], board: list[Card]) -> int:
    """Лучший score из всех комбинаций C(hole+board, 5). 0 если < 5 карт."""
    all_cards = hole + board
    if len(all_cards) < 5:
        return 0
    return max(_evaluate5(list(combo)) for combo in itertools.combinations(all_cards, 5))


# ---------------------------------------------------------------------------
# Диапазоны (аналог expandRangeToCombos из poker.ts)
# ---------------------------------------------------------------------------

def expand_range_to_combos(range_keys: list[str], blocked: list[Card]) -> list[tuple[Card, Card]]:
    """
    Разворачивает список ключей ('AA', 'AKs', 'AKo') в конкретные комбо-пары,
    исключая заблокированные карты.
    """
    blocked_set = set(card_key(c) for c in blocked)
    combos: list[tuple[Card, Card]] = []

    for key in range_keys:
        key = key.strip()
        if len(key) == 2:
            # Пара: 'AA', 'KK' ...
            r = RANK_CHAR_TO_INT.get(key[0].upper())
            if r is None:
                continue
            for s1, s2 in itertools.combinations(SUITS, 2):
                c1: Card = (r, s1)
                c2: Card = (r, s2)
                if card_key(c1) not in blocked_set and card_key(c2) not in blocked_set:
                    combos.append((c1, c2))
        elif len(key) == 3:
            r1 = RANK_CHAR_TO_INT.get(key[0].upper())
            r2 = RANK_CHAR_TO_INT.get(key[1].upper())
            suited = key[2].lower() == 's'
            if r1 is None or r2 is None:
                continue
            if suited:
                for s in SUITS:
                    c1 = (r1, s)
                    c2 = (r2, s)
                    if card_key(c1) not in blocked_set and card_key(c2) not in blocked_set:
                        combos.append((c1, c2))
            else:  # offsuit
                for s1 in SUITS:
                    for s2 in SUITS:
                        if s1 != s2:
                            c1 = (r1, s1)
                            c2 = (r2, s2)
                            if card_key(c1) not in blocked_set and card_key(c2) not in blocked_set:
                                combos.append((c1, c2))

    return combos


# Дефолтный диапазон виллейна постфлоп (~40% рук) — аналог DEFAULT_VILLAIN_RANGE из poker.ts
DEFAULT_VILLAIN_RANGE = [
    'AA','KK','QQ','JJ','TT','99','88','77','66','55',
    'AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s',
    'AKo','AQo','AJo','ATo',
    'KQs','KJs','KTs','K9s',
    'KQo','KJo',
    'QJs','QTs','Q9s',
    'QJo',
    'JTs','J9s',
    'T9s','T8s',
    '98s','97s',
    '87s','86s',
    '76s','75s',
    '65s','64s',
    '54s',
]


def run_monte_carlo(
    hole_cards: list[Card],
    board_cards: list[Card],
    num_players: int = 2,
    iterations: int = 200,
    opponent_range_keys: Optional[list[str]] = None,
) -> dict:
    """
    Аналог runMonteCarloSim из poker.ts.

    Принимает карты как Card = (rank: int, suit: str).
    Возвращает dict:
      wins, losses, ties, total,
      win_prob, tie_prob,
      used_range_vs_range (bool),
      villain_range_pct (float | None)
    """
    empty = dict(wins=0, losses=0, ties=0, total=0,
                 win_prob=0.0, tie_prob=0.0,
                 used_range_vs_range=False, villain_range_pct=None)

    if len(hole_cards) != 2:
        return empty

    known_set = set(card_key(c) for c in hole_cards + board_cards)
    deck = [c for c in make_deck() if card_key(c) not in known_set]

    # Диапазон виллейна
    range_keys = opponent_range_keys
    if range_keys is None and len(board_cards) > 0:
        range_keys = DEFAULT_VILLAIN_RANGE

    range_combos: Optional[list[tuple[Card, Card]]] = None
    villain_range_pct: Optional[float] = None

    if range_keys:
        range_combos = expand_range_to_combos(range_keys, hole_cards + board_cards)
        # Приближённый % диапазона (1326 всего комбо в холдеме)
        villain_range_pct = round(len(range_combos) / 1326 * 100, 1)

    wins = losses = ties = 0

    for _ in range(iterations):
        sim_deck = deck[:]
        random.shuffle(sim_deck)
        idx = 0
        used = set(known_set)

        # Добор борда до 5 карт
        sim_board = list(board_cards)
        while len(sim_board) < 5:
            card = sim_deck[idx]; idx += 1
            sim_board.append(card)
            used.add(card_key(card))

        my_score = evaluate_hand(hole_cards, sim_board)
        best_opp = -1

        # Шафл пула диапазона
        combo_pool: Optional[list[tuple[Card, Card]]] = None
        pool_idx = 0
        if range_combos:
            combo_pool = range_combos[:]
            random.shuffle(combo_pool)

        def next_deck_card() -> Card:
            nonlocal idx
            while idx < len(sim_deck) and card_key(sim_deck[idx]) in used:
                idx += 1
            c = sim_deck[idx]; idx += 1
            used.add(card_key(c))
            return c

        for _ in range(num_players - 1):
            opp_hole: Optional[tuple[Card, Card]] = None

            if combo_pool is not None:
                while pool_idx < len(combo_pool):
                    c1, c2 = combo_pool[pool_idx]; pool_idx += 1
                    if card_key(c1) not in used and card_key(c2) not in used:
                        opp_hole = (c1, c2)
                        used.add(card_key(c1))
                        used.add(card_key(c2))
                        break

            if opp_hole is None:
                opp_hole = (next_deck_card(), next_deck_card())

            opp_score = evaluate_hand(list(opp_hole), sim_board)
            if opp_score > best_opp:
                best_opp = opp_score

        if my_score > best_opp:
            wins += 1
        elif my_score < best_opp:
            losses += 1
        else:
            ties += 1

    return dict(
        wins=wins,
        losses=losses,
        ties=ties,
        total=iterations,
        win_prob=wins / iterations,
        tie_prob=ties / iterations,
        used_range_vs_range=range_combos is not None,
        villain_range_pct=villain_range_pct,
    )


# ---------------------------------------------------------------------------
# Проверка: сравниваем с ожидаемыми значениями
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    import time

    print("=== mc_equity.py — проверка корректности ===\n")

    # Тест 1: AA vs случайные оппоненты префлоп
    hole = [parse_card('Ah'), parse_card('As')]
    board: list[Card] = []
    t0 = time.time()
    res = run_monte_carlo(hole, board, num_players=2, iterations=5000,
                          opponent_range_keys=None)
    t1 = time.time()
    print(f"Тест 1 — AA префлоп vs случайный оппонент (5000 итераций):")
    print(f"  Equity: {res['win_prob']*100:.1f}% (ожидается ~85%)")
    print(f"  Время:  {(t1-t0)*1000:.0f}ms\n")

    # Тест 2: 72o vs случайные — должна быть низкая equity
    hole2 = [parse_card('7h'), parse_card('2c')]
    res2 = run_monte_carlo(hole2, board, num_players=2, iterations=5000,
                           opponent_range_keys=None)
    print(f"Тест 2 — 72o префлоп vs случайный оппонент (5000 итераций):")
    print(f"  Equity: {res2['win_prob']*100:.1f}% (ожидается ~34%)\n")

    # Тест 3: флоп, range vs range
    hole3  = [parse_card('Kh'), parse_card('Qh')]
    board3 = [parse_card('Jh'), parse_card('Th'), parse_card('2c')]
    t0 = time.time()
    res3 = run_monte_carlo(hole3, board3, num_players=2, iterations=500)
    t1 = time.time()
    print(f"Тест 3 — KhQh на JhTh2c vs диапазон виллейна (500 итераций):")
    print(f"  Equity:            {res3['win_prob']*100:.1f}%")
    print(f"  Range vs range:    {res3['used_range_vs_range']}")
    print(f"  Villain range %:   {res3['villain_range_pct']}%")
    print(f"  Время:             {(t1-t0)*1000:.0f}ms\n")

    # Тест 4: скорость — 200 итераций (целевой режим)
    t0 = time.time()
    run_monte_carlo(hole3, board3, num_players=2, iterations=200)
    t1 = time.time()
    print(f"Тест 4 — 200 итераций (боевой режим): {(t1-t0)*1000:.0f}ms")
    print("  Цель: < 150ms на чистом Python (без Numba)")
