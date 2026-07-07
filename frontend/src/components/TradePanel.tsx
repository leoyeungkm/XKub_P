"use client";

import { useEffect, useRef, useState } from "react";
import { parseEther, formatEther } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import toast from "react-hot-toast";
import {
  ADDR, MARKETS, b32, erc20Abi, marketAbi, routerAbi, usdToToken, tokenToUsd,
} from "@/config/contracts";
import { errMsg, fmtNum, fmtPrice, fmtUsd } from "@/lib/format";
import { getAgentClients, useOneClick } from "@/lib/oneclick";
import { gaslessAvailable, submitGaslessOrder } from "@/lib/gasless";
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
  const [amount, setAmount] = useState("");
  const [lev, setLev] = useState(2);
  const [slipIdx, setSlipIdx] = useState(1);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"cost" | "size">("cost"); // input as collateral (cost) or position size
  const [unit, setUnit] = useState<"usd" | "asset">("usd");   // size unit in size mode
  const [showUnitPref, setShowUnitPref] = useState(false);
  const [levOpen, setLevOpen] = useState(false);
  const levRef = useRef<HTMLDivElement>(null);

  const maxLev = MARKETS.find((m) => m.symbol === symbol)?.maxLeverageX ?? 10;
  const levClamped = Math.min(Math.max(lev, 1), maxLev);

  const { data: minExecFee } = useReadContract({
    address: ADDR.router, abi: routerAbi, functionName: "minExecutionFee",
  });
  const { data: minCollateral } = useReadContract({
    address: ADDR.market, abi: marketAbi, functionName: "minCollateralUsd",
  });
  const { data: balance } = useReadContract({
    address: ADDR.kusdt, abi: erc20Abi, functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 8000 },
  });

  const priceNum = Number(formatEther(price));
  const availableUsd = oneClick.active
    ? Number(formatEther(tokenToUsd(oneClick.balance)))
    : balance !== undefined ? Number(formatEther(tokenToUsd(balance))) : 0;

  // Derive collateral + position size from the chosen input mode/unit
  const amt = Number(amount || "0");
  let colNum: number, sizeUsd: number;
  if (mode === "cost") {
    colNum = amt;
    sizeUsd = amt * levClamped;
  } else {
    sizeUsd = unit === "asset" ? amt * priceNum : amt;
    colNum = levClamped > 0 ? sizeUsd / levClamped : 0;
  }
  const amountTokens = priceNum > 0 ? sizeUsd / priceNum : 0;
  const maxLongUsd = availableUsd * levClamped;

  // Default the input to the smallest openable position for this account:
  // the min collateral (works for a tiny account too), capped by what's available.
  const defaultedRef = useRef(false);
  const minColUsd = minCollateral !== undefined ? Number(formatEther(tokenToUsd(minCollateral))) : 10;
  useEffect(() => {
    if (defaultedRef.current || amount !== "") return;
    if (availableUsd > 0) {
      defaultedRef.current = true;
      setMode("cost");
      setAmount(String(Math.min(minColUsd, Math.floor(availableUsd * 100) / 100)));
    }
  }, [availableUsd, minColUsd, amount]);

  // Close the leverage popover on outside click
  useEffect(() => {
    if (!levOpen) return;
    const onDown = (e: MouseEvent) => {
      if (levRef.current && !levRef.current.contains(e.target as Node)) setLevOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [levOpen]);

  // liq. price estimate: loss ≈ collateral - maintenance → Δp/p = 1/lev - maint
  const maint = fees.maintenanceBps !== null ? fees.maintenanceBps / 10000 : 0.01;
  const liqPrice = (() => {
    if (!(price > 0n) || !(colNum > 0)) return null;
    const move = 1 / levClamped - maint;
    const p = Number(formatEther(price));
    return isLong ? p * (1 - move) : p * (1 + move);
  })();

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

      // Gasless path: agent signs, relayer submits & pays gas (no KUB needed)
      if (oneClick.active && gaslessAvailable() && oneClick.balance >= collateralTokens) {
        try {
          await submitGaslessOrder({
            owner: address, symbol, isLong, isIncrease: true,
            collateralTokens, sizeDeltaUsd: sizeUsd18, acceptablePrice: acceptable, client,
          });
          toast.success("Order submitted (gasless) — keeper executes at fresh price");
          setAmount("");
          oneClick.refetch();
          return;
        } catch (e) {
          toast("Relayer unavailable — falling back to on-chain 1-click");
        }
      }

      // 1-click path: agent signs & submits on-chain, collateral from the balance
      if (oneClick.active) {
        if (oneClick.balance < collateralTokens) {
          toast("1-click balance too low — order goes via wallet instead");
        } else if (oneClick.agentGas < fee * 2n) {
          toast("Agent gas low — top it up. Using wallet.");
        } else {
          const agents = getAgentClients(address)!;
          const hash = await agents.wallet.writeContract({
            address: ADDR.router, abi: routerAbi, functionName: "createIncreaseRequestFor",
            args: [address, b32(symbol), isLong, collateralTokens, sizeUsd18, acceptable],
            value: fee,
          });
          await client.waitForTransactionReceipt({ hash });
          toast.success("Order queued (1-click) — keeper executes at next fresh price");
          setAmount("");
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
      setAmount("");
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const borrowRate = isLong ? fees.longRatePerHour : fees.shortRatePerHour;
  // One direction per market: block opening the opposite side while a position is open.
  const oppositeOpen = account.positions.some((p) => p.symbol === symbol && p.isLong !== isLong);

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      {/* header: margin mode + leverage (click to set) + order type */}
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
        <span className="rounded bg-panel2 px-2 py-1 text-[11px] font-medium">逐倉 Isolated</span>
        <div ref={levRef} className="relative">
          <button
            onClick={() => setLevOpen((v) => !v)}
            className="tnum rounded bg-panel2 px-2 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accentDim"
          >
            {levClamped}× ▾
          </button>
          {levOpen && (
            <div className="absolute left-0 top-full z-20 mt-1 w-56 rounded-lg border border-line bg-panel p-3 shadow-2xl">
              <div className="eyebrow mb-2 flex justify-between">
                <span>Leverage</span><span className="tnum text-accent">{levClamped}×</span>
              </div>
              <div className="grid grid-cols-4 gap-1">
                {[1, 2, 5, 10, 20, 25, 40, 50, 100].filter((v) => v <= maxLev).map((v) => (
                  <button
                    key={v}
                    onClick={() => setLev(v)}
                    className={`tnum rounded py-1.5 text-[12px] transition-colors ${
                      levClamped === v ? "bg-accent text-bg" : "bg-panel2 text-muted hover:text-fg"
                    }`}
                  >
                    {v}×
                  </button>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number" min={1} max={maxLev} value={levClamped}
                  onChange={(e) => setLev(Math.min(maxLev, Math.max(1, Number(e.target.value) || 1)))}
                  className="tnum w-full rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] outline-none focus:border-accent/60"
                />
                <span className="eyebrow shrink-0">max {maxLev}×</span>
              </div>
            </div>
          )}
        </div>
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
        {/* input */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-[11px]">
            <button
              onClick={() => setShowUnitPref((v) => !v)}
              className="eyebrow flex items-center gap-1 transition-colors hover:text-fg"
            >
              {mode === "cost" ? "Cost" : "Order Size"}
              {mode === "size" && unit === "asset" ? ` · ${symbol}` : " · USD"} ▾
            </button>
            <span className="tnum text-muted">Available {fmtNum(availableUsd)} USD</span>
          </div>

          {/* Unit Preference expander */}
          {showUnitPref && (
            <div className="mb-2 flex flex-col gap-2 rounded-md border border-line bg-bg p-2.5">
              <div>
                <div className="eyebrow mb-1">Order Size unit</div>
                <div className="grid grid-cols-2 gap-1">
                  <PrefBtn active={unit === "asset"} onClick={() => { setUnit("asset"); setMode("size"); }}>{symbol}</PrefBtn>
                  <PrefBtn active={unit === "usd"} onClick={() => setUnit("usd")}>USD</PrefBtn>
                </div>
                <p className="mt-1 text-[10.5px] leading-snug text-mutedDim">
                  Input and display order size in {unit === "asset" ? symbol : "USD"}.
                </p>
              </div>
              <div>
                <div className="eyebrow mb-1">Input by</div>
                <div className="grid grid-cols-2 gap-1">
                  <PrefBtn active={mode === "size"} onClick={() => setMode("size")}>Order Size</PrefBtn>
                  <PrefBtn active={mode === "cost"} onClick={() => setMode("cost")}>Cost</PrefBtn>
                </div>
                <p className="mt-1 text-[10.5px] leading-snug text-mutedDim">
                  {mode === "cost"
                    ? "Enter the cost (collateral, trading fee included); size = cost × leverage."
                    : "Enter the position size; collateral = size ÷ leverage."}
                </p>
              </div>
            </div>
          )}

          <div className="flex items-center rounded-md border border-line bg-bg px-3 focus-within:border-accent/60">
            <input
              type="number" min="0" placeholder="0.00" value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="tnum w-full bg-transparent py-2.5 text-[15px] outline-none"
            />
            <span className="eyebrow">{mode === "size" && unit === "asset" ? symbol : "USD"}</span>
          </div>

          {(mode === "cost" || unit === "usd") && (
            <div className="mt-1.5 grid grid-cols-5 gap-1">
              {COST_PRESETS.map((v) => (
                <button
                  key={v}
                  onClick={() => setAmount(String(v))}
                  className="tnum rounded bg-panel2 py-1.5 text-[11.5px] text-muted transition-colors hover:text-fg"
                >
                  ${v}
                </button>
              ))}
              <button
                onClick={() => setAmount(String(Math.floor((mode === "cost" ? availableUsd : maxLongUsd) * 100) / 100))}
                className="tnum rounded bg-panel2 py-1.5 text-[11.5px] text-accent transition-colors hover:opacity-80"
              >
                Max
              </button>
            </div>
          )}
        </div>

        {/* order preview */}
        <div className="flex flex-col gap-1.5 rounded-md bg-bg px-3 py-3 text-[12px]">
          <Row k={`Amount (${symbol})`} v={amountTokens > 0 ? `≈ ${fmtNum(amountTokens, 6)} ${symbol}` : "—"} />
          <Row k="Order value" v={sizeUsd ? `${fmtNum(sizeUsd)} USD` : "—"} />
          <Row k="Cost (collateral)" v={colNum > 0 ? `${fmtNum(colNum)} USD` : "—"} />
          <Row k={`Max ${isLong ? "long" : "short"}`} v={maxLongUsd > 0 ? `${fmtNum(maxLongUsd, 0)} USD` : "—"} />
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

        {oppositeOpen && (
          <div className="rounded-md border border-red/40 bg-redDim/50 px-3 py-2 text-[11.5px] leading-relaxed text-red">
            你已持有 {symbol} 嘅{isLong ? "空" : "多"}倉。一個市場只可單邊持倉——請先平掉反方向倉位。
          </div>
        )}
        <button
          onClick={submit}
          disabled={busy || oppositeOpen || !address}
          className={`rounded-md py-3 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40 ${
            !address ? "bg-mutedDim" : isLong ? "bg-green" : "bg-red"
          }`}
        >
          {!address ? "請先連接錢包" : busy ? "Submitting…" : oppositeOpen ? `先平掉 ${symbol} ${isLong ? "空" : "多"}倉`
            : `${oneClick.active ? "⚡ " : ""}${isLong ? "Buy / Long" : "Sell / Short"} ${symbol}`}
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
        <Row k="Trading balance" v={`${fmtUsd(account.tradingUsd)} USD`} />
        <Row k="Wallet" v={`${fmtUsd(account.walletUsd)} USD`} />
        <Row
          k="Unrealized PnL"
          v={`${account.unrealizedUsd >= 0n ? "+" : ""}${fmtUsd(account.unrealizedUsd)} USD`}
          tone={account.unrealizedUsd >= 0n ? "green" : "red"}
        />
        <Row k="Used margin" v={`${fmtUsd(account.positionMarginUsd)} USD`} />
        <Row k="Account value" v={`${fmtUsd(account.accountValueUsd)} USD`} accent />
        {oneClick.active && (
          <>
            <div className="my-1 border-t border-lineSoft" />
            <Row
              k="Agent gas"
              v={`${Number(formatEther(oneClick.agentGas)).toFixed(3)} KUB`}
              tone={oneClick.agentGas < parseEther("0.01") ? "red" : undefined}
            />
          </>
        )}
      </Section>
    </div>
  );
}

function PrefBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md py-1.5 text-[12px] font-medium transition-colors ${
        active ? "bg-accentDim text-accent" : "bg-panel2 text-muted hover:text-fg"
      }`}
    >
      {children}
    </button>
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
