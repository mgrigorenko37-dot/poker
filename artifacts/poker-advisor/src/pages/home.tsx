import React, { useState } from 'react';
import { HandAnalyzer } from '@/components/HandAnalyzer';
import { PreflopChart } from '@/components/PreflopChart';
import { HandHistory } from '@/components/HandHistory';
import { AutoScan } from '@/components/AutoScan';
import { cn } from '@/lib/utils';
import { useThemeProvider } from '@/hooks/use-theme';

export default function Home() {
  useThemeProvider();
  const [activeTab, setActiveTab] = useState<'analyzer' | 'autoscan' | 'chart' | 'history'>('analyzer');

  return (
    <div className="min-h-[100dvh] bg-[#0d1117] text-zinc-100 flex flex-col font-mono selection:bg-emerald-900/50">
      
      {/* HEADER */}
      <header className="border-b border-zinc-800 bg-zinc-950/50 sticky top-0 z-10 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-emerald-600 flex items-center justify-center text-black font-black text-xl shadow-[0_0_15px_rgba(5,150,105,0.4)]">
              ♠
            </div>
            <h1 className="text-xl font-bold tracking-tight">POKER<span className="text-zinc-500">TERMINAL</span></h1>
          </div>
          
          <nav className="flex gap-1 bg-zinc-900 p-1 rounded-lg border border-zinc-800">
            {[
              { id: 'analyzer', label: 'Analyzer' },
              { id: 'autoscan', label: 'Auto-Scan' },
              { id: 'chart', label: 'Preflop' },
              { id: 'history', label: 'History' }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={cn(
                  "px-4 py-1.5 rounded-md text-sm font-medium transition-all duration-200",
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

      {/* MAIN CONTENT */}
      <main className="flex-1 py-8">
        {activeTab === 'analyzer' && <HandAnalyzer />}
        {activeTab === 'autoscan' && <AutoScan />}
        {activeTab === 'chart' && <PreflopChart />}
        {activeTab === 'history' && <HandHistory />}
      </main>

    </div>
  );
}
