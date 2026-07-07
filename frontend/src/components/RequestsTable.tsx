"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import toast from "react-hot-toast";
import { ADDR, parseB32, routerAbi } from "@/config/contracts";
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
  const { writeContractAsync } = useWriteContract();

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
      const hash = await writeContractAsync({
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
    <div className="overflow-hidden rounded-[10px] border border-line bg-panel">
      <h3 className="border-b border-line px-3.5 py-3 text-xs uppercase tracking-widest text-muted">
        Pending Orders (two-step execution)
      </h3>
      {rows.length === 0 ? (
        <div className="px-3.5 py-4 text-[13px] text-muted">No pending orders</div>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[11.5px] font-medium text-muted">
              {["#", "Type", "Market", "Side", "Size", "Status", ""].map((h) => (
                <th key={h} className="border-b border-line px-3.5 py-2">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="border-b border-line last:border-0">
                <td className="px-3.5 py-2.5">{String(r.id)}</td>
                <td className="px-3.5 py-2.5">{r.isIncrease ? "Open" : "Close"}</td>
                <td className="px-3.5 py-2.5">{r.symbol}-PERP</td>
                <td className={`px-3.5 py-2.5 ${r.isLong ? "text-green" : "text-red"}`}>
                  {r.isLong ? "Long" : "Short"}
                </td>
                <td className="px-3.5 py-2.5">{fmtUsd(r.sizeDeltaUsd, 0)} USD</td>
                <td className="px-3.5 py-2.5">Pending</td>
                <td className="px-3.5 py-2.5">
                  <button
                    onClick={() => cancel(r.id)}
                    className="rounded-md border border-line bg-panel2 px-3 py-1 text-xs hover:border-red hover:text-red"
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
