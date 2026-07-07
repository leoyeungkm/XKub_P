"use client";

import { useState } from "react";
import { parseEther } from "viem";
import { useAccount, usePublicClient, useReadContracts, useReadContract } from "wagmi";
import toast from "react-hot-toast";
import { ADDR, E18, MARKETS, b32, marketAbi, oracleAbi, routerAbi } from "@/config/contracts";
import { useKubWrite } from "@/lib/kubWrite";
import { errMsg, fmtPrice, fmtUsd } from "@/lib/format";
import { getAgentClients, useOneClick } from "@/lib/oneclick";
import { gaslessAvailable, submitGaslessOrder } from "@/lib/gasless";
import { useLivePrices } from "@/lib/cexPrice";

const COMBOS = MARKETS.flatMap((m) => [
  { symbol: m.symbol, isLong: true },
  { symbol: m.symbol, isLong: false },
]);

export default function PositionsTable() {
  const { address } = useAccount();
  const client = usePublicClient();
  const { writeContract } = useKubWrite();
  const oneClick = useOneClick();
  const livePrices = useLivePrices();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const { data: minExecFee } = useReadContract({
    address: ADDR.router, abi: routerAbi, functionName: "minExecutionFee",
  });

  const { data } = useReadContracts({
    contracts: COMBOS.flatMap((c) => [
      { address: ADDR.market, abi: marketAbi, functionName: "getPosition",
        args: [address!, b32(c.symbol), c.isLong] },
      { address: ADDR.market, abi: marketAbi, functionName: "getPositionPnl",
        args: [address!, b32(c.symbol), c.isLong] },
      { address: ADDR.oracle, abi: oracleAbi, functionName: "peekPrice",
        args: [b32(c.symbol)] },
    ]) as never[],
    query: { enabled: !!address, refetchInterval: 6000 },
  });

  const rows = COMBOS.map((c, i) => {
    const pos = data?.[i * 3]?.result as
      | { sizeUsd: bigint; sizeTokens: bigint; collateralUsd: bigint }
      | undefined;
    const pnl = data?.[i * 3 + 1]?.result as bigint | undefined;
    const peek = data?.[i * 3 + 2]?.result as readonly [bigint, bigint] | undefined;
    if (!pos || pos.sizeUsd === 0n) return null;
    return { ...c, pos, pnl: pnl ?? 0n, mark: peek?.[0] ?? 0n };
  }).filter(Boolean) as {
    symbol: string; isLong: boolean; mark: bigint; pnl: bigint;
    pos: { sizeUsd: bigint; sizeTokens: bigint; collateralUsd: bigint };
  }[];

  const close = async (symbol: string, isLong: boolean, sizeUsd: bigint, mark: bigint) => {
    if (!address || !client) return;
    const key = `${symbol}-${isLong}`;
    if (busyKey) return; // ignore repeat clicks while a close is in flight
    setBusyKey(key);
    try {
      // 1% slippage bound off the live price (oracle mark can be stale)
      const live = livePrices[symbol];
      const ref = live && live > 0 ? parseEther(live.toFixed(6)) : mark;
      const acceptable = ref > 0n
        ? isLong ? ref - ref / 100n : ref + ref / 100n
        : 0n;
      const fee = minExecFee ?? 0n;

      // Gasless: agent signs, relayer submits & pays gas (mirrors the open flow)
      if (oneClick.active && gaslessAvailable()) {
        try {
          await submitGaslessOrder({
            owner: address, symbol, isLong, isIncrease: false,
            collateralTokens: 0n, sizeDeltaUsd: sizeUsd, acceptablePrice: acceptable, client,
          });
          toast.success("Close submitted (gasless) — keeper executes at fresh price");
          return;
        } catch {
          toast("Relayer unavailable — falling back");
        }
      }

      // On-chain 1-click (agent pays its own gas)
      if (oneClick.active && oneClick.agentGas >= fee * 2n) {
        const agents = getAgentClients(address)!;
        const hash = await agents.wallet.writeContract({
          address: ADDR.router, abi: routerAbi, functionName: "createDecreaseRequestFor",
          args: [address, b32(symbol), isLong, sizeUsd, acceptable],
          value: fee,
        });
        await client.waitForTransactionReceipt({ hash });
        toast.success("Close queued (1-click)");
        return;
      }

      toast("Submitting close…");
      const hash = await writeContract({
        address: ADDR.router, abi: routerAbi, functionName: "createDecreaseRequest",
        args: [b32(symbol), isLong, sizeUsd, acceptable],
        value: fee,
      });
      await client.waitForTransactionReceipt({ hash });
      toast.success("Close queued");
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      <h3 className="eyebrow flex items-center gap-2 border-b border-line px-3.5 py-2.5">
        Positions
        {rows.length > 0 && (
          <span className="tnum rounded bg-panel2 px-1.5 py-0.5 text-[10px] text-fg">{rows.length}</span>
        )}
      </h3>
      {rows.length === 0 ? (
        <div className="px-3.5 py-6 text-center text-[12px] text-mutedDim">No open positions</div>
      ) : (
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="eyebrow text-left">
              {["Market", "Side", "Size", "Collateral", "Entry", "Mark", "PnL", ""].map((h) => (
                <th key={h} className="border-b border-line px-3.5 py-2 font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const entry = (r.pos.sizeUsd * E18) / r.pos.sizeTokens;
              return (
                <tr key={r.symbol + r.isLong} className="border-b border-lineSoft transition-colors last:border-0 hover:bg-panel2/40">
                  <td className="px-3.5 py-2.5 font-medium">{r.symbol}-PERP</td>
                  <td className="px-3.5 py-2.5">
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${r.isLong ? "bg-greenDim text-green" : "bg-redDim text-red"}`}>
                      {r.isLong ? "Long" : "Short"}
                    </span>
                  </td>
                  <td className="tnum px-3.5 py-2.5">{fmtUsd(r.pos.sizeUsd, 0)}</td>
                  <td className="tnum px-3.5 py-2.5">{fmtUsd(r.pos.collateralUsd)}</td>
                  <td className="tnum px-3.5 py-2.5">${fmtPrice(entry)}</td>
                  <td className="tnum px-3.5 py-2.5">{r.mark > 0n ? `$${fmtPrice(r.mark)}` : "—"}</td>
                  <td className={`tnum px-3.5 py-2.5 font-medium ${r.pnl >= 0n ? "text-green" : "text-red"}`}>
                    {r.pnl >= 0n ? "+" : ""}{fmtUsd(r.pnl)}
                  </td>
                  <td className="px-3.5 py-2.5 text-right">
                    <button
                      onClick={() => close(r.symbol, r.isLong, r.pos.sizeUsd, r.mark)}
                      disabled={busyKey === `${r.symbol}-${r.isLong}`}
                      className="rounded border border-line px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-red/50 hover:text-red disabled:opacity-50"
                    >
                      {busyKey === `${r.symbol}-${r.isLong}` ? "Closing…" : "Close"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
