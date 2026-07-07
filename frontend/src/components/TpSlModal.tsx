"use client";

import { useEffect, useState } from "react";
import { formatEther, parseEther } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import toast from "react-hot-toast";
import { ADDR, b32, routerAbi, triggerKey } from "@/config/contracts";
import { errMsg, fmtNum, fmtPrice, fmtUsd } from "@/lib/format";
import { getAgentClients, useOneClick } from "@/lib/oneclick";
import type { PositionRow } from "@/lib/portfolio";

const TP_PRESETS = [25, 50, 100, 200, 300];   // profit % of collateral
const SL_PRESETS = [10, 30, 50, 70];           // loss % of collateral

export default function TpSlModal({ pos, onClose }: { pos: PositionRow; onClose: () => void }) {
  const { address } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const oneClick = useOneClick();

  const entry = Number(formatEther(pos.entry));
  const mark = pos.mark > 0n ? Number(formatEther(pos.mark)) : entry;
  const sizeUsd = Number(formatEther(pos.sizeUsd));
  const collateral = Number(formatEther(pos.collateralUsd));
  const lev = collateral > 0 ? sizeUsd / collateral : 1;

  const [tp, setTp] = useState("");
  const [sl, setSl] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: minExecFee } = useReadContract({
    address: ADDR.router, abi: routerAbi, functionName: "minExecutionFee",
  });
  const { data: existing } = useReadContract({
    address: ADDR.router, abi: routerAbi, functionName: "triggers",
    args: address ? [triggerKey(address, pos.symbol, pos.isLong)] : undefined,
    query: { enabled: !!address },
  });

  useEffect(() => {
    if (!existing) return;
    const [tpP, slP,, active] = existing as readonly [bigint, bigint, bigint, boolean];
    if (active) {
      if (tpP > 0n) setTp(String(Number(formatEther(tpP))));
      if (slP > 0n) setSl(String(Number(formatEther(slP))));
    }
  }, [existing]);

  // pnl at a target price (long: +ve above entry; short: +ve below entry)
  const pnlAt = (target: number) =>
    target > 0 ? sizeUsd * (pos.isLong ? target / entry - 1 : 1 - target / entry) : 0;

  // Plain numeric string (no thousands separators — a number input rejects commas)
  const priceStr = (n: number) => String(Number(n.toFixed(n >= 100 ? 2 : 5)));
  const tpPrice = (pct: number) => entry * (1 + (pos.isLong ? 1 : -1) * (pct / 100) / lev);
  const slPrice = (pct: number) => entry * (1 - (pos.isLong ? 1 : -1) * (pct / 100) / lev);

  const tpNum = Number(tp || "0");
  const slNum = Number(sl || "0");
  const estProfit = pnlAt(tpNum);
  const estLoss = pnlAt(slNum);

  const save = async () => {
    if (!address || !client) return;
    const tpWei = tpNum > 0 ? parseEther(String(tpNum)) : 0n;
    const slWei = slNum > 0 ? parseEther(String(slNum)) : 0n;
    if (tpWei === 0n && slWei === 0n) return toast.error("Set a TP or SL price");
    setBusy(true);
    try {
      const fee = minExecFee ?? 0n;
      const useAgent = oneClick.active && oneClick.agentGas >= fee * 2n;
      if (useAgent) {
        const agents = getAgentClients(address)!;
        const hash = await agents.wallet.writeContract({
          address: ADDR.router, abi: routerAbi, functionName: "setTriggerFor",
          args: [address, b32(pos.symbol), pos.isLong, tpWei, slWei], value: fee,
        });
        await client.waitForTransactionReceipt({ hash });
      } else {
        const hash = await writeContractAsync({
          address: ADDR.router, abi: routerAbi, functionName: "setTrigger",
          args: [b32(pos.symbol), pos.isLong, tpWei, slWei], value: fee,
        });
        await client.waitForTransactionReceipt({ hash });
      }
      toast.success("TP/SL saved — the keeper closes at your price");
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!address || !client) return;
    setBusy(true);
    try {
      const useAgent = oneClick.active && oneClick.agentGas > 0n;
      if (useAgent) {
        const agents = getAgentClients(address)!;
        const hash = await agents.wallet.writeContract({
          address: ADDR.router, abi: routerAbi, functionName: "cancelTriggerFor",
          args: [address, b32(pos.symbol), pos.isLong],
        });
        await client.waitForTransactionReceipt({ hash });
      } else {
        const hash = await writeContractAsync({
          address: ADDR.router, abi: routerAbi, functionName: "cancelTrigger",
          args: [b32(pos.symbol), pos.isLong],
        });
        await client.waitForTransactionReceipt({ hash });
      }
      toast.success("TP/SL cancelled");
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const hasExisting = existing ? (existing as readonly unknown[])[3] === true : false;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-[420px] overflow-hidden rounded-xl border border-line bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line bg-panel2 px-5 py-3.5">
          <span className="text-[14px] font-semibold">倉位止盈止損 · TP / SL</span>
          <button onClick={onClose} className="text-muted hover:text-fg">✕</button>
        </div>

        <div className="flex flex-col gap-4 p-5">
          {/* position info */}
          <div className="flex items-center gap-2 text-[13px]">
            <span className="font-medium">{pos.symbol}-PERP</span>
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${pos.isLong ? "bg-greenDim text-green" : "bg-redDim text-red"}`}>
              {pos.isLong ? "做多" : "做空"} {lev.toFixed(0)}x
            </span>
            <span className="eyebrow !tracking-normal text-mutedDim">逐倉</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-[12px]">
            <Info k="開倉價格" v={`$${fmtPrice(pos.entry)}`} />
            <Info k="當前價格" v={pos.mark > 0n ? `$${fmtPrice(pos.mark)}` : "—"} />
          </div>

          {/* TP */}
          <div className="flex flex-col gap-2 rounded-md border border-line bg-bg p-3">
            <div className="flex justify-between text-[12px]">
              <span className="eyebrow">倉位止盈 · Take Profit</span>
              <span className={`tnum ${estProfit > 0 ? "text-green" : "text-mutedDim"}`}>
                預估盈利 {estProfit > 0 ? `$${fmtNum(estProfit)}` : "$0.00"}
              </span>
            </div>
            <div className="flex items-center rounded-md border border-line bg-panel px-3 focus-within:border-accent/60">
              <input type="number" min="0" placeholder="TP price" value={tp}
                onChange={(e) => setTp(e.target.value)}
                className="tnum w-full bg-transparent py-2 text-[14px] outline-none" />
              <span className="eyebrow">USD</span>
            </div>
            <div className="grid grid-cols-5 gap-1">
              {TP_PRESETS.map((p) => (
                <button key={p} onClick={() => setTp(priceStr(tpPrice(p)))}
                  className="tnum rounded bg-panel2 py-1.5 text-[11px] text-muted transition-colors hover:text-green">
                  {p}%
                </button>
              ))}
            </div>
          </div>

          {/* SL */}
          <div className="flex flex-col gap-2 rounded-md border border-line bg-bg p-3">
            <div className="flex justify-between text-[12px]">
              <span className="eyebrow">倉位止損 · Stop Loss</span>
              <span className={`tnum ${estLoss < 0 ? "text-red" : "text-mutedDim"}`}>
                預估虧損 {estLoss < 0 ? `$${fmtNum(estLoss)}` : "$0.00"}
              </span>
            </div>
            <div className="flex items-center rounded-md border border-line bg-panel px-3 focus-within:border-accent/60">
              <input type="number" min="0" placeholder="SL price" value={sl}
                onChange={(e) => setSl(e.target.value)}
                className="tnum w-full bg-transparent py-2 text-[14px] outline-none" />
              <span className="eyebrow">USD</span>
            </div>
            <div className="grid grid-cols-5 gap-1">
              {SL_PRESETS.map((p) => (
                <button key={p} onClick={() => setSl(priceStr(slPrice(p)))}
                  className="tnum rounded bg-panel2 py-1.5 text-[11px] text-muted transition-colors hover:text-red">
                  {p}%
                </button>
              ))}
              <button onClick={() => setSl("")}
                className="tnum rounded bg-panel2 py-1.5 text-[11px] text-muted transition-colors hover:text-fg">
                無
              </button>
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-mutedDim">
            止盈/止損套用於整個倉位，到價時由 keeper 以新鮮預言機價自動平倉，平倉後自動取消。
            設定需付 {minExecFee !== undefined ? formatEther(minExecFee) : "—"} KUB 執行費（取消時退回）。
          </p>

          <div className="flex gap-2">
            {hasExisting && (
              <button onClick={cancel} disabled={busy}
                className="rounded-md border border-line px-4 py-2.5 text-[13px] font-medium text-muted transition-colors hover:border-red/50 hover:text-red disabled:opacity-40">
                取消
              </button>
            )}
            <button onClick={save} disabled={busy}
              className="flex-1 rounded-md bg-accent py-2.5 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40">
              {busy ? "儲存中…" : "儲存 TP/SL"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Info({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-md bg-bg px-2.5 py-2">
      <div className="eyebrow mb-0.5">{k}</div>
      <div className="tnum text-[13px]">{v}</div>
    </div>
  );
}
