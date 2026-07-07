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
import { useMarketFees, useOraclePrice } from "./MarketBar";

const SLIPPAGE_OPTS = [
  { label: "0.3%", bps: 30n },
  { label: "0.5%", bps: 50n },
  { label: "1%", bps: 100n },
  { label: "No limit", bps: 0n },
];

export default function TradePanel({ symbol }: { symbol: string }) {
  const { address } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const price = useOraclePrice(symbol);
  const fees = useMarketFees(symbol);
  const oneClick = useOneClick();

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

  // liq. price estimate: loss ≈ collateral - 1% maintenance → Δp/p = 1/lev - 0.01
  const liqPrice = (() => {
    if (!(price > 0n) || !(colNum > 0)) return null;
    const move = 1 / levClamped - 0.01;
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

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      <div className="grid grid-cols-2 gap-1 p-1">
        <button
          onClick={() => setIsLong(true)}
          className={`rounded-md py-2.5 text-[14px] font-semibold transition-colors ${
            isLong ? "bg-greenDim text-green" : "text-muted hover:text-fg"
          }`}
        >
          Long
        </button>
        <button
          onClick={() => setIsLong(false)}
          className={`rounded-md py-2.5 text-[14px] font-semibold transition-colors ${
            !isLong ? "bg-redDim text-red" : "text-muted hover:text-fg"
          }`}
        >
          Short
        </button>
      </div>

      <div className="flex flex-col gap-3 p-3.5 pt-1.5">
        <div>
          <div className="mb-1.5 flex justify-between text-[11px]">
            <span className="eyebrow">Collateral{oneClick.active ? " · 1-click" : ""}</span>
            <button
              className="tnum text-accent transition-opacity hover:opacity-80"
              onClick={() => {
                const src = oneClick.active ? oneClick.balance : balance;
                if (src !== undefined) setCollateral(
                  String(Math.floor(Number(formatEther(tokenToUsd(src))) * 100) / 100));
              }}
            >
              {oneClick.active
                ? fmtUsd(tokenToUsd(oneClick.balance))
                : balance !== undefined ? fmtUsd(tokenToUsd(balance)) : "—"}
            </button>
          </div>
          <div className="flex items-center rounded-md border border-line bg-bg px-3 focus-within:border-accent/60">
            <input
              type="number" min="0" placeholder="0.00" value={collateral}
              onChange={(e) => setCollateral(e.target.value)}
              className="tnum w-full bg-transparent py-2.5 text-[15px] outline-none"
            />
            <span className="eyebrow">KUSDT</span>
          </div>
        </div>

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

        <div className="flex flex-col gap-1.5 rounded-md bg-bg px-3 py-3 text-[12px]">
          <Row k="Position size" v={sizeUsd ? `${fmtNum(sizeUsd)} USD` : "—"} />
          <Row k="Entry · oracle" v={price > 0n ? `$${fmtPrice(price)}` : "—"} />
          <Row k="Est. liq. price" v={liqPrice ? `$${fmtNum(liqPrice, liqPrice >= 100 ? 1 : 4)}` : "—"} accent />
          <div className="my-1 border-t border-lineSoft" />
          <Row
            k={`Open fee${fees.feeBps !== null ? ` · ${(fees.feeBps / 100).toFixed(2)}%` : ""}`}
            v={sizeUsd && fees.feeBps !== null
              ? `${(sizeUsd * fees.feeBps / 10000).toFixed(2)} KUSDT` : "—"}
          />
          <Row
            k="Borrow /h"
            v={(isLong ? fees.longRatePerHour : fees.shortRatePerHour) !== null
              ? `${(isLong ? fees.longRatePerHour : fees.shortRatePerHour)!.toFixed(4)}%` : "—"}
          />
          <Row k="Execution fee" v={minExecFee !== undefined ? `${formatEther(minExecFee)} KUB` : "—"} />
        </div>

        <button
          onClick={submit}
          disabled={busy}
          className={`rounded-md py-3 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40 ${
            isLong ? "bg-green" : "bg-red"
          }`}
        >
          {busy ? "Submitting…" : `${oneClick.active ? "⚡ " : ""}${isLong ? "Long" : "Short"} ${symbol}`}
        </button>

        <div className="text-[11px] leading-relaxed text-mutedDim">
          Filled by a keeper at the next fresh oracle price for front-run
          protection. Cancel an unfilled order after 60s.
        </div>
      </div>
    </div>
  );
}

function Row({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted">{k}</span>
      <span className={`tnum ${accent ? "text-accent" : "text-fg"}`}>{v}</span>
    </div>
  );
}
