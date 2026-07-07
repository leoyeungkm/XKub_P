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
import { useOraclePrice } from "./MarketBar";

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
    <div className="overflow-hidden rounded-[10px] border border-line bg-panel">
      <div className="flex">
        <button
          onClick={() => setIsLong(true)}
          className={`flex-1 py-3 text-[15px] font-bold ${
            isLong ? "bg-greenDim text-green shadow-[inset_0_-2px_0_#22c98a]" : "bg-panel2 text-muted"
          }`}
        >
          Long
        </button>
        <button
          onClick={() => setIsLong(false)}
          className={`flex-1 py-3 text-[15px] font-bold ${
            !isLong ? "bg-redDim text-red shadow-[inset_0_-2px_0_#f0506e]" : "bg-panel2 text-muted"
          }`}
        >
          Short
        </button>
      </div>

      <div className="flex flex-col gap-3 p-3.5">
        <div>
          <div className="mb-1.5 flex justify-between text-xs text-muted">
            <span>Collateral (KUSDT{oneClick.active ? " · 1-click balance" : ""})</span>
            <button
              className="text-accent"
              onClick={() => {
                const src = oneClick.active ? oneClick.balance : balance;
                if (src !== undefined) setCollateral(
                  String(Math.floor(Number(formatEther(tokenToUsd(src))) * 100) / 100));
              }}
            >
              Balance: {oneClick.active
                ? fmtUsd(tokenToUsd(oneClick.balance))
                : balance !== undefined ? fmtUsd(tokenToUsd(balance)) : "—"}
            </button>
          </div>
          <input
            type="number" min="0" placeholder="0.0" value={collateral}
            onChange={(e) => setCollateral(e.target.value)}
            className="w-full rounded-lg border border-line bg-bg px-3 py-2.5 text-[15px] outline-none focus:border-accent"
          />
        </div>

        <div>
          <div className="mb-1.5 flex justify-between text-xs text-muted">
            <span>Leverage</span><span className="text-fg">{levClamped}x</span>
          </div>
          <input
            type="range" min={1} max={maxLev} step={1} value={levClamped}
            onChange={(e) => setLev(Number(e.target.value))}
            className="w-full accent-accent"
          />
          <div className="flex justify-between text-[11px] text-muted">
            <span>1x</span><span>{maxLev}x</span>
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-xs text-muted">Max slippage</div>
          <select
            value={slipIdx}
            onChange={(e) => setSlipIdx(Number(e.target.value))}
            className="w-full rounded-lg border border-line bg-bg px-3 py-2.5 outline-none"
          >
            {SLIPPAGE_OPTS.map((o, i) => (
              <option key={o.label} value={i}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="rounded-lg bg-bg px-3 py-2.5 text-[12.5px]">
          <Row k="Position size" v={sizeUsd ? `${fmtNum(sizeUsd)} USD` : "—"} />
          <Row k="Entry (oracle)" v={price > 0n ? `$${fmtPrice(price)}` : "—"} />
          <Row k="Est. liq. price" v={liqPrice ? `$${fmtNum(liqPrice, liqPrice >= 100 ? 1 : 4)}` : "—"} />
          <Row k="Open fee (0.1%)" v={sizeUsd ? `${(sizeUsd * 0.001).toFixed(2)} KUSDT` : "—"} />
          <Row k="Execution fee" v={minExecFee !== undefined ? `${formatEther(minExecFee)} KUB` : "—"} />
        </div>

        <button
          onClick={submit}
          disabled={busy}
          className={`rounded-[10px] py-3 text-[15px] font-bold text-white disabled:opacity-50 ${
            isLong ? "bg-green" : "bg-red"
          }`}
        >
          {busy ? "Submitting…" : `${oneClick.active ? "⚡ " : ""}${isLong ? "Long" : "Short"} ${symbol}`}
        </button>

        <div className="text-[11.5px] leading-relaxed text-muted">
          Orders are executed by a keeper at the next fresh oracle price
          (front-run protection). Unexecuted orders can be cancelled after 60s.
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between py-[3px]">
      <span className="text-muted">{k}</span>
      <span>{v}</span>
    </div>
  );
}
