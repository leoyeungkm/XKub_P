"use client";

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatEther } from "viem";
import { useAccount, usePublicClient, useReadContract, useReadContracts } from "wagmi";
import toast from "react-hot-toast";
import { ADDR, CFG, b32, parseB32, routerAbi, triggerKey } from "@/config/contracts";
import { useKubWrite } from "@/lib/kubWrite";
import { errMsg, fmtNum, fmtPrice, fmtUsd } from "@/lib/format";
import { getAgentClients, useOneClick } from "@/lib/oneclick";
import { gaslessAvailable, submitGaslessOrder } from "@/lib/gasless";
import { usePositions, useHistory, refreshPositions, type PositionRow, type HistoryItem } from "@/lib/portfolio";
import { usePendingOpens, removePendingOpen, type PendingOpen } from "@/lib/optimistic";
import { useT } from "@/lib/i18n";
import TpSlModal from "./TpSlModal";

type Tab = "positions" | "orders" | "history";

export default function ActivityPanel() {
  const { address } = useAccount();
  const client = usePublicClient();
  const t = useT();
  const { writeContract } = useKubWrite();
  const oneClick = useOneClick();
  const positions = usePositions();
  const { data: history } = useHistory();
  const pendingOpens = usePendingOpens();
  // Drop a placeholder once its real position is on-chain.
  useEffect(() => {
    for (const pp of pendingOpens) {
      if (positions.some((r) => r.symbol === pp.symbol && r.isLong === pp.isLong)) {
        removePendingOpen(pp.symbol, pp.isLong);
      }
    }
  }, [positions, pendingOpens]);
  const pendingToShow = pendingOpens.filter(
    (pp) => !positions.some((r) => r.symbol === pp.symbol && r.isLong === pp.isLong),
  );

  const { data: minExecFee } = useReadContract({
    address: ADDR.router, abi: routerAbi, functionName: "minExecutionFee",
  });

  const pending = usePendingOrders();
  const [tab, setTab] = useState<Tab>("positions");
  const [closing, setClosing] = useState<Record<string, boolean>>({});

  const closeOne = async (p: PositionRow) => {
    if (!address || !client) return;
    const key = `${p.symbol}-${p.isLong}`;
    if (closing[key]) return; // already closing — ignore repeat clicks
    setClosing((s) => ({ ...s, [key]: true }));
    refreshPositions(); // start polling now so the row clears the moment it mines
    // Safety net: never let the button stick on "closing…" — clear after 15s
    // even if a refetch is slow (the catch clears sooner on failure).
    setTimeout(() => setClosing((s) => { const n = { ...s }; delete n[key]; return n; }), 15000);
    try {
      const fee = minExecFee ?? 0n;
      // Market close: no price bound. The keeper fills at a fresh signed price
      // (validated ≤20% of last on-chain), so a tight slippage here only causes
      // spurious "price bound" reverts when the price ticks between click & fill.
      const acceptable = 0n;
      // Gasless close: agent signs, relayer submits & pays gas. If it fails
      // (transient relayer/nonce race), retry once with a fresh nonce+price —
      // do NOT fall back to the wallet path, which needs owner KUB + an execution
      // fee the gasless user hasn't budgeted ("total cost exceeds balance").
      if (oneClick.active && gaslessAvailable()) {
        const gasless = () => submitGaslessOrder({
          owner: address, symbol: p.symbol, isLong: p.isLong, isIncrease: false,
          collateralTokens: 0n, sizeDeltaUsd: p.sizeUsd, acceptablePrice: acceptable, client,
        });
        await gasless(); // submitGaslessOrder retries once internally with a nonce guard
        toast.success(t("toast.closeSubmitted"));
        refreshPositions();
        return;
      }
      if (oneClick.active && oneClick.agentGas >= fee * 2n) {
        const agents = getAgentClients(address)!;
        const hash = await agents.wallet.writeContract({
          address: ADDR.router, abi: routerAbi, functionName: "createDecreaseRequestFor",
          args: [address, b32(p.symbol), p.isLong, p.sizeUsd, acceptable], value: fee,
        });
        await client.waitForTransactionReceipt({ hash });
        toast.success(t("toast.closeQueued"));
        refreshPositions();
        return;
      }
      const hash = await writeContract({
        address: ADDR.router, abi: routerAbi, functionName: "createDecreaseRequest",
        args: [b32(p.symbol), p.isLong, p.sizeUsd, acceptable], value: fee,
      });
      await client.waitForTransactionReceipt({ hash });
      toast.success(t("toast.closeQueued"));
      refreshPositions();
      // leave `closing` set on success — the row disappears on the next refetch
    } catch (e) {
      toast.error(errMsg(e));
      setClosing((s) => { const n = { ...s }; delete n[key]; return n; }); // allow retry
    }
  };

  const closeAll = async () => {
    for (const p of positions) await closeOne(p);
  };

  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: "positions", label: t("tab.positions"), count: positions.length + pendingToShow.length },
    { id: "orders", label: t("tab.orders"), count: pending.rows.length },
    { id: "history", label: t("tab.history") },
  ];

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      <div className="flex items-center gap-0.5 border-b border-line px-2 pt-2">
        {TABS.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={`flex items-center gap-1.5 rounded-t-md px-3.5 py-2 text-[13px] font-medium transition-colors ${
              tab === tb.id ? "bg-panel2 text-fg" : "text-muted hover:text-fg"
            }`}
          >
            {tb.label}
            {tb.count !== undefined && tb.count > 0 && (
              <span className="tnum rounded bg-bg px-1.5 py-0.5 text-[10px]">{tb.count}</span>
            )}
          </button>
        ))}
        <div className="flex-1" />
        {tab === "positions" && positions.length > 0 && (
          <button onClick={closeAll} className="mb-1 mr-1 rounded border border-line px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-red/50 hover:text-red">
            {t("pos.closeAll")}
          </button>
        )}
      </div>

      {tab === "positions" && <PositionsView rows={positions} pending={pendingToShow} onClose={closeOne} closing={closing} />}
      {tab === "orders" && <OrdersView rows={pending.rows} onCancel={pending.cancel} />}
      {tab === "history" && <HistoryView rows={history ?? []} />}
    </div>
  );
}

// ─── Positions ─────────────────────────────────────────────────────────────

const HEAD_KEYS = ["pos.h.market", "pos.h.size", "pos.h.side", "pos.h.value", "pos.h.entry", "pos.h.mark", "pos.h.margin", "pos.h.pnl", "pos.h.liq", "pos.h.tpsl", ""];

function PositionsView({ rows, pending, onClose, closing }: { rows: PositionRow[]; pending: PendingOpen[]; onClose: (p: PositionRow) => void; closing: Record<string, boolean> }) {
  const { address } = useAccount();
  const t = useT();
  const [tpsl, setTpsl] = useState<PositionRow | null>(null);

  // Read each position's TP/SL trigger
  const { data: trigData } = useReadContracts({
    contracts: address ? rows.map((r) => ({
      address: ADDR.router, abi: routerAbi, functionName: "triggers",
      args: [triggerKey(address, r.symbol, r.isLong)],
    })) as never[] : [],
    query: { enabled: !!address && rows.length > 0, refetchInterval: 10000 },
  });
  const trigOf = (i: number) => {
    const tr = trigData?.[i]?.result as readonly [bigint, bigint, bigint, boolean] | undefined;
    return tr && tr[3] ? { tp: tr[0], sl: tr[1] } : null;
  };

  if (rows.length === 0 && pending.length === 0) return <Empty>No open positions</Empty>;
  const pendRow = (pp: PendingOpen) => {
    const lev = pp.collateralUsd > 0n ? Number(pp.sizeUsd) / Number(pp.collateralUsd) : 0;
    return (
      <tr key={`pending-${pp.symbol}-${pp.isLong}`} className="border-b border-lineSoft last:border-0 bg-panel2/30 text-mutedDim">
        <td className="px-3 py-2.5 font-medium">{pp.symbol}-PERP</td>
        <td className="tnum px-3 py-2.5">—</td>
        <td className="px-3 py-2.5">
          <span className={`tnum w-fit rounded px-1.5 py-0.5 text-[11px] font-medium ${pp.isLong ? "bg-greenDim text-green" : "bg-redDim text-red"}`}>
            {pp.isLong ? t("trade.long") : t("trade.short")} {lev.toFixed(0)}x
          </span>
        </td>
        <td className="tnum px-3 py-2.5">{fmtUsd(pp.sizeUsd)} USD</td>
        <td className="tnum px-3 py-2.5">${fmtPrice(pp.entry)}</td>
        <td className="px-3 py-2.5">—</td>
        <td className="tnum px-3 py-2.5">{fmtUsd(pp.collateralUsd)} USD</td>
        <td className="px-3 py-2.5" colSpan={4}>
          <span className="inline-flex items-center gap-1.5 rounded bg-panel2 px-2 py-0.5 text-[11px] text-accent">
            <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-accent/30 border-t-accent [animation-duration:2.5s]" />
            {t("pos.confirming")}
          </span>
        </td>
      </tr>
    );
  };
  return (
    <div className="overflow-x-auto">
      {tpsl && <TpSlModal pos={tpsl} onClose={() => setTpsl(null)} />}
      <table className="w-full min-w-[1160px] table-fixed text-[12.5px]">
        {/* Fixed column widths so live price/PnL updates never re-flow the row. */}
        <colgroup>
          {[92, 80, 116, 112, 92, 92, 116, 150, 104, 100, 96].map((w, i) => (
            <col key={i} style={{ width: w }} />
          ))}
        </colgroup>
        <thead>
          <tr className="eyebrow text-left">
            {HEAD_KEYS.map((h, i) => <th key={i} className="whitespace-nowrap border-b border-line px-3 py-2 font-normal">{h ? t(h) : ""}</th>)}
          </tr>
        </thead>
        <tbody>
          {pending.map(pendRow)}
          {rows.map((p, i) => {
            const trig = trigOf(i);
            const lev = p.collateralUsd > 0n ? Number(p.sizeUsd) / Number(p.collateralUsd) : 0;
            const retPct = p.collateralUsd > 0n ? (Number(p.pnl) / Number(p.collateralUsd)) * 100 : 0;
            const move = 1 / lev - 0.01;
            const entryN = Number(formatEther(p.entry));
            const liq = p.isLong ? entryN * (1 - move) : entryN * (1 + move);
            const up = p.pnl >= 0n;
            const isClosing = !!closing[`${p.symbol}-${p.isLong}`];
            return (
              <tr key={p.symbol + p.isLong} className={`border-b border-lineSoft last:border-0 ${isClosing ? "bg-panel2/30 text-mutedDim" : "hover:bg-panel2/40"}`}>
                <td className="px-3 py-2.5 font-medium">{p.symbol}-PERP</td>
                <td className="tnum px-3 py-2.5">{fmtNum(Number(formatEther(p.sizeTokens)), 4)}</td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-col gap-1">
                    <span className={`tnum w-fit rounded px-1.5 py-0.5 text-[11px] font-medium ${p.isLong ? "bg-greenDim text-green" : "bg-redDim text-red"}`}>
                      {p.isLong ? t("trade.long") : t("trade.short")} {lev.toFixed(0)}x
                    </span>
                    <span className="eyebrow !tracking-normal text-mutedDim">{t("pos.isolated")}</span>
                  </div>
                </td>
                <td className="tnum px-3 py-2.5">{fmtUsd(p.sizeUsd)} USD</td>
                <td className="tnum px-3 py-2.5">${fmtPrice(p.entry)}</td>
                <td className="tnum px-3 py-2.5">{p.mark > 0n ? `$${fmtPrice(p.mark)}` : "—"}</td>
                <td className="tnum px-3 py-2.5">{fmtUsd(p.collateralUsd)} USD</td>
                <td className={`tnum px-3 py-2.5 font-medium ${up ? "text-green" : "text-red"}`}>
                  {up ? "+" : ""}{fmtUsd(p.pnl)} <span className="text-[11px] opacity-80">({up ? "+" : ""}{retPct.toFixed(2)}%)</span>
                </td>
                <td className="tnum px-3 py-2.5">{lev > 1 ? `$${fmtNum(liq, liq >= 100 ? 1 : 4)}` : "—"}</td>
                <td className="px-3 py-2.5">
                  {trig ? (
                    <button onClick={() => setTpsl(p)} className="flex flex-col gap-0.5 text-left transition-opacity hover:opacity-80" title={t("pos.editTpSl")}>
                      <span className="tnum text-[11px] text-green">
                        TP {trig.tp > 0n ? `$${fmtPrice(trig.tp)}` : "—"}
                      </span>
                      <span className="tnum text-[11px] text-red">
                        SL {trig.sl > 0n ? `$${fmtPrice(trig.sl)}` : "—"}
                      </span>
                    </button>
                  ) : (
                    <button onClick={() => setTpsl(p)} className="rounded border border-line px-2 py-1 text-[11px] text-muted transition-colors hover:border-accent/50 hover:text-accent">
                      {t("pos.setTpSl")}
                    </button>
                  )}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <button
                    onClick={() => onClose(p)}
                    disabled={isClosing}
                    className="inline-flex items-center gap-1.5 rounded border border-line px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-red/50 hover:text-red disabled:opacity-70"
                  >
                    {isClosing && <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-muted/30 border-t-muted [animation-duration:2.5s]" />}
                    {isClosing ? t("pos.closing") : t("pos.closeMarket")}
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
  const t = useT();
  const { writeContract } = useKubWrite();

  const { data: rows = [], refetch } = useQuery({
    queryKey: ["activityPending", address],
    enabled: !!address && !!client,
    refetchInterval: 10000,
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
      const hash = await writeContract({ address: ADDR.router, abi: routerAbi, functionName: "cancelRequest", args: [id] });
      await client.waitForTransactionReceipt({ hash });
      toast.success(t("ord.cancelled"));
      refetch();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  return { rows, cancel };
}

function OrdersView({ rows, onCancel }: { rows: ReturnType<typeof usePendingOrders>["rows"]; onCancel: (id: bigint) => void }) {
  const t = useT();
  if (rows.length === 0) return <Empty>No pending orders</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="eyebrow text-left">
            {["#", t("ord.h.type"), t("pos.h.market"), t("pos.h.side"), t("pos.h.size"), t("ord.h.status"), ""].map((h, i) => (
              <th key={h} className="border-b border-line px-3 py-2 font-normal">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r.id)} className="border-b border-lineSoft last:border-0 hover:bg-panel2/40">
              <td className="tnum px-3 py-2.5 text-muted">{String(r.id)}</td>
              <td className="px-3 py-2.5">{r.isIncrease ? t("ord.open") : t("ord.close")}</td>
              <td className="px-3 py-2.5 font-medium">{r.symbol}-PERP</td>
              <td className="px-3 py-2.5">
                <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${r.isLong ? "bg-greenDim text-green" : "bg-redDim text-red"}`}>
                  {r.isLong ? t("trade.long") : t("trade.short")}
                </span>
              </td>
              <td className="tnum px-3 py-2.5">{fmtUsd(r.sizeDeltaUsd, 0)} USD</td>
              <td className="px-3 py-2.5 text-accent">{t("ord.pending")}</td>
              <td className="px-3 py-2.5 text-right">
                <button onClick={() => onCancel(r.id)} className="rounded border border-line px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-red/50 hover:text-red">
                  {t("common.cancel")}
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

const fmtTime = (ts?: number) => {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function HistoryView({ rows }: { rows: HistoryItem[] }) {
  const t = useT();
  const trades = rows.filter((h) => h.kind === "open" || h.kind === "close" || h.kind === "liquidation");
  if (trades.length === 0) return <Empty>No trade history yet</Empty>;
  const HEAD = [t("hist.h.time"), t("pos.h.market"), t("pos.h.size"), t("pos.h.side"), t("hist.h.price"), t("hist.h.value"), t("pos.h.margin"), t("hist.h.fee"), t("hist.h.pnl"), t("hist.h.realized"), "TXN"];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[840px] text-[12.5px]">
        <thead>
          <tr className="eyebrow text-left">
            {HEAD.map((h) => <th key={h} className="whitespace-nowrap border-b border-line px-3 py-2 font-normal">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {trades.map((h, i) => {
            const kindKey = h.kind === "open" ? "Open" : h.kind === "close" ? "Close" : "Liq";
            const label = h.isLong === undefined ? "" : t(`hist.${kindKey.toLowerCase()}${h.isLong ? "Long" : "Short"}`);
            const tokens = h.sizeUsd && h.price && h.price > 0n
              ? Number(formatEther(h.sizeUsd)) / Number(formatEther(h.price)) : null;
            const realized = h.kind === "close" && h.pnlUsd !== undefined
              ? h.pnlUsd - (h.feeUsd ?? 0n) : undefined;
            const pnlUp = (h.pnlUsd ?? 0n) >= 0n;
            const realUp = (realized ?? 0n) >= 0n;
            return (
              <tr key={h.txHash + i} className="border-b border-lineSoft last:border-0 hover:bg-panel2/40">
                <td className="tnum whitespace-nowrap px-3 py-2.5 text-muted">{fmtTime(h.timestamp)}</td>
                <td className="px-3 py-2.5 font-medium">{h.symbol}-PERP</td>
                <td className="tnum px-3 py-2.5">{tokens !== null ? fmtNum(tokens, 4) : "—"}</td>
                <td className="whitespace-nowrap px-3 py-2.5">
                  <span className={`${h.isLong ? "text-green" : "text-red"}`}>{label}</span>
                </td>
                <td className="tnum px-3 py-2.5">{h.price ? `$${fmtPrice(h.price)}` : "—"}</td>
                <td className="tnum px-3 py-2.5">{h.sizeUsd ? `${fmtUsd(h.sizeUsd)} USD` : "—"}</td>
                <td className="tnum px-3 py-2.5">{h.collateralUsd !== undefined ? `${fmtUsd(h.collateralUsd)} USD` : "—"}</td>
                <td className="tnum px-3 py-2.5 text-muted">{h.feeUsd !== undefined ? fmtUsd(h.feeUsd) : "—"}</td>
                <td className={`tnum px-3 py-2.5 ${h.pnlUsd !== undefined ? (pnlUp ? "text-green" : "text-red") : "text-mutedDim"}`}>
                  {h.pnlUsd !== undefined ? `${pnlUp ? "+" : ""}${fmtUsd(h.pnlUsd)}` : "—"}
                </td>
                <td className={`tnum px-3 py-2.5 font-medium ${realized !== undefined ? (realUp ? "text-green" : "text-red") : "text-mutedDim"}`}>
                  {realized !== undefined ? `${realUp ? "+" : ""}${fmtUsd(realized)}` : "—"}
                </td>
                <td className="px-3 py-2.5">
                  {h.txHash && CFG.explorer ? (
                    <a
                      href={`${CFG.explorer}/tx/${h.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={h.txHash}
                      className="tnum text-accent transition-opacity hover:opacity-80"
                    >
                      {h.txHash.slice(0, 6)}…{h.txHash.slice(-4)} ↗
                    </a>
                  ) : "—"}
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
