"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { formatEther } from "viem";
import PositionsTable from "@/components/PositionsTable";
import { fmtUsd, fmtPrice } from "@/lib/format";
import { tokenToUsd } from "@/config/contracts";
import { useAccountSummary, useHistory, realizedPnl, type HistoryItem } from "@/lib/portfolio";
import { useOneClickActions } from "@/lib/oneclickActions";

const TABS = ["Positions", "Trade History", "Deposits/Withdrawals", "Funds Details"] as const;
type Tab = (typeof TABS)[number];

const signed = (v: bigint) => `${v >= 0n ? "+" : "-"}${fmtUsd(v < 0n ? -v : v)}`;
const cls = (v: bigint) => (v >= 0n ? "text-green" : "text-red");

export default function Portfolio() {
  const { isConnected } = useAccount();
  const s = useAccountSummary();
  const { data: history } = useHistory();
  const realized = realizedPnl(history);
  const [tab, setTab] = useState<Tab>("Positions");
  const [modal, setModal] = useState<null | "deposit" | "withdraw">(null);

  if (!isConnected) {
    return (
      <div className="grid place-items-center py-32 text-[13px] text-muted">
        Connect a wallet to view your portfolio.
      </div>
    );
  }

  return (
    <main className="mx-auto flex max-w-[1100px] flex-col gap-2.5 p-2.5">
      {/* Account value card */}
      <div className="rounded-lg border border-line bg-panel p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="eyebrow mb-1.5">Estimated Total Value</div>
            <div className="tnum text-[34px] font-semibold leading-none">
              {fmtUsd(s.accountValueUsd)} <span className="text-[16px] text-mutedDim">USD</span>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setModal("deposit")}
              className="rounded-md bg-accent px-5 py-2.5 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90"
            >
              Deposit
            </button>
            <button
              onClick={() => setModal("withdraw")}
              className="rounded-md border border-line px-5 py-2.5 text-[13px] font-semibold text-fg transition-colors hover:border-accent/40"
            >
              Withdraw
            </button>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Stat label="Available Balance" value={`${fmtUsd(s.tradingUsd)} USD`} />
          <Stat label="Futures Bonus" value="0.00 USD" muted />
          <Stat label="Total Realized PnL" value={`${signed(realized)} USD`} valueClass={cls(realized)} />
          <Stat label="Total Unrealized PnL" value={`${signed(s.unrealizedUsd)} USD`} valueClass={cls(s.unrealizedUsd)} />
        </div>
      </div>

      {/* Tabs */}
      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        <div className="flex gap-0.5 border-b border-line px-2 pt-2">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-t-md px-3.5 py-2 text-[12.5px] font-medium transition-colors ${
                tab === t ? "bg-panel2 text-fg" : "text-muted hover:text-fg"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === "Positions" && (
          <div className="p-0">
            {/* PositionsTable already renders its own card border; wrap plainly */}
            <div className="[&>div]:rounded-none [&>div]:border-0">
              <PositionsTable />
            </div>
          </div>
        )}

        {tab === "Trade History" && (
          <HistoryTable
            rows={(history ?? []).filter((h) => h.kind === "open" || h.kind === "close" || h.kind === "liquidation")}
            columns={["Time", "Action", "Market", "Side", "Size", "Price", "PnL"]}
            render={(h) => (
              <>
                <Td muted>#{String(h.block)}</Td>
                <Td>{h.kind === "open" ? "Open" : h.kind === "close" ? "Close" : "Liquidated"}</Td>
                <Td>{h.symbol}-PERP</Td>
                <Td><Side isLong={h.isLong} /></Td>
                <Td mono>{h.sizeUsd ? fmtUsd(h.sizeUsd, 0) : "—"}</Td>
                <Td mono>{h.price ? `$${fmtPrice(h.price)}` : "—"}</Td>
                <Td mono className={h.pnlUsd !== undefined ? cls(h.pnlUsd) : ""}>
                  {h.pnlUsd !== undefined ? signed(h.pnlUsd) : "—"}
                </Td>
              </>
            )}
          />
        )}

        {tab === "Deposits/Withdrawals" && (
          <HistoryTable
            rows={(history ?? []).filter((h) => h.kind === "deposit" || h.kind === "withdraw")}
            columns={["Time", "Type", "Amount"]}
            render={(h) => (
              <>
                <Td muted>#{String(h.block)}</Td>
                <Td className={h.kind === "deposit" ? "text-green" : "text-red"}>
                  {h.kind === "deposit" ? "Deposit" : "Withdraw"}
                </Td>
                <Td mono>{h.amountUsd ? `${fmtUsd(h.amountUsd)} KUSDT` : "—"}</Td>
              </>
            )}
          />
        )}

        {tab === "Funds Details" && (
          <div className="grid grid-cols-1 gap-px bg-line p-px sm:grid-cols-2">
            <FundRow label="Wallet KUSDT" value={s.walletUsd} />
            <FundRow label="Trading account (available)" value={s.tradingUsd} />
            <FundRow label="Margin in positions" value={s.positionMarginUsd} />
            <FundRow label="Unrealized PnL" value={s.unrealizedUsd} signed />
          </div>
        )}
      </div>

      {modal && <CollateralModal mode={modal} onClose={() => setModal(null)} available={s.tradingUsd} wallet={s.walletUsd} />}
    </main>
  );
}

function Stat({ label, value, valueClass, muted }: { label: string; value: string; valueClass?: string; muted?: boolean }) {
  return (
    <div className="rounded-md bg-bg px-3 py-2.5">
      <div className="eyebrow mb-1">{label}</div>
      <div className={`tnum text-[15px] font-medium ${valueClass ?? (muted ? "text-mutedDim" : "text-fg")}`}>{value}</div>
    </div>
  );
}

function FundRow({ label, value, signed: isSigned }: { label: string; value: bigint; signed?: boolean }) {
  return (
    <div className="flex items-center justify-between bg-panel px-4 py-3">
      <span className="text-[12.5px] text-muted">{label}</span>
      <span className={`tnum text-[13px] ${isSigned ? cls(value) : ""}`}>
        {isSigned ? signed(value) : fmtUsd(value)} <span className="text-[10px] text-mutedDim">USD</span>
      </span>
    </div>
  );
}

function Side({ isLong }: { isLong?: boolean }) {
  if (isLong === undefined) return <>—</>;
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${isLong ? "bg-greenDim text-green" : "bg-redDim text-red"}`}>
      {isLong ? "Long" : "Short"}
    </span>
  );
}

function Td({ children, mono, muted, className = "" }: { children: React.ReactNode; mono?: boolean; muted?: boolean; className?: string }) {
  return (
    <td className={`px-3.5 py-2.5 ${mono ? "tnum" : ""} ${muted ? "text-muted" : ""} ${className}`}>{children}</td>
  );
}

function HistoryTable({ rows, columns, render }: {
  rows: HistoryItem[];
  columns: string[];
  render: (h: HistoryItem) => React.ReactNode;
}) {
  if (rows.length === 0) {
    return <div className="px-3.5 py-8 text-center text-[12px] text-mutedDim">No records yet</div>;
  }
  return (
    <table className="w-full text-[12.5px]">
      <thead>
        <tr className="eyebrow text-left">
          {columns.map((c) => (
            <th key={c} className="border-b border-line px-3.5 py-2 font-normal">{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((h, i) => (
          <tr key={h.txHash + i} className="border-b border-lineSoft last:border-0 hover:bg-panel2/40">
            {render(h)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CollateralModal({ mode, onClose, available, wallet }: {
  mode: "deposit" | "withdraw"; onClose: () => void; available: bigint; wallet: bigint;
}) {
  const oc = useOneClickActions();
  const [amount, setAmount] = useState("");
  const max = mode === "deposit" ? wallet : available;

  const submit = async () => {
    const ok = await oc.move(mode === "deposit" ? "depositCollateral" : "withdrawCollateral", amount);
    if (ok) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-[380px] overflow-hidden rounded-xl border border-line bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line bg-panel2 px-5 py-3.5">
          <span className="text-[14px] font-semibold">{mode === "deposit" ? "Deposit to trading account" : "Withdraw to wallet"}</span>
          <button onClick={onClose} className="text-muted hover:text-fg">✕</button>
        </div>
        <div className="flex flex-col gap-3 p-5">
          <div className="flex justify-between text-[11px]">
            <span className="eyebrow">Amount</span>
            <button className="tnum text-accent" onClick={() => setAmount(String(Math.floor(Number(formatEther(tokenToUsd(max))) * 100) / 100))}>
              Max {fmtUsd(max)}
            </button>
          </div>
          <div className="flex items-center rounded-md border border-line bg-bg px-3 focus-within:border-accent/60">
            <input
              type="number" min="0" placeholder="0.00" value={amount} autoFocus
              onChange={(e) => setAmount(e.target.value)}
              className="tnum w-full bg-transparent py-2.5 text-[15px] outline-none"
            />
            <span className="eyebrow">KUSDT</span>
          </div>
          <button
            onClick={submit} disabled={oc.busy}
            className="rounded-md bg-accent py-2.5 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {oc.busy ? "Confirming…" : mode === "deposit" ? "Deposit" : "Withdraw"}
          </button>
          <p className="text-[11px] leading-relaxed text-mutedDim">
            {mode === "deposit"
              ? "Moves KUSDT into your on-chain trading account so 1-click orders draw from it."
              : "Returns available trading balance to your wallet. Margin locked in open positions isn't withdrawable."}
          </p>
        </div>
      </div>
    </div>
  );
}
