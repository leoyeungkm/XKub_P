"use client";

import { TV_SYMBOLS } from "@/config/contracts";

export default function Chart({ symbol }: { symbol: string }) {
  const tv = TV_SYMBOLS[symbol] ?? `BINANCE:${symbol}USDT`;
  return (
    <div className="h-[460px] overflow-hidden rounded-lg border border-line bg-panel">
      <iframe
        key={tv}
        className="h-full w-full border-0"
        src={`https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(tv)}&interval=15&theme=dark&style=1&hidesidetoolbar=1&saveimage=0`}
      />
    </div>
  );
}
