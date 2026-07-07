"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient } from "wagmi";
import toast from "react-hot-toast";
import { ADDR, parseB32, routerAbi } from "@/config/contracts";
import { useKubWrite } from "@/lib/kubWrite";
import { errMsg, fmtUsd } from "@/lib/format";

type Req = {
  id: bigint;
  isIncrease: boolean;
  isLong: boolean;
  symbol: string;
  sizeDeltaUsd: bigint;
};

export default function RequestsTable() {
  const { address } = useAccount();
  const client = usePublicClient();
  const { writeContract } = useKubWrite();

  const { data: rows = [], refetch } = useQuery({
    queryKey: ["pendingRequests", address],
    enabled: !!address && !!client,
    refetchInterval: 5000,
    queryFn: async (): Promise<Req[]> => {
      const count = await client!.readContract({
        address: ADDR.router, abi: routerAbi, functionName: "requestsCount",
      });
      const out: Req[] = [];
      const start = count > 30n ? count - 30n : 0n;
      for (let i = count - 1n; i >= start; i--) {
        const r = await client!.readContract({
          address: ADDR.router, abi: routerAbi, functionName: "requests", args: [i],
        });
        // [owner, marketId, isLong, isIncrease, collateralTokens, sizeDeltaUsd, acceptablePrice, executionFee, createdAt, status]
        if (r[0].toLowerCase() === address!.toLowerCase() && r[9] === 0) {
          out.push({ id: i, symbol: parseB32(r[1]), isLong: r[2], isIncrease: r[3], sizeDeltaUsd: r[5] });
        }
        if (i === 0n) break;
      }
      return out;
    },
  });

  const cancel = async (id: bigint) => {
    if (!client) return;
    try {
      const hash = await writeContract({
        address: ADDR.router, abi: routerAbi, functionName: "cancelRequest", args: [id],
      });
      await client.waitForTransactionReceipt({ hash });
      toast.success("Cancelled + refunded");
      refetch();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      <h3 className="eyebrow flex items-center gap-2 border-b border-line px-3.5 py-2.5">
        Pending Orders
        <span className="text-mutedDim">· two-step execution</span>
        {rows.length > 0 && (
          <span className="tnum ml-auto flex items-center gap-1.5 text-[10px] text-accent">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            {rows.length} queued
          </span>
        )}
      </h3>
      {rows.length === 0 ? (
        <div className="px-3.5 py-6 text-center text-[12px] text-mutedDim">No pending orders</div>
      ) : (
        <table className="w-full text-[12.5px]">
          <thead>
            <tr className="eyebrow text-left">
              {["#", "Type", "Market", "Side", "Size", "Status", ""].map((h) => (
                <th key={h} className="border-b border-line px-3.5 py-2 font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="border-b border-lineSoft transition-colors last:border-0 hover:bg-panel2/40">
                <td className="tnum px-3.5 py-2.5 text-muted">{String(r.id)}</td>
                <td className="px-3.5 py-2.5">{r.isIncrease ? "Open" : "Close"}</td>
                <td className="px-3.5 py-2.5 font-medium">{r.symbol}-PERP</td>
                <td className="px-3.5 py-2.5">
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${r.isLong ? "bg-greenDim text-green" : "bg-redDim text-red"}`}>
                    {r.isLong ? "Long" : "Short"}
                  </span>
                </td>
                <td className="tnum px-3.5 py-2.5">{fmtUsd(r.sizeDeltaUsd, 0)}</td>
                <td className="px-3.5 py-2.5">
                  <span className="text-accent">Pending</span>
                </td>
                <td className="px-3.5 py-2.5 text-right">
                  <button
                    onClick={() => cancel(r.id)}
                    className="rounded border border-line px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-red/50 hover:text-red"
                  >
                    Cancel
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
