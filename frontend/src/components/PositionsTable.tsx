"use client";

import { useAccount, usePublicClient, useReadContracts, useWriteContract, useReadContract } from "wagmi";
import toast from "react-hot-toast";
import { ADDR, E18, MARKETS, b32, marketAbi, oracleAbi, routerAbi } from "@/config/contracts";
import { errMsg, fmtPrice, fmtUsd } from "@/lib/format";
import { getAgentClients, useOneClick } from "@/lib/oneclick";

const COMBOS = MARKETS.flatMap((m) => [
  { symbol: m.symbol, isLong: true },
  { symbol: m.symbol, isLong: false },
]);

export default function PositionsTable() {
  const { address } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const oneClick = useOneClick();

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
    try {
      // 1% slippage bound on closes
      const acceptable = mark > 0n
        ? isLong ? mark - mark / 100n : mark + mark / 100n
        : 0n;
      const fee = minExecFee ?? 0n;

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
      const hash = await writeContractAsync({
        address: ADDR.router, abi: routerAbi, functionName: "createDecreaseRequest",
        args: [b32(symbol), isLong, sizeUsd, acceptable],
        value: fee,
      });
      await client.waitForTransactionReceipt({ hash });
      toast.success("Close queued");
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-panel">
      <h3 className="border-b border-line px-3.5 py-3 text-xs uppercase tracking-widest text-muted">
        Positions
      </h3>
      {rows.length === 0 ? (
        <div className="px-3.5 py-4 text-[13px] text-muted">No open positions</div>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[11.5px] font-medium text-muted">
              {["Market", "Side", "Size", "Collateral", "Entry", "Mark", "PnL", ""].map((h) => (
                <th key={h} className="border-b border-line px-3.5 py-2">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const entry = (r.pos.sizeUsd * E18) / r.pos.sizeTokens;
              return (
                <tr key={r.symbol + r.isLong} className="border-b border-line last:border-0">
                  <td className="px-3.5 py-2.5">{r.symbol}-PERP</td>
                  <td className={`px-3.5 py-2.5 ${r.isLong ? "text-green" : "text-red"}`}>
                    {r.isLong ? "Long" : "Short"}
                  </td>
                  <td className="px-3.5 py-2.5">{fmtUsd(r.pos.sizeUsd, 0)} USD</td>
                  <td className="px-3.5 py-2.5">{fmtUsd(r.pos.collateralUsd)}</td>
                  <td className="px-3.5 py-2.5">${fmtPrice(entry)}</td>
                  <td className="px-3.5 py-2.5">{r.mark > 0n ? `$${fmtPrice(r.mark)}` : "—"}</td>
                  <td className={`px-3.5 py-2.5 ${r.pnl >= 0n ? "text-green" : "text-red"}`}>
                    {r.pnl >= 0n ? "+" : ""}{fmtUsd(r.pnl)}
                  </td>
                  <td className="px-3.5 py-2.5">
                    <button
                      onClick={() => close(r.symbol, r.isLong, r.pos.sizeUsd, r.mark)}
                      className="rounded-md border border-line bg-panel2 px-3 py-1 text-xs hover:border-red hover:text-red"
                    >
                      Close
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
