"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatEther } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import toast from "react-hot-toast";
import { ADDR, b32, parseB32, routerAbi } from "@/config/contracts";
import { errMsg, fmtNum, fmtPrice, fmtUsd } from "@/lib/format";
import { getAgentClients, useOneClick } from "@/lib/oneclick";
import { usePositions, useHistory, type PositionRow, type HistoryItem } from "@/lib/portfolio";

type Tab = "positions" | "orders" | "history";

export default function ActivityPanel() {
  const { address } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const oneClick = useOneClick();
  const positions = usePositions();
  const { data: history } = useHistory();

  const { data: minExecFee } = useReadContract({
    address: ADDR.router, abi: routerAbi, functionName: "minExecutionFee",
  });

  const pending = usePendingOrders();
  const [tab, setTab] = useState<Tab>("positions");

  const closeOne = async (p: PositionRow) => {
    if (!address || !client) return;
    try {
      const fee = minExecFee ?? 0n;
      const acceptable = p.mark > 0n ? (p.isLong ? p.mark - p.mark / 100n : p.mark + p.mark / 100n) : 0n;
      if (oneClick.active && oneClick.agentGas >= fee * 2n) {
        const agents = getAgentClients(address)!;
        const hash = await agents.wallet.writeContract({
          address: ADDR.router, abi: routerAbi, functionName: "createDecreaseRequestFor",
          args: [address, b32(p.symbol), p.isLong, p.sizeUsd, acceptable], value: fee,
        });
        await client.waitForTransactionReceipt({ hash });
        toast.success("Close queued (1-click)");
        return;
      }
      const hash = await writeContractAsync({
        address: ADDR.router, abi: routerAbi, functionName: "createDecreaseRequest",
        args: [b32(p.symbol), p.isLong, p.sizeUsd, acceptable], value: fee,
      });
      await client.waitForTransactionReceipt({ hash });
      toast.success("Close queued");
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const closeAll = async () => {
    for (const p of positions) await closeOne(p);
  };

  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: "positions", label: "持有倉位", count: positions.length },
    { id: "orders", label: "當前委託", count: pending.rows.length },
    { id: "history", label: "交易歷史" },
  ];

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      <div className="flex items-center gap-0.5 border-b border-line px-2 pt-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 rounded-t-md px-3.5 py-2 text-[13px] font-medium transition-colors ${
              tab === t.id ? "bg-panel2 text-fg" : "text-muted hover:text-fg"
            }`}
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && (
              <span className="tnum rounded bg-bg px-1.5 py-0.5 text-[10px]">{t.count}</span>
            )}
          </button>
        ))}
        <div className="flex-1" />
        {tab === "positions" && positions.length > 0 && (
          <button onClick={closeAll} className="mb-1 mr-1 rounded border border-line px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-red/50 hover:text-red">
            關閉全部
          </button>
        )}
      </div>

      {tab === "positions" && <PositionsView rows={positions} onClose={closeOne} />}
      {tab === "orders" && <OrdersView rows={pending.rows} onCancel={pending.cancel} />}
      {tab === "history" && <HistoryView rows={history ?? []} />}
    </div>
  );
}

// ─── Positions ─────────────────────────────────────────────────────────────

const HEAD = ["幣種", "數量", "方向", "倉位價值", "開倉價格", "當前價格", "初始保證金", "倉位盈虧 (回報率)", "預估強平價", "止盈/止損", ""];

function PositionsView({ rows, onClose }: { rows: PositionRow[]; onClose: (p: PositionRow) => void }) {
  if (rows.length === 0) return <Empty>No open positions</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-[12.5px]">
        <thead>
          <tr className="eyebrow text-left">
            {HEAD.map((h) => <th key={h} className="whitespace-nowrap border-b border-line px-3 py-2 font-normal">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const lev = p.collateralUsd > 0n ? Number(p.sizeUsd) / Number(p.collateralUsd) : 0;
            const retPct = p.collateralUsd > 0n ? (Number(p.pnl) / Number(p.collateralUsd)) * 100 : 0;
            const move = 1 / lev - 0.01;
            const entryN = Number(formatEther(p.entry));
            const liq = p.isLong ? entryN * (1 - move) : entryN * (1 + move);
            const up = p.pnl >= 0n;
            return (
              <tr key={p.symbol + p.isLong} className="border-b border-lineSoft last:border-0 hover:bg-panel2/40">
                <td className="px-3 py-2.5 font-medium">{p.symbol}-PERP</td>
                <td className="tnum px-3 py-2.5">{fmtNum(Number(formatEther(p.sizeTokens)), 4)}</td>
                <td className="px-3 py-2.5">
                  <span className={`tnum rounded px-1.5 py-0.5 text-[11px] font-medium ${p.isLong ? "bg-greenDim text-green" : "bg-redDim text-red"}`}>
                    {p.isLong ? "做多" : "做空"} {lev.toFixed(0)}x
                  </span>
                </td>
                <td className="tnum px-3 py-2.5">{fmtUsd(p.sizeUsd)} USD</td>
                <td className="tnum px-3 py-2.5">${fmtPrice(p.entry)}</td>
                <td className="tnum px-3 py-2.5">{p.mark > 0n ? `$${fmtPrice(p.mark)}` : "—"}</td>
                <td className="tnum px-3 py-2.5">{fmtUsd(p.collateralUsd)} USD</td>
                <td className={`tnum px-3 py-2.5 font-medium ${up ? "text-green" : "text-red"}`}>
                  {up ? "+" : ""}{fmtUsd(p.pnl)} <span className="text-[11px] opacity-80">({up ? "+" : ""}{retPct.toFixed(2)}%)</span>
                </td>
                <td className="tnum px-3 py-2.5">{lev > 1 ? `$${fmtNum(liq, liq >= 100 ? 1 : 4)}` : "—"}</td>
                <td className="px-3 py-2.5 text-mutedDim">— / —</td>
                <td className="px-3 py-2.5 text-right">
                  <button onClick={() => onClose(p)} className="rounded border border-line px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-red/50 hover:text-red">
                    市價平倉
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Orders ────────────────────────────────────────────────────────────────

function usePendingOrders() {
  const { address } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const { data: rows = [], refetch } = useQuery({
    queryKey: ["activityPending", address],
    enabled: !!address && !!client,
    refetchInterval: 5000,
    queryFn: async () => {
      const count = await client!.readContract({ address: ADDR.router, abi: routerAbi, functionName: "requestsCount" });
      const out: { id: bigint; symbol: string; isLong: boolean; isIncrease: boolean; sizeDeltaUsd: bigint }[] = [];
      const start = count > 30n ? count - 30n : 0n;
      for (let i = count - 1n; i >= start; i--) {
        const r = await client!.readContract({ address: ADDR.router, abi: routerAbi, functionName: "requests", args: [i] });
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
      const hash = await writeContractAsync({ address: ADDR.router, abi: routerAbi, functionName: "cancelRequest", args: [id] });
      await client.waitForTransactionReceipt({ hash });
      toast.success("已取消並退款");
      refetch();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  return { rows, cancel };
}

function OrdersView({ rows, onCancel }: { rows: ReturnType<typeof usePendingOrders>["rows"]; onCancel: (id: bigint) => void }) {
  if (rows.length === 0) return <Empty>No pending orders</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="eyebrow text-left">
            {["#", "類型", "幣種", "方向", "數量", "狀態", ""].map((h) => (
              <th key={h} className="border-b border-line px-3 py-2 font-normal">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r.id)} className="border-b border-lineSoft last:border-0 hover:bg-panel2/40">
              <td className="tnum px-3 py-2.5 text-muted">{String(r.id)}</td>
              <td className="px-3 py-2.5">{r.isIncrease ? "開倉" : "平倉"}</td>
              <td className="px-3 py-2.5 font-medium">{r.symbol}-PERP</td>
              <td className="px-3 py-2.5">
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${r.isLong ? "bg-greenDim text-green" : "bg-redDim text-red"}`}>
                  {r.isLong ? "做多" : "做空"}
                </span>
              </td>
              <td className="tnum px-3 py-2.5">{fmtUsd(r.sizeDeltaUsd, 0)} USD</td>
              <td className="px-3 py-2.5 text-accent">等待執行</td>
              <td className="px-3 py-2.5 text-right">
                <button onClick={() => onCancel(r.id)} className="rounded border border-line px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-red/50 hover:text-red">
                  取消
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── History ───────────────────────────────────────────────────────────────

function HistoryView({ rows }: { rows: HistoryItem[] }) {
  const trades = rows.filter((h) => h.kind === "open" || h.kind === "close" || h.kind === "liquidation");
  if (trades.length === 0) return <Empty>No trade history yet</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="eyebrow text-left">
            {["區塊", "動作", "幣種", "方向", "數量", "價格", "盈虧"].map((h) => (
              <th key={h} className="border-b border-line px-3 py-2 font-normal">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {trades.map((h, i) => {
            const up = (h.pnlUsd ?? 0n) >= 0n;
            return (
              <tr key={h.txHash + i} className="border-b border-lineSoft last:border-0 hover:bg-panel2/40">
                <td className="tnum px-3 py-2.5 text-muted">#{String(h.block)}</td>
                <td className="px-3 py-2.5">{h.kind === "open" ? "開倉" : h.kind === "close" ? "平倉" : "強平"}</td>
                <td className="px-3 py-2.5">{h.symbol}-PERP</td>
                <td className="px-3 py-2.5">
                  {h.isLong === undefined ? "—" : (
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${h.isLong ? "bg-greenDim text-green" : "bg-redDim text-red"}`}>
                      {h.isLong ? "做多" : "做空"}
                    </span>
                  )}
                </td>
                <td className="tnum px-3 py-2.5">{h.sizeUsd ? `${fmtUsd(h.sizeUsd, 0)} USD` : "—"}</td>
                <td className="tnum px-3 py-2.5">{h.price ? `$${fmtPrice(h.price)}` : "—"}</td>
                <td className={`tnum px-3 py-2.5 ${h.pnlUsd !== undefined ? (up ? "text-green" : "text-red") : ""}`}>
                  {h.pnlUsd !== undefined ? `${up ? "+" : ""}${fmtUsd(h.pnlUsd)}` : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-3.5 py-8 text-center text-[12px] text-mutedDim">{children}</div>;
}
