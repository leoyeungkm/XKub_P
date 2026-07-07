"use client";

import { useReadContract } from "wagmi";
import { ADDR, MARKETS, b32, marketAbi, oracleAbi } from "@/config/contracts";
import { fmtPrice, fmtUsd } from "@/lib/format";

export function useOraclePrice(symbol: string) {
  const { data } = useReadContract({
    address: ADDR.oracle,
    abi: oracleAbi,
    functionName: "peekPrice",
    args: [b32(symbol)],
    query: { refetchInterval: 5000 },
  });
  return data ? data[0] : 0n;
}

export default function MarketBar({
  current,
  onChange,
}: {
  current: string;
  onChange: (s: string) => void;
}) {
  const price = useOraclePrice(current);
  const { data: state } = useReadContract({
    address: ADDR.market,
    abi: marketAbi,
    functionName: "getMarketState",
    args: [b32(current)],
    query: { refetchInterval: 8000 },
  });

  return (
    <div className="flex items-center gap-2 border-b border-line px-5 py-2.5">
      {MARKETS.map((m) => (
        <button
          key={m.symbol}
          onClick={() => onChange(m.symbol)}
          className={`rounded-lg border px-4 py-2 font-semibold ${
            m.symbol === current
              ? "border-accent bg-panel2 text-fg"
              : "border-transparent bg-panel text-muted hover:text-fg"
          }`}
        >
          {m.symbol}-PERP
        </button>
      ))}
      <div className="ml-4 text-xl font-bold">
        {price > 0n ? `$${fmtPrice(price)}` : "—"}
      </div>
      {state && (
        <div className="ml-3.5 text-xs leading-relaxed text-muted">
          Long OI: {fmtUsd(state[0], 0)} · Short OI: {fmtUsd(state[1], 0)}
        </div>
      )}
    </div>
  );
}
