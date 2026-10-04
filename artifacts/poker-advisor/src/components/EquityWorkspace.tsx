import { useEffect, useMemo, useState } from 'react';
import { createDeck, parseCard, RANK_CHARS, SUIT_CHARS, validateEquityInput, type EquityInput, type EquityResult } from '@workspace/poker-engine';

import { DEMO_HAND } from '@/lib/demo-hand';

type Seat = { active: boolean; cards: string[] };
const choices = createDeck().map(c => ({ value: `${RANK_CHARS[c.rank]}${c.suit}`, label: `${RANK_CHARS[c.rank]}${SUIT_CHARS[c.suit]}` }));
const fieldClass = 'min-h-12 rounded-xl border border-zinc-700 bg-zinc-950 px-2 text-base text-white focus:border-emerald-400 focus:outline-none';

function CardSlots({ title, values, onChange, used }: {
  title: string; values: string[]; onChange: (values: string[]) => void; used: string[];
}) {
  return <fieldset className="min-w-0 space-y-2">
    <legend className="mb-2 text-sm text-zinc-300">{title}</legend>
    <div className="flex flex-wrap gap-2">
      {values.map((value, index) => <select key={index} aria-label={`${title}, карта ${index + 1}`}
        className={`${fieldClass} w-[3.25rem] appearance-none text-center`} value={value}
        onChange={e => onChange(values.map((card, i) => i === index ? e.target.value : card))}>
        <option value="">—</option>
        {choices.map(card => <option key={card.value} value={card.value}
          disabled={card.value !== value && used.includes(card.value)}>{card.label}</option>)}
      </select>)}
    </div>
  </fieldset>;
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

export function EquityWorkspace({ onScreen, onLive }: { onScreen: () => void; onLive: () => void }) {
  const [hero, setHero] = useState(['', '']);
  const [board, setBoard] = useState(['', '', '', '', '']);
  const [seats, setSeats] = useState<Seat[]>([{ active: true, cards: ['', ''] }]);
  const [iterations, setIterations] = useState(5000);
  const [calculation, setCalculation] = useState<{ key: string; result?: EquityResult; error?: string } | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [example, setExample] = useState(false);
  const [demoIndex, setDemoIndex] = useState<number | null>(null);
  const [demoPlaying, setDemoPlaying] = useState(false);
  const demo = demoIndex === null ? null : DEMO_HAND[demoIndex];
  const stopDemo = () => { setDemoPlaying(false); setDemoIndex(null); };
  const showDemoFrame = (index: number) => {
    const frame = DEMO_HAND[index];
    setDemoIndex(index);
    setHero(Array.from({ length: 2 }, (_, i) => frame.holeCards[i] ?? ''));
    setBoard(Array.from({ length: 5 }, (_, i) => frame.boardCards[i] ?? ''));
    setSeats(frame.opponents.map(seat => ({ active: seat.active,
      cards: Array.from({ length: 2 }, (_, i) => seat.cards[i] ?? '') })));
    setExample(false);
  };


  const used = [...hero, ...board, ...seats.flatMap(s => s.cards)].filter(Boolean);
  const activeCount = seats.filter(s => s.active).length;

  useEffect(() => {
    if (!photo) { setPhotoUrl(null); return; }
    const url = URL.createObjectURL(photo);
    setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  const prepared = useMemo((): { input?: EquityInput; message?: string } => {
    if (hero.some(c => !c)) return { message: 'Выберите две свои карты.' };
    if (![0, 3, 4, 5].includes(board.filter(Boolean).length)) return { message: 'На борде должно быть 0, 3, 4 или 5 карт. Дождитесь завершения раздачи карт.' };
    if (!activeCount) return { message: 'Для расчёта нужен хотя бы один соперник в раздаче.' };
    if (seats.some(s => s.cards.filter(Boolean).length === 1)) return { message: 'Для открытой руки укажите обе карты; для неизвестной оставьте оба поля пустыми.' };
    try {
      const input: EquityInput = {
        holeCards: hero.map(parseCard), boardCards: board.filter(Boolean).map(parseCard),
        opponents: seats.filter(s => s.active).map(s => ({ holeCards: s.cards.filter(Boolean).map(parseCard) })),
        deadCards: seats.filter(s => !s.active).flatMap(s => s.cards.filter(Boolean).map(parseCard)),
        iterations,
      };
      validateEquityInput(input);
      return { input };
    } catch {
      return { message: 'Проверьте карты: одна карта не может находиться в двух местах.' };
    }
  }, [hero, board, seats, iterations, activeCount]);
  const key = JSON.stringify(prepared.input ?? null);
  const current = calculation?.key === key ? calculation : null;
  const busy = !!prepared.input && !current;

  useEffect(() => {
    if (!prepared.input) return;
    // A fresh worker cancels stale calculations instead of queuing them behind
    // newer inputs. The phone's UI remains responsive during the simulation.
    let worker: Worker | undefined;
    const timer = setTimeout(() => {
      try {
        worker = new Worker(new URL('../workers/equity.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<{ result?: EquityResult; error?: string }>) => {
          setCalculation({ key, ...event.data });
          worker?.terminate();
        };
        worker.onerror = () => {
          setCalculation({ key, error: 'Не удалось запустить расчёт. Обновите страницу и повторите.' });
          worker?.terminate();
        };
        worker.postMessage(prepared.input);
      } catch {
        setCalculation({ key, error: 'Этот браузер не смог запустить фоновый расчёт.' });
      }
    }, 200);
    return () => { clearTimeout(timer); worker?.terminate(); };
  }, [key]);

  useEffect(() => {
    if (!demoPlaying || demoIndex === null || busy) return;
    if (demoIndex >= DEMO_HAND.length - 1) { setDemoPlaying(false); return; }
    const timer = setTimeout(() => showDemoFrame(demoIndex + 1), 5000);
    return () => clearTimeout(timer);
  }, [demoIndex, demoPlaying, busy]);

  const loadExample = () => {
    stopDemo();
    setHero(['7c', '9h']); setBoard(['9c', '4c', '2d', '3d', 'Kd']);
    setSeats([{ active: true, cards: ['4s', '4d'] }]); setExample(true);
  };
  const reset = () => {
    stopDemo();
    setHero(['', '']); setBoard(['', '', '', '', '']);
    setSeats([{ active: true, cards: ['', ''] }]); setCalculation(null); setExample(false);
  };

  return <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:py-10 space-y-6">
    <header className="space-y-3">
      <p className="text-xs uppercase tracking-[0.2em] text-emerald-400">Техасский холдем · телефон и компьютер</p>
      <h2 className="text-2xl font-semibold sm:text-3xl">Вероятность вашей руки</h2>
      <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">Укажите карты и соперников, оставшихся в раздаче. Расчёт обновляется автоматически после изменения данных.</p>
      <div className="flex flex-wrap gap-2">
        <button onClick={onScreen} className="rounded-lg bg-emerald-600 px-4 py-3 text-sm text-white">Сканировать экран ПК</button>
        <button onClick={onLive} className="rounded-lg border border-zinc-700 px-4 py-3 text-sm">Смотреть эфир</button>
        <button onClick={() => { showDemoFrame(0); setDemoPlaying(true); }} className="rounded-lg border border-emerald-700 px-4 py-3 text-sm text-emerald-300">Демо без депозита</button>
        <button onClick={loadExample} className="rounded-lg border border-zinc-700 px-4 py-3 text-sm">Пример TON Poker</button>
      </div>
      <p className="text-xs leading-relaxed text-zinc-500">На телефоне доступны этот калькулятор и просмотр эфира. Автоматический захват Telegram на Android пока не подключён.</p>
    </header>

    {demo && <section aria-label="Синтетическая демонстрация" className="rounded-2xl border border-amber-700/50 bg-amber-950/20 p-4 space-y-3">
      <p className="text-xs uppercase tracking-wide text-amber-300">Синтетическая демонстрация · {demoIndex! + 1}/{DEMO_HAND.length}</p>
      <h3 className="text-lg font-medium">{demo.title}</h3>
      <p className="text-sm leading-relaxed text-zinc-300">{demo.note}</p>
      <div className="flex flex-wrap gap-2">
        <button disabled={demoIndex === 0} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm disabled:opacity-40"
          onClick={() => { setDemoPlaying(false); showDemoFrame(demoIndex! - 1); }}>Назад</button>
        <button className="rounded-lg border border-zinc-700 px-3 py-2 text-sm" onClick={() => {
          if (!demoPlaying && demoIndex === DEMO_HAND.length - 1) showDemoFrame(0);
          setDemoPlaying(!demoPlaying);
        }}>{demoPlaying ? 'Пауза' : 'Воспроизвести'}</button>
        <button disabled={demoIndex === DEMO_HAND.length - 1} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm disabled:opacity-40"
          onClick={() => { setDemoPlaying(false); showDemoFrame(demoIndex! + 1); }}>Следующий кадр</button>
        <button className="rounded-lg px-3 py-2 text-sm text-zinc-400" onClick={reset}>Завершить демо</button>
      </div>
      <p className="text-xs leading-relaxed text-zinc-500">Это заданная последовательность для проверки расчёта и интерфейса. Карты и действия подставляются из сценария; распознавание экрана здесь не выполняется. Изменение карт или игроков останавливает демо.</p>
    </section>}
    <section className="grid grid-cols-3 gap-2 rounded-xl border border-emerald-900/60 bg-emerald-950/20 p-3 text-center lg:hidden" aria-live="polite">
      {([
        ['Победа', current?.result?.winProb],
        ['Раздел', current?.result?.tieProb],
        ['Доля банка', current?.result?.equity],
      ] as const).map(([label, value]) => <div key={label}>
        <p className="text-[11px] text-zinc-400">{label}</p>
        <p className="mt-1 text-xl text-emerald-300">{value === undefined ? '—' : percent(value)}</p>
      </div>)}
      {busy && <p className="col-span-3 text-xs text-zinc-400">Обновляем расчёт…</p>}
    </section>
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-5">
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-6 space-y-5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-lg font-medium">Карты на столе</h3>
            <button onClick={reset} className="px-2 py-2 text-sm text-zinc-400 hover:text-white">Новая раздача</button>
          </div>
          <CardSlots title="Ваши карты" values={hero} used={used} onChange={v => { stopDemo(); setHero(v); setExample(false); }} />
          <CardSlots title="Общий борд" values={board} used={used} onChange={v => { stopDemo(); setBoard(v); setExample(false); }} />
          {example && <p className="text-xs leading-relaxed text-amber-300">Разбор присланного вскрытия: ваши карты снизу, соперник слева. Правый игрок не включён, поскольку его участие по одному кадру неизвестно. Против открытой тройки четвёрок пара девяток проигрывает.</p>}
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-lg font-medium">Соперники в раздаче: {activeCount}</h3>
            <button disabled={seats.length >= 8} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm disabled:opacity-40"
              onClick={() => { stopDemo(); setSeats([...seats, { active: true, cards: ['', ''] }]); setExample(false); }}>+ Соперник</button>
          </div>
          <p className="text-xs leading-relaxed text-zinc-400">Пустые поля означают скрытые карты. Снимите отметку, если игрок сбросил карты. Занятое место само по себе не означает участие в раздаче.</p>
          {seats.map((seat, index) => <div key={index} className="rounded-xl border border-zinc-800 p-3 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <label className="flex min-h-10 items-center gap-3 text-sm">
                <input type="checkbox" className="h-5 w-5 accent-emerald-500" checked={seat.active}
                  onChange={e => { stopDemo(); setSeats(seats.map((s, i) => i === index ? { ...s, active: e.target.checked } : s)); setExample(false); }} />
                Соперник {index + 1} {seat.active ? '· в игре' : '· фолд'}
              </label>
              <button aria-label={`Удалить соперника ${index + 1}`} onClick={() => { stopDemo(); setSeats(seats.filter((_, i) => i !== index)); setExample(false); }} className="px-3 py-2 text-zinc-500 hover:text-white">×</button>
            </div>
            <CardSlots title={`Карты соперника ${index + 1}`} values={seat.cards} used={used}
              onChange={v => { stopDemo(); setSeats(seats.map((s, i) => i === index ? { ...s, cards: v } : s)); setExample(false); }} />
            {!seat.active && seat.cards.some(Boolean) && <p className="text-xs text-zinc-500">Открытые карты исключаются из колоды.</p>}
          </div>)}
        </section>
      </div>

      <aside className="space-y-5 lg:sticky lg:top-20 self-start">
        <section className="rounded-2xl border border-emerald-800/50 bg-emerald-950/20 p-5 space-y-4" aria-live="polite" aria-busy={busy}>
          <h3 className="text-sm text-emerald-300">Вероятность победить без раздела</h3>
          <p className="text-5xl font-semibold tracking-tight">{current?.result ? percent(current.result.winProb) : '—'}</p>
          {busy && <p className="text-sm text-zinc-400">Считаем варианты…</p>}
          {prepared.message && <p className="text-sm text-zinc-400">{prepared.message}</p>}
          {current?.error && <p role="alert" className="text-sm text-red-300">{current.error}</p>}
          {current?.result && <>
            <dl className="space-y-3 border-t border-emerald-900/50 pt-4 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-zinc-400">Разделить банк</dt><dd>{percent(current.result.tieProb)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-zinc-400">Доля банка · equity</dt><dd className="text-emerald-300">{percent(current.result.equity)}</dd></div>
            </dl>
            <p className="text-xs leading-relaxed text-zinc-400">{current.result.method === 'exact'
              ? `Полный перебор · вариантов: ${current.result.total.toLocaleString('ru')}.`
              : `${current.result.total.toLocaleString('ru')} симуляций. Консервативная погрешность equity: ±${(current.result.errorBound95 * 100).toFixed(1)} п.п. при 95% доверии.`}</p>
          </>}
          <p className="text-xs leading-relaxed text-zinc-500">Скрытые руки считаются случайными среди допустимых карт. Результат зависит от введённых данных; стиль игры соперников здесь не учитывается. Equity — доля одного общего банка, без побочных банков.</p>
          <label className="block space-y-2 text-xs text-zinc-400">Точность симуляции
            <select className={`${fieldClass} mt-2 w-full`} value={iterations} onChange={e => setIterations(Number(e.target.value))}>
              <option value={2000}>Быстро · 2 000 вариантов</option>
              <option value={5000}>Обычно · 5 000 вариантов</option>
              <option value={20000}>Точнее · 20 000 вариантов</option>
            </select>
          </label>
        </section>
        <section className="rounded-2xl border border-zinc-800 p-4 space-y-3">
          <label className="block text-sm text-zinc-300">Снимок стола
            <input type="file" accept="image/png,image/jpeg,image/webp" className="mt-3 block w-full text-xs text-zinc-400 file:mr-2 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-3 file:py-3 file:text-zinc-200"
              onChange={e => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024) {
                  setPhotoError('Выберите PNG, JPEG или WebP размером до 10 МБ.'); e.target.value = ''; return;
                }
                setPhotoError(null); setPhoto(file);
              }} />
          </label>
          <p className="text-xs leading-relaxed text-zinc-500">Снимок остаётся на вашем устройстве. Используйте его как ориентир при выборе карт; автоматическое распознавание в этой панели пока не подключено.</p>
          {photoError && <p role="alert" className="text-xs text-red-300">{photoError}</p>}
          {photoUrl && <img src={photoUrl} alt="Загруженный снимок покерного стола" className="max-h-[32rem] w-full rounded-xl object-contain" onError={() => { setPhotoError('Не удалось прочитать изображение.'); setPhoto(null); }} />}
        </section>
      </aside>
    </div>
  </div>;
}
