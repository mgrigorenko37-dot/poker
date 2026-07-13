import React, { useState, useEffect, useCallback } from 'react';

type Status = 'checking' | 'connected' | 'not_connected';

export function TelegramSetup() {
  const [status, setStatus] = useState<Status>('checking');
  const [linking, setLinking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/telegram/status');
      const data = await res.json();
      setStatus(data.configured ? 'connected' : 'not_connected');
    } catch {
      setStatus('not_connected');
    }
  }, []);

  useEffect(() => { checkStatus(); }, [checkStatus]);

  const link = useCallback(async () => {
    setLinking(true);
    setMessage(null);
    try {
      const res = await fetch('/api/telegram/link', { method: 'POST' });
      if (res.ok) {
        setMessage('Готово! Chat ID найден — сохрани его через агента, чтобы включить рассылку.');
      } else {
        const data = await res.json().catch(() => ({}));
        setMessage(data.error ?? 'Сначала напиши боту /start в Telegram, потом нажми ещё раз.');
      }
    } catch {
      setMessage('Не удалось связаться с сервером.');
    } finally {
      setLinking(false);
    }
  }, []);

  return (
    <div className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-4 text-left space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold text-zinc-200">📩 Telegram-уведомления</p>
        <span className={
          status === 'connected' ? 'text-xs text-emerald-400' :
          status === 'checking' ? 'text-xs text-zinc-600' : 'text-xs text-amber-400'
        }>
          {status === 'connected' ? 'Подключено' : status === 'checking' ? '…' : 'Не подключено'}
        </span>
      </div>
      {status !== 'connected' && (
        <>
          <p className="text-zinc-500 text-xs leading-relaxed">
            Реши/колл/рейз будут прилетать тебе в Telegram при каждой смене решения — не нужно смотреть на ПК.
          </p>
          <button
            onClick={link}
            disabled={linking}
            className="w-full px-3 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-xs text-zinc-300 transition-colors disabled:opacity-50"
          >
            {linking ? 'Ищу chat_id…' : 'Написал боту /start — привязать'}
          </button>
          {message && <p className="text-zinc-500 text-xs">{message}</p>}
        </>
      )}
    </div>
  );
}
