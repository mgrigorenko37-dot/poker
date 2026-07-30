"""
cfr_solver.py — Этап 2: External Sampling MCCFR постфлоп-решатель

Архитектура:
  - Equity вычисляется ОДИН РАЗ через mc_equity до цикла CFR
  - Глубина поиска: один стрит, макс 3 рейза
  - External Sampling: герой обходит все действия, виллейн сэмплирует одно
  - Node-locking: стратегия виллейна фиксируется по opponent_profile
  - Абстракция действий: check / fold / call / bet33 / bet75 / allin

Запустить для проверки:
  python cfr_solver.py
"""

from __future__ import annotations

import random
import time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from mc_equity import run_monte_carlo, parse_card, Card

# ---------------------------------------------------------------------------
# Константы действий
# ---------------------------------------------------------------------------

CHECK = 0
FOLD  = 1
CALL  = 2
BET33 = 3   # ставка 33% банка
BET75 = 4   # ставка 75% банка
ALLIN = 5

N_ACTIONS    = 6
ACTION_NAMES = ['check', 'fold', 'call', 'bet33', 'bet75', 'allin']

MAX_RAISES_PER_STREET = 3   # кап рейзов за стрит

# ---------------------------------------------------------------------------
# Игровое состояние
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class State:
    pot:            float   # текущий банк (уже включает все ставки)
    stack:          float   # эффективный остаток стека
    to_call:        float   # сколько нужно доплатить (0 = нет ставки)
    hero_invested:  float   # сколько герой вложил на этом стрите
    history:        tuple   # последовательность сделанных действий (int)
    n_raises:       int     # количество ставок/рейзов на этом стрите


def _player_at(idx: int, hero_acts_first: bool) -> int:
    """0 = герой, 1 = виллейн. Определяет, кто ходит на шаге idx истории."""
    if hero_acts_first:
        return idx % 2
    else:
        return 1 - (idx % 2)


def current_player(state: State, hero_acts_first: bool) -> int:
    return _player_at(len(state.history), hero_acts_first)


def is_terminal(state: State) -> bool:
    h = state.history
    if not h:
        return False
    last = h[-1]
    if last == FOLD:
        return True
    if last == CALL and len(h) >= 2:
        return True
    if len(h) >= 2 and last == CHECK and h[-2] == CHECK:
        return True
    return False


def terminal_value(state: State, hero_equity: float, hero_acts_first: bool) -> float:
    """Чистый EV героя (положительный = профит)."""
    h = state.history
    last = h[-1]

    if last == FOLD:
        # Кто сфолдил? Игрок на предыдущем шаге = len(h) - 1
        folder = _player_at(len(h) - 1, hero_acts_first)
        if folder == 1:           # виллейн сфолдил
            return state.pot - state.hero_invested
        else:                     # герой сфолдил
            return -state.hero_invested

    # Колл или чек-чек → шоудаун
    return hero_equity * state.pot - state.hero_invested


def valid_actions(state: State, player: int) -> list[int]:
    """Список допустимых действий для игрока."""
    if state.to_call == 0:
        actions = [CHECK]
        if state.stack > 0.01:
            if state.n_raises < MAX_RAISES_PER_STREET:
                actions += [BET33, BET75]
            actions.append(ALLIN)
    else:
        actions = [FOLD]
        if state.stack >= state.to_call - 0.01:
            actions.append(CALL)
        if state.stack > state.to_call + 0.01:
            if state.n_raises < MAX_RAISES_PER_STREET:
                actions += [BET33, BET75]
            actions.append(ALLIN)
    return actions


def apply_action(state: State, action: int, player: int) -> State:
    """Возвращает новое состояние после действия."""
    h = state.history + (action,)

    if action == CHECK:
        return State(state.pot, state.stack, 0.0,
                     state.hero_invested, h, state.n_raises)

    if action == FOLD:
        return State(state.pot, state.stack, 0.0,
                     state.hero_invested, h, state.n_raises)

    if action == CALL:
        amount = min(state.to_call, state.stack)
        invested = state.hero_invested + amount if player == 0 else state.hero_invested
        return State(state.pot + amount, state.stack - amount, 0.0,
                     invested, h, state.n_raises)

    # Ставка / рейз
    if action == ALLIN:
        total = state.stack
    elif action == BET33:
        total = max(state.to_call + state.pot * 0.33, state.to_call + 1.0)
        total = min(total, state.stack)
    else:  # BET75
        total = max(state.to_call + state.pot * 0.75, state.to_call + 1.0)
        total = min(total, state.stack)

    total = min(total, state.stack)
    new_to_call = max(total - state.to_call, total)  # сколько нужно докинуть в ответ
    invested = state.hero_invested + total if player == 0 else state.hero_invested
    return State(state.pot + total, state.stack - total, new_to_call,
                 invested, h, state.n_raises + 1)


# ---------------------------------------------------------------------------
# Профиль оппонента → веса для node-locking
# ---------------------------------------------------------------------------

def _villain_weights(action_list: list[int], profile: dict, facing_bet: bool) -> np.ndarray:
    """
    Возвращает веса действий виллейна на основе opponent_profile.
    profile: {vpip, pfr, af, fold_to_cbet, cbet}  (все в диапазоне 0.0–1.0)
    """
    fold_freq  = profile.get('fold_to_cbet', 0.45)
    af         = profile.get('af', 1.0)

    # Нормализуем AF: чем выше AF, тем чаще виллейн рейзит
    raise_freq = min(0.25, af / 20.0) if facing_bet else 0.0

    weights = np.ones(N_ACTIONS)

    if facing_bet:
        weights[FOLD]  = fold_freq
        weights[CALL]  = max(0.01, 1.0 - fold_freq - raise_freq)
        weights[BET33] = raise_freq * 0.4
        weights[BET75] = raise_freq * 0.4
        weights[ALLIN] = raise_freq * 0.2
        weights[CHECK] = 0.0
    else:
        # Нет ставки: виллейн чекает или ставит
        cbet = profile.get('cbet', 0.5)
        weights[CHECK] = 1.0 - cbet
        weights[BET33] = cbet * 0.4
        weights[BET75] = cbet * 0.4
        weights[ALLIN] = cbet * 0.2
        weights[FOLD]  = 0.0
        weights[CALL]  = 0.0

    # Обнуляем действия которых нет в action_list
    mask = np.zeros(N_ACTIONS)
    for a in action_list:
        mask[a] = 1.0
    weights = weights * mask

    s = weights.sum()
    if s > 0:
        weights /= s
    else:
        # Фолбэк: равномерно
        for a in action_list:
            weights[a] = 1.0 / len(action_list)

    return weights


# ---------------------------------------------------------------------------
# MCCFR решатель
# ---------------------------------------------------------------------------

class MCCFRSolver:
    def __init__(self):
        # regret_sum[key] = np.array(N_ACTIONS)
        self.regret_sum:   dict[tuple, np.ndarray] = {}
        # strategy_sum[key] = np.array(N_ACTIONS)
        self.strategy_sum: dict[tuple, np.ndarray] = {}

    def _get_strategy(self, key: tuple, actions: list[int]) -> np.ndarray:
        """Regret matching → текущая стратегия."""
        if key not in self.regret_sum:
            self.regret_sum[key]   = np.zeros(N_ACTIONS)
            self.strategy_sum[key] = np.zeros(N_ACTIONS)

        regrets = self.regret_sum[key]
        pos = np.maximum(regrets, 0.0)
        total = pos[actions].sum()

        strat = np.zeros(N_ACTIONS)
        if total > 1e-9:
            strat[actions] = pos[actions] / total
        else:
            strat[actions] = 1.0 / len(actions)
        return strat

    def _cfr(
        self,
        state:          State,
        hero_equity:    float,
        hero_acts_first: bool,
        reach_p0:       float,   # вероятность достижения для героя
        reach_p1:       float,   # вероятность достижения для виллейна
        villain_profile: dict,
        depth:          int,
    ) -> float:
        """
        Возвращает контрафактуальный EV героя из этого узла.
        External Sampling: герой обходит все действия, виллейн сэмплирует одно.
        """
        if is_terminal(state):
            return terminal_value(state, hero_equity, hero_acts_first)

        # Ограничение глубины: если зашли слишком глубоко → терминал по equity
        if depth >= 6:
            return hero_equity * state.pot - state.hero_invested

        player  = current_player(state, hero_acts_first)
        actions = valid_actions(state, player)
        key     = (player,) + state.history

        if player == 0:
            # ─── Узел героя: обходим все действия ───────────────────────────
            strat = self._get_strategy(key, actions)
            action_values = np.zeros(N_ACTIONS)

            for a in actions:
                next_state = apply_action(state, a, player)
                action_values[a] = self._cfr(
                    next_state, hero_equity, hero_acts_first,
                    reach_p0 * strat[a], reach_p1,
                    villain_profile, depth + 1,
                )

            node_value = float(np.dot(strat, action_values))

            # Обновляем сожаления (контрафактуальные, взвешенные на reach виллейна)
            for a in actions:
                self.regret_sum[key][a] += reach_p1 * (action_values[a] - node_value)

            # Обновляем сумму стратегий
            self.strategy_sum[key] += reach_p0 * strat

            return node_value

        else:
            # ─── Узел виллейна: node-locking или regret-matching ─────────────
            if villain_profile:
                weights = _villain_weights(actions, villain_profile, state.to_call > 0)
            else:
                weights = self._get_strategy(key, actions)

            # Сэмплируем одно действие (external sampling)
            probs = weights[actions]
            probs = probs / probs.sum()
            sampled_a = random.choices(actions, weights=probs)[0]

            next_state = apply_action(state, sampled_a, player)
            return self._cfr(
                next_state, hero_equity, hero_acts_first,
                reach_p0, reach_p1 * probs[actions.index(sampled_a)],
                villain_profile, depth + 1,
            )

    def solve(
        self,
        initial_state:   State,
        hero_equity:     float,
        hero_acts_first: bool  = True,
        iterations:      int   = 100,
        villain_profile: Optional[dict] = None,
    ) -> dict:
        """
        Запускает N итераций MCCFR и возвращает среднюю стратегию в корне.

        Возвращает:
            {
              'action': str,              # рекомендуемое действие
              'frequencies': {str: float},  # частоты всех действий
              'ev': float,                # ожидаемый EV при оптимальной игре
              'iterations': int,
              'equity': float,
            }
        """
        profile = villain_profile or {}
        root_ev_sum = 0.0

        for _ in range(iterations):
            ev = self._cfr(
                initial_state, hero_equity, hero_acts_first,
                1.0, 1.0, profile, 0,
            )
            root_ev_sum += ev

        avg_ev = root_ev_sum / iterations

        # Средняя стратегия в корневом узле
        root_key = (0,) + initial_state.history
        actions  = valid_actions(initial_state, 0)

        if root_key in self.strategy_sum:
            s_sum = self.strategy_sum[root_key]
            total = s_sum[actions].sum()
            if total > 1e-9:
                avg_strat = s_sum / total
            else:
                avg_strat = np.zeros(N_ACTIONS)
                avg_strat[actions] = 1.0 / len(actions)
        else:
            avg_strat = np.zeros(N_ACTIONS)
            avg_strat[actions] = 1.0 / len(actions)

        # Строим словарь частот (только ненулевые)
        freqs = {
            ACTION_NAMES[a]: round(float(avg_strat[a]), 3)
            for a in actions
            if avg_strat[a] > 0.005
        }

        # Рекомендация = действие с наибольшей частотой
        best_action = max(actions, key=lambda a: avg_strat[a])

        return {
            'action':      ACTION_NAMES[best_action],
            'frequencies': freqs,
            'ev':          round(avg_ev, 2),
            'equity':      round(hero_equity, 3),
            'iterations':  iterations,
        }


# ---------------------------------------------------------------------------
# Публичный API
# ---------------------------------------------------------------------------

def solve_spot(
    hole_cards:       list[Card],
    board_cards:      list[Card],
    pot:              float,
    stack:            float,
    villain_range:    Optional[list[str]] = None,
    villain_profile:  Optional[dict]      = None,
    hero_acts_first:  bool                = True,
    mc_iterations:    int                 = 200,
    cfr_iterations:   int                 = 100,
) -> dict:
    """
    Единая точка входа: вычисляет equity один раз, потом запускает CFR.

    Параметры:
        hole_cards       — карты героя [(rank, suit), ...]
        board_cards      — борд
        pot              — текущий банк в $
        stack            — эффективный стек в $
        villain_range    — список ключей диапазона виллейна ('AKs', 'QQ' ...)
        villain_profile  — {'vpip': 0.28, 'pfr': 0.18, 'af': 1.5,
                             'fold_to_cbet': 0.45, 'cbet': 0.55}
        hero_acts_first  — True если герой в OOP (ходит первым)
        mc_iterations    — итерации Монте-Карло для equity
        cfr_iterations   — итерации CFR

    Возвращает dict совместимый с /api/cfr/solve
    """
    t_start = time.time()

    # Шаг 1: equity один раз до CFR (это leaf evaluator для всего дерева)
    mc_result = run_monte_carlo(
        hole_cards, board_cards,
        num_players=2,
        iterations=mc_iterations,
        opponent_range_keys=villain_range,
    )
    hero_equity = mc_result['win_prob'] + mc_result['tie_prob'] * 0.5

    # Шаг 2: начальное состояние
    initial_state = State(
        pot=pot,
        stack=stack,
        to_call=0.0,
        hero_invested=0.0,
        history=(),
        n_raises=0,
    )

    # Шаг 3: MCCFR
    solver = MCCFRSolver()
    result = solver.solve(
        initial_state, hero_equity,
        hero_acts_first=hero_acts_first,
        iterations=cfr_iterations,
        villain_profile=villain_profile,
    )

    t_end = time.time()

    return {
        **result,
        'mc_equity':        round(hero_equity * 100, 1),
        'used_range':       mc_result['used_range_vs_range'],
        'villain_range_pct': mc_result['villain_range_pct'],
        'elapsed_ms':       round((t_end - t_start) * 1000),
    }


# ---------------------------------------------------------------------------
# Проверка
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    print("=== cfr_solver.py — проверка ===\n")

    # Тест 1: сильная рука на сухом борду, пассивный оппонент
    hole  = [parse_card('Ah'), parse_card('As')]
    board = [parse_card('Kd'), parse_card('7c'), parse_card('2h')]
    profile_passive = {'vpip': 0.45, 'pfr': 0.05, 'af': 0.6,
                       'fold_to_cbet': 0.65, 'cbet': 0.25}

    t0 = time.time()
    r1 = solve_spot(hole, board, pot=100, stack=300,
                    villain_profile=profile_passive,
                    mc_iterations=200, cfr_iterations=100)
    t1 = time.time()

    print("Тест 1 — AA на Kd7c2h, пассивный оппонент (VPIP45/PFR5):")
    print(f"  Рекомендация: {r1['action']}")
    print(f"  Частоты:      {r1['frequencies']}")
    print(f"  EV:           {r1['ev']}")
    print(f"  Equity:       {r1['mc_equity']}%")
    print(f"  Время:        {r1['elapsed_ms']}ms")
    print(f"  (ожидается: bet33 или bet75 доминирует — сильная рука против calling station)\n")

    # Тест 2: слабая рука, агрессивный оппонент
    hole2  = [parse_card('7h'), parse_card('6h')]
    board2 = [parse_card('Ah'), parse_card('Kc'), parse_card('2d')]
    profile_agg = {'vpip': 0.25, 'pfr': 0.22, 'af': 3.5,
                   'fold_to_cbet': 0.30, 'cbet': 0.75}

    t0 = time.time()
    r2 = solve_spot(hole2, board2, pot=100, stack=300,
                    villain_profile=profile_agg,
                    mc_iterations=200, cfr_iterations=100)
    t1 = time.time()

    print("Тест 2 — 76h на AKc2d, агрессивный оппонент (VPIP25/PFR22/AF3.5):")
    print(f"  Рекомендация: {r2['action']}")
    print(f"  Частоты:      {r2['frequencies']}")
    print(f"  EV:           {r2['ev']}")
    print(f"  Equity:       {r2['mc_equity']}%")
    print(f"  Время:        {r2['elapsed_ms']}ms")
    print(f"  (ожидается: check или fold доминирует — слабая рука на сухом борду с агрессором)\n")

    # Тест 3: скорость 200 итераций CFR
    t0 = time.time()
    r3 = solve_spot(hole, board, pot=100, stack=300,
                    mc_iterations=200, cfr_iterations=200)
    t1 = time.time()
    print(f"Тест 3 — 200 итераций CFR: {r3['elapsed_ms']}ms")
    print(f"  Цель: < 400ms")
