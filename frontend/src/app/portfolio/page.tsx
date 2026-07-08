"use client";

import { useState } from "react";
import { useAccount, useReadContracts } from "wagmi";
import { formatEther } from "viem";
import PositionsTable from "@/components/PositionsTable";
import { fmtNum, fmtUsd, fmtPrice } from "@/lib/format";
import { ADDR, BASE_FEE_BPS, FEE_TIERS, marketAbi, tokenToUsd } from "@/config/contracts";
import { useAccountSummary, useHistory, realizedPnl, type HistoryItem } from "@/lib/portfolio";
import { useOneClickActions } from "@/lib/oneclickActions";
import { useT } from "@/lib/i18n";

const TABS = ["Positions", "Trade History", "Deposits/Withdrawals", "Funds Details"] as const;
type Tab = (typeof TABS)[number];
const TAB_KEY: Record<Tab, string> = {
  "Positions": "pf.tabPositions",
  "Trade History": "pf.tabTradeHistory",
  "Deposits/Withdrawals": "pf.tabDeposits",
  "Funds Details": "pf.tabFunds",
};

const signed = (v: bigint) => `${v >= 0n ? "+" : "-"}${fmtUsd(v < 0n ? -v : v)}`;
const cls = (v: bigint) => (v >= 0n ? "text-green" : "text-red");
const fmtTime = (ts?: number) => {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export default function Portfolio() {
  const t = useT();
  const { isConnected } = useAccount();
  const s = useAccountSummary();
  const { data: history } = useHistory();
  const realized = realizedPnl(history);
  const [tab, setTab] = useState<Tab>("Positions");
  const [modal, setModal] = useState<null | "deposit" | "withdraw">(null);

  if (!isConnected) {
    return (
      <div className="grid place-items-center py-32 text-[13px] text-muted">
        {t("pf.connectWallet")}
      </div>
    );
  }

  return (
    <main className="mx-auto flex max-w-[1100px] flex-col gap-2.5 p-2.5">
      {/* Account value card */}
      <div className="rounded-lg border border-line bg-panel p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="eyebrow mb-1.5">{t("pf.estTotalValue")}</div>
            <div className="tnum text-[34px] font-semibold leading-none">
              {fmtUsd(s.accountValueUsd)} <span className="text-[16px] text-mutedDim">USD</span>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setModal("deposit")}
              className="rounded-md bg-accent px-5 py-2.5 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90"
            >
              {t("pf.deposit")}
            </button>
            <button
              onClick={() => setModal("withdraw")}
              className="rounded-md border border-line px-5 py-2.5 text-[13px] font-semibold text-fg transition-colors hover:border-accent/40"
            >
              {t("pf.withdraw")}
            </button>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Stat label={t("pf.availableBalance")} value={`${fmtUsd(s.tradingUsd)} USD`} />
          <Stat label={t("pf.futuresBonus")} value="0.00 USD" muted />
          <Stat label={t("pf.totalRealizedPnl")} value={`${signed(realized)} USD`} valueClass={cls(realized)} />
          <Stat label={t("pf.totalUnrealizedPnl")} value={`${signed(s.unrealizedUsd)} USD`} valueClass={cls(s.unrealizedUsd)} />
        </div>
      </div>

      <VipCard />

      {/* Tabs */}
      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        <div className="flex gap-0.5 border-b border-line px-2 pt-2">
          {TABS.map((tb) => (
            <button
              key={tb}
              onClick={() => setTab(tb)}
              className={`rounded-t-md px-3.5 py-2 text-[12.5px] font-medium transition-colors ${
                tab === tb ? "bg-panel2 text-fg" : "text-muted hover:text-fg"
              }`}
            >
              {t(TAB_KEY[tb])}
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
            columns={[t("pf.colTime"), t("pf.colAction"), t("pf.colMarket"), t("pf.colSide"), t("pf.colSize"), t("pf.colPrice"), t("pf.colFee"), t("pf.colPnl"), t("pf.colRealized")]}
            render={(h) => {
              const realized = h.kind === "close" && h.pnlUsd !== undefined ? h.pnlUsd - (h.feeUsd ?? 0n) : undefined;
              return (
                <>
                  <Td muted>{fmtTime(h.timestamp)}</Td>
                  <Td>{h.kind === "open" ? t("pf.actionOpen") : h.kind === "close" ? t("pf.actionClose") : t("pf.actionLiquidated")}</Td>
                  <Td>{h.symbol}-PERP</Td>
                  <Td><Side isLong={h.isLong} /></Td>
                  <Td mono>{h.sizeUsd ? fmtUsd(h.sizeUsd, 0) : "—"}</Td>
                  <Td mono>{h.price ? `$${fmtPrice(h.price)}` : "—"}</Td>
                  <Td mono className="text-muted">{h.feeUsd !== undefined ? fmtUsd(h.feeUsd) : "—"}</Td>
                  <Td mono className={h.pnlUsd !== undefined ? cls(h.pnlUsd) : ""}>
                    {h.pnlUsd !== undefined ? signed(h.pnlUsd) : "—"}
                  </Td>
                  <Td mono className={realized !== undefined ? cls(realized) : ""}>
                    {realized !== undefined ? signed(realized) : "—"}
                  </Td>
                </>
              );
            }}
          />
        )}

        {tab === "Deposits/Withdrawals" && (
          <HistoryTable
            rows={(history ?? []).filter((h) => h.kind === "deposit" || h.kind === "withdraw")}
            columns={[t("pf.colTime"), t("pf.colType"), t("pf.colAmount")]}
            render={(h) => (
              <>
                <Td muted>{fmtTime(h.timestamp)}</Td>
                <Td className={h.kind === "deposit" ? "text-green" : "text-red"}>
                  {h.kind === "deposit" ? t("pf.deposit") : t("pf.withdraw")}
                </Td>
                <Td mono>{h.amountUsd ? `${fmtUsd(h.amountUsd)} KUSDT` : "—"}</Td>
              </>
            )}
          />
        )}

        {tab === "Funds Details" && (
          <div className="grid grid-cols-1 gap-px bg-line p-px sm:grid-cols-2">
            <FundRow label={t("pf.walletKusdt")} value={s.walletUsd} />
            <FundRow label={t("pf.tradingAvailable")} value={s.tradingUsd} />
            <FundRow label={t("pf.marginInPositions")} value={s.positionMarginUsd} />
            <FundRow label={t("pf.unrealizedPnl")} value={s.unrealizedUsd} signed />
          </div>
        )}
      </div>

      {modal && <CollateralModal mode={modal} onClose={() => setModal(null)} available={s.tradingUsd} wallet={s.walletUsd} />}
    </main>
  );
}

function VipCard() {
  const t = useT();
  const { address } = useAccount();
  const { data } = useReadContracts({
    contracts: address ? [
      { address: ADDR.market, abi: marketAbi, functionName: "effectiveTier", args: [address] },
      { address: ADDR.market, abi: marketAbi, functionName: "weightedVolumeUsd", args: [address] },
    ] as never[] : [],
    query: { enabled: !!address, refetchInterval: 10000 },
  });
  const tier = (data?.[0]?.result as number | undefined) ?? 0;
  const volume = Number(formatEther((data?.[1]?.result as bigint | undefined) ?? 0n));

  const feeAt = (discountBps: number) => (BASE_FEE_BPS * (1 - discountBps / 10000) / 100).toFixed(4);
  const next = FEE_TIERS.find((ft) => ft.tier === tier + 1);
  const progress = next && next.volumeUsd > 0 ? Math.min(100, (volume / next.volumeUsd) * 100) : 100;

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      <h3 className="eyebrow flex items-center justify-between border-b border-line px-3.5 py-2.5">
        <span>{t("pf.feeTier")}</span>
        <span className="tnum rounded bg-accentDim px-2 py-0.5 text-[11px] font-medium text-accent">
          {FEE_TIERS.find((ft) => ft.tier === tier)?.name ?? "Standard"}
        </span>
      </h3>
      <div className="flex flex-col gap-3 p-3.5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="eyebrow mb-1">{t("pf.volume14d")}</div>
            <div className="tnum text-[20px] font-semibold">{fmtNum(volume, 0)} <span className="text-[12px] text-mutedDim">USD</span></div>
          </div>
          {next ? (
            <div className="text-right text-[12px] text-muted">
              {t("pf.toReachA")}{next.name}{t("pf.toReachB")}<span className="tnum text-fg">{fmtNum(Math.max(0, next.volumeUsd - volume), 0)}</span> USD
            </div>
          ) : (
            <div className="text-[12px] text-accent">{t("pf.maxTier")}</div>
          )}
        </div>
        {next && (
          <div className="h-1.5 overflow-hidden rounded-full bg-panel2">
            <div className="h-full bg-accent transition-all duration-500" style={{ width: `${progress}%` }} />
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="eyebrow text-left">
                {[t("pf.thTier"), t("pf.thVolume"), t("pf.thFeeRate"), t("pf.thDiscount")].map((h) => (
                  <th key={h} className="whitespace-nowrap border-b border-line px-2.5 py-1.5 font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {FEE_TIERS.map((ft) => (
                <tr key={ft.tier} className={`border-b border-lineSoft last:border-0 ${ft.tier === tier ? "bg-accentDim/40" : ""}`}>
                  <td className="px-2.5 py-2 font-medium">
                    {ft.name}{ft.tier === tier && <span className="ml-1.5 text-[10px] text-accent">● {t("pf.current")}</span>}
                  </td>
                  <td className="tnum px-2.5 py-2 text-muted">{ft.volumeUsd > 0 ? `$${fmtNum(ft.volumeUsd, 0)}+` : "—"}</td>
                  <td className="tnum px-2.5 py-2">{feeAt(ft.discountBps)}%</td>
                  <td className="tnum px-2.5 py-2 text-green">{ft.discountBps > 0 ? `-${ft.discountBps / 100}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] leading-relaxed text-mutedDim">
          {t("pf.tierNote")}
        </p>
      </div>
    </div>
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
  const t = useT();
  if (isLong === undefined) return <>—</>;
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${isLong ? "bg-greenDim text-green" : "bg-redDim text-red"}`}>
      {isLong ? t("trade.long") : t("trade.short")}
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
  const t = useT();
  if (rows.length === 0) {
    return <div className="px-3.5 py-8 text-center text-[12px] text-mutedDim">{t("pf.noRecords")}</div>;
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
  const t = useT();
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
          <span className="text-[14px] font-semibold">{mode === "deposit" ? t("pf.depositToTrading") : t("pf.withdrawToWallet")}</span>
          <button onClick={onClose} className="text-muted hover:text-fg">✕</button>
        </div>
        <div className="flex flex-col gap-3 p-5">
          <div className="flex justify-between text-[11px]">
            <span className="eyebrow">{t("pf.amount")}</span>
            <button className="tnum text-accent" onClick={() => setAmount(String(Math.floor(Number(formatEther(tokenToUsd(max))) * 100) / 100))}>
              {t("pf.max")} {fmtUsd(max)}
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
            {oc.busy ? t("pf.confirming") : mode === "deposit" ? t("pf.deposit") : t("pf.withdraw")}
          </button>
          <p className="text-[11px] leading-relaxed text-mutedDim">
            {mode === "deposit" ? t("pf.depositHelp") : t("pf.withdrawHelp")}
          </p>
        </div>
      </div>
    </div>
  );
}
