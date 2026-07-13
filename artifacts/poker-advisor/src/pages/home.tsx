import React, { useState } from 'react';
import { HandAnalyzer } from '@/components/HandAnalyzer';
import { PreflopChart } from '@/components/PreflopChart';
import { HandHistory } from '@/components/HandHistory';
import { CameraScan } from '@/components/CameraScan';
import { ScreenScan } from '@/components/ScreenScan';
import { LiveView } from '@/components/LiveView';
import { cn } from '@/lib/utils';
import { useThemeProvider } from '@/hooks/use-theme';

type Tab = 'analyzer' | 'screen' | 'camera' | 'live' | 'chart' | 'history';

export default function Home() {
  useThemeProvider();
  const [activeTab, setActiveTab] = useState<Tab>('analyzer');

  return (
    <div className="min-h-[100dvh] bg-[#0d1117] text-zinc-100 flex flex-col font-mono selection:bg-emerald-900/50">

      {/* HEADER */}
      <header className="border-b border-zinc-800 bg-zinc-950/50 sticky top-0 z-10 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 shrink-0">
            <div className="w-7 h-7 rounded bg-emerald-600 flex items-center justify-center text-black font-black text-lg shadow-[0_0_15px_rgba(5,150,105,0.4)]">
              ♠
            </div>
            <h1 className="text-lg font-bold tracking-tight hidden sm:block">
              POKER<span className="text-zinc-500">TERMINAL</span>
            </h1>
          </div>

          <nav className="flex gap-0.5 bg-zinc-900 p-1 rounded-lg border border-zinc-800 overflow-x-auto">
            {([
              { id: 'analyzer', label: 'Analyzer' },
              { id: 'screen',   label: '🖥️ Экран' },
              { id: 'live',     label: '📱 Эфир' },
              { id: 'camera',   label: '📷 Камера' },
              { id: 'chart',    label: 'Preflop' },
              { id: 'history',  label: 'History' },
            ] as { id: Tab; label: string }[]).map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "px-3 py-1.5 rounded-md text-xs sm:text-sm font-medium transition-all duration-200 whitespace-nowrap",
                  activeTab === tab.id
                    ? "bg-zinc-800 text-white shadow-sm"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                )}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* MAIN */}
      <main className="flex-1 flex flex-col">
        {activeTab === 'analyzer' && <div className="py-8"><HandAnalyzer /></div>}
        {activeTab === 'screen'   && <ScreenScan />}
        {activeTab === 'live'     && <LiveView />}
        {activeTab === 'camera'   && <CameraScan />}
        {activeTab === 'chart'    && <div className="py-8"><PreflopChart /></div>}
        {activeTab === 'history'  && <div className="py-8"><HandHistory /></div>}
      </main>

    </div>
  );
}
