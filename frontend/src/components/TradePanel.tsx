"use client";

import { useState } from "react";
import { parseEther, formatEther } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import toast from "react-hot-toast";
import {
  ADDR, MARKETS, b32, erc20Abi, routerAbi, usdToToken, tokenToUsd,
} from "@/config/contracts";
import { errMsg, fmtNum, fmtPrice, fmtUsd } from "@/lib/format";
import { getAgentClients, useOneClick } from "@/lib/oneclick";
import { useAccountSummary } from "@/lib/portfolio";
import { useMarketFees, useMyFee, useOraclePrice } from "./MarketBar";

const SLIPPAGE_OPTS = [
  { label: "0.3%", bps: 30n },
  { label: "0.5%", bps: 50n },
  { label: "1%", bps: 100n },
  { label: "No limit", bps: 0n },
];

const COST_PRESETS = [10, 20, 50, 100];

export default function TradePanel({ symbol }: { symbol: string }) {
  const { address } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const price = useOraclePrice(symbol);
  const fees = useMarketFees(symbol);
  const myFee = useMyFee();
  const oneClick = useOneClick();
  const account = useAccountSummary();

  const [isLong, setIsLong] = useState(true);
  const [collateral, setCollateral] = useState("");
  const [lev, setLev] = useState(2);
  const [slipIdx, setSlipIdx] = useState(1);
  const [busy, setBusy] = useState(false);

  const maxLev = MARKETS.find((m) => m.symbol === symbol)?.maxLeverageX ?? 10;
  const levClamped = Math.min(lev, maxLev);
  const colNum = Number(collateral || "0");
  const sizeUsd = colNum * levClamped;

  const { data: minExecFee } = useReadContract({
    address: ADDR.router,
    abi: routerAbi,
    functionName: "minExecutionFee",
  });

  const { data: balance } = useReadContract({
    address: ADDR.kusdt,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 8000 },
  });

  // liq. price estimate: loss ≈ collateral - maintenance → Δp/p = 1/lev - maint
  const maint = fees.maintenanceBps !== null ? fees.maintenanceBps / 10000 : 0.01;
  const liqPrice = (() => {
    if (!(price > 0n) || !(colNum > 0)) return null;
    const move = 1 / levClamped - maint;
    const p = Number(formatEther(price));
    return isLong ? p * (1 - move) : p * (1 + move);
  })();

  const priceNum = Number(formatEther(price));
  const amountTokens = priceNum > 0 ? sizeUsd / priceNum : 0;
  const availableUsd = oneClick.active
    ? Number(formatEther(tokenToUsd(oneClick.balance)))
    : balance !== undefined ? Number(formatEther(tokenToUsd(balance))) : 0;
  const maxLongUsd = availableUsd * levClamped;

  const submit = async () => {
    if (!address || !client) return toast.error("Connect wallet first");
    if (!(colNum > 0)) return toast.error("Enter collateral");
    setBusy(true);
    try {
      const collateralTokens = usdToToken(parseEther(String(colNum)));
      const sizeUsd18 = parseEther(String(sizeUsd));
      const slip = SLIPPAGE_OPTS[slipIdx].bps;
      const acceptable =
        slip > 0n && price > 0n
          ? isLong
            ? price + (price * slip) / 10000n
            : price - (price * slip) / 10000n
          : 0n;

      const fee = minExecFee ?? 0n;

      // 1-click path: agent signs silently, collateral from the router balance
      if (oneClick.active) {
        if (oneClick.balance < collateralTokens) {
          toast("1-click balance too low — order goes via wallet instead");
        } else if (oneClick.agentGas < fee * 2n) {
          toast("Agent gas low — top it up in the 1-Click panel. Using wallet.");
        } else {
          const agents = getAgentClients(address)!;
          const hash = await agents.wallet.writeContract({
            address: ADDR.router, abi: routerAbi, functionName: "createIncreaseRequestFor",
            args: [address, b32(symbol), isLong, collateralTokens, sizeUsd18, acceptable],
            value: fee,
          });
          await client.waitForTransactionReceipt({ hash });
          toast.success("Order queued (1-click) — keeper executes at next fresh price");
          setCollateral("");
          oneClick.refetch();
          return;
        }
      }

      const allowance = await client.readContract({
        address: ADDR.kusdt, abi: erc20Abi, functionName: "allowance",
        args: [address, ADDR.router],
      });
      if (allowance < collateralTokens) {
        toast("Approving KUSDT…");
        const h = await writeContractAsync({
          address: ADDR.kusdt, abi: erc20Abi, functionName: "approve",
          args: [ADDR.router, 2n ** 256n - 1n],
        });
        await client.waitForTransactionReceipt({ hash: h });
      }

      toast("Submitting order…");
      const hash = await writeContractAsync({
        address: ADDR.router, abi: routerAbi, functionName: "createIncreaseRequest",
        args: [b32(symbol), isLong, collateralTokens, sizeUsd18, acceptable],
        value: fee,
      });
      await client.waitForTransactionReceipt({ hash });
      toast.success("Order queued — keeper executes at next fresh price");
      setCollateral("");
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const borrowRate = isLong ? fees.longRatePerHour : fees.shortRatePerHour;

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      {/* header: margin mode + leverage + order type */}
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
        <span className="rounded bg-panel2 px-2 py-1 text-[11px] font-medium">逐倉 Isolated</span>
        <span className="tnum rounded bg-panel2 px-2 py-1 text-[11px] font-medium text-accent">{levClamped}×</span>
        <div className="flex-1" />
        <div className="flex gap-0.5 text-[12px]">
          <span className="rounded bg-accentDim px-2.5 py-1 font-medium text-accent">Market</span>
          <span className="cursor-not-allowed rounded px-2.5 py-1 text-mutedDim" title="Limit orders coming soon">Limit</span>
        </div>
      </div>

      {/* long / short */}
      <div className="grid grid-cols-2 gap-1 p-1">
        <button
          onClick={() => setIsLong(true)}
          className={`flex flex-col items-center rounded-md py-2 transition-colors ${
            isLong ? "bg-greenDim text-green" : "text-muted hover:text-fg"
          }`}
        >
          <span className="text-[13px] font-semibold">Buy / Long</span>
          <span className="tnum text-[12px] opacity-80">{price > 0n ? fmtPrice(price) : "—"}</span>
        </button>
        <button
          onClick={() => setIsLong(false)}
          className={`flex flex-col items-center rounded-md py-2 transition-colors ${
            !isLong ? "bg-redDim text-red" : "text-muted hover:text-fg"
          }`}
        >
          <span className="text-[13px] font-semibold">Sell / Short</span>
          <span className="tnum text-[12px] opacity-80">{price > 0n ? fmtPrice(price) : "—"}</span>
        </button>
      </div>

      <div className="flex flex-col gap-2.5 p-3 pt-1.5">
        {/* cost */}
        <div>
          <div className="mb-1.5 flex justify-between text-[11px]">
            <span className="eyebrow">Cost{oneClick.active ? " · 1-click" : ""}</span>
            <span className="tnum text-muted">Available {fmtNum(availableUsd)} USD</span>
          </div>
          <div className="flex items-center rounded-md border border-line bg-bg px-3 focus-within:border-accent/60">
            <input
              type="number" min="0" placeholder="0.00" value={collateral}
              onChange={(e) => setCollateral(e.target.value)}
              className="tnum w-full bg-transparent py-2.5 text-[15px] outline-none"
            />
            <span className="eyebrow">USD</span>
          </div>
          <div className="mt-1.5 grid grid-cols-5 gap-1">
            {COST_PRESETS.map((v) => (
              <button
                key={v}
                onClick={() => setCollateral(String(v))}
                className="tnum rounded bg-panel2 py-1.5 text-[11.5px] text-muted transition-colors hover:text-fg"
              >
                ${v}
              </button>
            ))}
            <button
              onClick={() => setCollateral(String(Math.floor(availableUsd * 100) / 100))}
              className="tnum rounded bg-panel2 py-1.5 text-[11.5px] text-accent transition-colors hover:opacity-80"
            >
              Max
            </button>
          </div>
        </div>

        {/* leverage */}
        <div>
          <div className="mb-2 flex justify-between text-[11px]">
            <span className="eyebrow">Leverage</span>
            <span className="tnum font-medium text-accent">{levClamped}×</span>
          </div>
          <input
            type="range" min={1} max={maxLev} step={1} value={levClamped}
            onChange={(e) => setLev(Number(e.target.value))}
            className="w-full"
          />
          <div className="eyebrow mt-1.5 flex justify-between">
            <span>1×</span><span>{maxLev}×</span>
          </div>
        </div>

        {/* order preview */}
        <div className="flex flex-col gap-1.5 rounded-md bg-bg px-3 py-3 text-[12px]">
          <Row k={`Amount (${symbol})`} v={amountTokens > 0 ? `≈ ${fmtNum(amountTokens, 6)} ${symbol}` : "—"} />
          <Row k="Order value" v={sizeUsd ? `${fmtNum(sizeUsd)} USD` : "—"} />
          <Row k="Max long" v={maxLongUsd > 0 ? `${fmtNum(maxLongUsd, 0)} USD` : "—"} />
          <Row k="Est. liq. price" v={liqPrice ? `$${fmtNum(liqPrice, liqPrice >= 100 ? 1 : 4)}` : "—"} accent />
          <Row k="TP / SL" v="None" />
        </div>

        {/* slippage */}
        <div>
          <div className="eyebrow mb-1.5">Max slippage</div>
          <div className="grid grid-cols-4 gap-1">
            {SLIPPAGE_OPTS.map((o, i) => (
              <button
                key={o.label}
                onClick={() => setSlipIdx(i)}
                className={`tnum rounded-md py-1.5 text-[11.5px] transition-colors ${
                  slipIdx === i ? "bg-accentDim text-accent" : "bg-panel2 text-muted hover:text-fg"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={submit}
          disabled={busy}
          className={`rounded-md py-3 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40 ${
            isLong ? "bg-green" : "bg-red"
          }`}
        >
          {busy ? "Submitting…" : `${oneClick.active ? "⚡ " : ""}${isLong ? "Buy / Long" : "Sell / Short"} ${symbol}`}
        </button>

        <div className="text-[11px] leading-relaxed text-mutedDim">
          Filled by a keeper at the next fresh oracle price for front-run
          protection. Cancel an unfilled order after 60s.
        </div>
      </div>

      {/* instrument info */}
      <Section title="Instrument Info">
        <FeeRow
          effBps={myFee.effectiveFeeBps ?? fees.feeBps}
          baseBps={fees.feeBps}
          sizeUsd={sizeUsd}
          tierName={myFee.tierName}
          tier={myFee.tier}
        />
        <Row k="LP / holding fee (per h)" v={borrowRate !== null ? `${borrowRate.toFixed(4)}%` : "—"} />
        <Row k="Maintenance margin rate" v={fees.maintenanceBps !== null ? `${(fees.maintenanceBps / 100).toFixed(2)}%` : "—"} />
        <Row
          k="Rapid-close LP fee"
          v={fees.rapidFeeBps !== null && fees.rapidWindow !== null
            ? `${(fees.rapidFeeBps / 100).toFixed(2)}% · <${fees.rapidWindow}s` : "—"}
        />
        <Row k="Execution fee" v={minExecFee !== undefined ? `${formatEther(minExecFee)} KUB` : "—"} />
      </Section>

      {/* account overview (isolated) */}
      <Section title="Account · Isolated">
        <Row k="Balance" v={`${fmtUsd(account.tradingUsd)} USD`} />
        <Row k="Wallet" v={`${fmtUsd(account.walletUsd)} USD`} />
        <Row
          k="Unrealized PnL"
          v={`${account.unrealizedUsd >= 0n ? "+" : ""}${fmtUsd(account.unrealizedUsd)} USD`}
          tone={account.unrealizedUsd >= 0n ? "green" : "red"}
        />
        <Row k="Used margin" v={`${fmtUsd(account.positionMarginUsd)} USD`} />
        <Row k="Account value" v={`${fmtUsd(account.accountValueUsd)} USD`} accent />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-line px-3 py-2.5">
      <div className="eyebrow mb-1.5">{title}</div>
      <div className="flex flex-col gap-1 text-[12px]">{children}</div>
    </div>
  );
}

function Row({ k, v, accent, tone }: { k: string; v: string; accent?: boolean; tone?: "green" | "red" }) {
  const color = tone === "green" ? "text-green" : tone === "red" ? "text-red" : accent ? "text-accent" : "text-fg";
  return (
    <div className="flex justify-between">
      <span className="text-muted">{k}</span>
      <span className={`tnum ${color}`}>{v}</span>
    </div>
  );
}

// Open fee row: shows the tier-discounted rate, with the VIP tier badge and a
// struck-through base rate when the trader has a discount.
function FeeRow({ effBps, baseBps, sizeUsd, tierName, tier }: {
  effBps: number | null; baseBps: number | null; sizeUsd: number; tierName: string; tier: number;
}) {
  const discounted = effBps !== null && baseBps !== null && effBps < baseBps;
  return (
    <div className="flex justify-between">
      <span className="flex items-center gap-1.5 text-muted">
        Open fee
        {tier > 0 && (
          <span className="rounded bg-accentDim px-1 py-0.5 text-[10px] font-medium text-accent">{tierName}</span>
        )}
      </span>
      <span className="tnum flex items-center gap-1.5">
        {discounted && (
          <span className="text-[10px] text-mutedDim line-through">{(baseBps! / 100).toFixed(2)}%</span>
        )}
        <span>
          {effBps !== null ? `${(effBps / 100).toFixed(2)}%` : "—"}
          {sizeUsd && effBps !== null ? ` · ${(sizeUsd * effBps / 10000).toFixed(2)}` : ""}
        </span>
      </span>
    </div>
  );
}
