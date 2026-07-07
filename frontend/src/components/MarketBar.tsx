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
      {fees.longRatePerHour !== null && (
        <div className="ml-3.5 text-xs leading-relaxed text-muted">
          Borrow /h:{" "}
          <span className="text-green">L {fees.longRatePerHour!.toFixed(4)}%</span>
          {" · "}
          <span className="text-red">S {fees.shortRatePerHour!.toFixed(4)}%</span>
        </div>
      )}
    </div>
  );
}
