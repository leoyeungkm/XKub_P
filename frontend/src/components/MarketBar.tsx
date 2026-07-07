"use client";

import { useReadContract, useReadContracts } from "wagmi";
import { ADDR, MARKETS, b32, marketAbi, oracleAbi, poolAbi } from "@/config/contracts";
import { fmtPrice, fmtUsd } from "@/lib/format";

/** Trading fee (bps) and current hourly borrow rates per side (%/h). */
export function useMarketFees(symbol: string) {
  const { data } = useReadContracts({
    contracts: [
      { address: ADDR.market, abi: marketAbi, functionName: "positionFeeBps" },
      { address: ADDR.market, abi: marketAbi, functionName: "getMarketState", args: [b32(symbol)] },
      { address: ADDR.market, abi: marketAbi, functionName: "marketConfig", args: [b32(symbol)] },
      { address: ADDR.pool, abi: poolAbi, functionName: "poolValueUsd" },
    ] as never[],
    query: { refetchInterval: 10000 },
  });

  const feeBps = data?.[0]?.result as bigint | undefined;
  const state = data?.[1]?.result as readonly bigint[] | undefined;
  const cfg = data?.[2]?.result as readonly [boolean, bigint, bigint, bigint] | undefined;
  const poolValue = data?.[3]?.result as bigint | undefined;

  // rate/h = borrowRateFactorBps × sideOI / poolValue
  const hourly = (sideUsd: bigint) =>
    cfg && poolValue && poolValue > 0n
      ? (Number(cfg[3]) / 100) * (Number(sideUsd) / Number(poolValue))
      : null;

  return {
    feeBps: feeBps !== undefined ? Number(feeBps) : null,
    longRatePerHour: state ? hourly(state[0]) : null,   // % per hour
    shortRatePerHour: state ? hourly(state[1]) : null,
  };
}

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
  const fees = useMarketFees(current);
  const { data: state } = useReadContract({
    address: ADDR.market,
    abi: marketAbi,
    functionName: "getMarketState",
    args: [b32(current)],
    query: { refetchInterval: 8000 },
  });

  const longOi = state ? Number(fmtUsd(state[0], 0).replace(/,/g, "")) : 0;
  const shortOi = state ? Number(fmtUsd(state[1], 0).replace(/,/g, "")) : 0;
  const totalOi = longOi + shortOi;
  const longPct = totalOi > 0 ? (longOi / totalOi) * 100 : 50;

  return (
    <div className="flex flex-wrap items-stretch gap-x-6 gap-y-3 border-b border-line px-5 py-3">
      {/* market selector */}
      <div className="flex items-center gap-1.5">
        {MARKETS.map((m) => (
          <button
            key={m.symbol}
            onClick={() => onChange(m.symbol)}
            className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
              m.symbol === current
                ? "bg-accentDim text-accent"
                : "text-muted hover:bg-panel2 hover:text-fg"
            }`}
          >
            {m.symbol}
          </button>
        ))}
      </div>

      {/* price */}
      <div className="flex flex-col justify-center">
        <div className="tnum text-[22px] font-semibold leading-none text-accent">
          {price > 0n ? fmtPrice(price) : "—"}
        </div>
        <div className="eyebrow mt-1">{current}-PERP · Mark</div>
      </div>

      {/* stat cells */}
      <Metric label="Long OI">{state ? fmtUsd(state[0], 0) : "—"}</Metric>
      <Metric label="Short OI">{state ? fmtUsd(state[1], 0) : "—"}</Metric>
      <Metric label="Borrow /h · L">
        <span className="text-green">{fees.longRatePerHour !== null ? `${fees.longRatePerHour.toFixed(4)}%` : "—"}</span>
      </Metric>
      <Metric label="Borrow /h · S">
        <span className="text-red">{fees.shortRatePerHour !== null ? `${fees.shortRatePerHour.toFixed(4)}%` : "—"}</span>
      </Metric>

      {/* signature: long/short skew bar */}
      <div className="flex min-w-[150px] flex-1 flex-col justify-center">
        <div className="eyebrow mb-1.5 flex justify-between">
          <span className="text-green">{longPct.toFixed(0)}% L</span>
          <span className="text-red">{(100 - longPct).toFixed(0)}% S</span>
        </div>
        <div className="flex h-1.5 overflow-hidden rounded-full bg-redDim">
          <div className="bg-green transition-all duration-500" style={{ width: `${longPct}%` }} />
        </div>
      </div>
    </div>
  );
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col justify-center">
      <div className="eyebrow mb-1">{label}</div>
      <div className="tnum text-[13px] font-medium">{children}</div>
    </div>
  );
}
