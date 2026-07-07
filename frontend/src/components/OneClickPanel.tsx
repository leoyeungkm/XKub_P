"use client";

import { useState } from "react";
import { formatEther, parseEther } from "viem";
import { useAccount, usePublicClient, useSendTransaction, useWriteContract } from "wagmi";
import toast from "react-hot-toast";
import { ADDR, erc20Abi, routerAbi, tokenToUsd, usdToToken } from "@/config/contracts";
import { errMsg, fmtUsd, shortAddr } from "@/lib/format";
import { clearAgentKey, ensureAgentAccount, useOneClick } from "@/lib/oneclick";

const GAS_TOPUP = parseEther("0.2");

export default function OneClickPanel() {
  const { owner, agentAddr, active, balance, agentGas, refetch } = useOneClick();
  const { connector } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  // Privy embedded wallets already sign silently — the agent-key panel only
  // helps external wallets (MetaMask/OKX) that pop a confirmation per tx.
  if (connector?.id === "io.privy.wallet") return null;

  const enable = async () => {
    if (!owner || !client) return toast.error("Connect wallet first");
    setBusy(true);
    try {
      const agent = ensureAgentAccount(owner);
      toast("Authorising agent key…");
      const h = await writeContractAsync({
        address: ADDR.router, abi: routerAbi, functionName: "setAgent",
        args: [agent.address, true],
      });
      await client.waitForTransactionReceipt({ hash: h });
      if (agentGas < GAS_TOPUP / 2n) {
        toast("Funding agent gas…");
        const h2 = await sendTransactionAsync({ to: agent.address, value: GAS_TOPUP });
        await client.waitForTransactionReceipt({ hash: h2 });
      }
      toast.success("1-Click trading enabled — deposit collateral to start");
      refetch();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!owner || !agentAddr || !client) return;
    setBusy(true);
    try {
      const h = await writeContractAsync({
        address: ADDR.router, abi: routerAbi, functionName: "setAgent",
        args: [agentAddr, false],
      });
      await client.waitForTransactionReceipt({ hash: h });
      clearAgentKey(owner);
      toast.success("1-Click trading disabled");
      refetch();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const move = async (fn: "depositCollateral" | "withdrawCollateral") => {
    if (!owner || !client) return toast.error("Connect wallet first");
    const n = Number(amount || "0");
    if (!(n > 0)) return toast.error("Enter amount");
    setBusy(true);
    try {
      const tokens = usdToToken(parseEther(String(n)));
      if (fn === "depositCollateral") {
        const allowance = await client.readContract({
          address: ADDR.kusdt, abi: erc20Abi, functionName: "allowance",
          args: [owner, ADDR.router],
        });
        if (allowance < tokens) {
          toast("Approving KUSDT…");
          const h = await writeContractAsync({
            address: ADDR.kusdt, abi: erc20Abi, functionName: "approve",
            args: [ADDR.router, 2n ** 256n - 1n],
          });
          await client.waitForTransactionReceipt({ hash: h });
        }
      }
      const h = await writeContractAsync({
        address: ADDR.router, abi: routerAbi, functionName: fn, args: [tokens],
      });
      await client.waitForTransactionReceipt({ hash: h });
      toast.success(fn === "depositCollateral" ? "Deposited to trading balance" : "Withdrawn to wallet");
      setAmount("");
      refetch();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const topUp = async () => {
    if (!agentAddr || !client) return;
    setBusy(true);
    try {
      const h = await sendTransactionAsync({ to: agentAddr, value: GAS_TOPUP });
      await client.waitForTransactionReceipt({ hash: h });
      toast.success("Agent gas topped up");
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      <h3 className="eyebrow flex items-center justify-between border-b border-line px-3.5 py-2.5">
        <span className="flex items-center gap-1.5">⚡ 1-Click Trading</span>
        <span className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium ${
          active ? "bg-greenDim text-green" : "bg-panel2 text-mutedDim"
        }`}>
          <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-green" : "bg-mutedDim"}`} />
          {active ? "ON" : "OFF"}
        </span>
      </h3>

      <div className="flex flex-col gap-2.5 p-3.5">
        {!active ? (
          <>
            <div className="text-[12px] leading-relaxed text-muted">
              Trade without wallet popups. A browser-held agent key signs orders
              for you — it can only trade, never withdraw. Enabling authorises
              the key on-chain and funds it with {formatEther(GAS_TOPUP)} KUB
              for gas.
            </div>
            <button
              onClick={enable} disabled={busy}
              className="rounded-md bg-accent py-2.5 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy ? "Enabling…" : "Enable 1-Click Trading"}
            </button>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded-md bg-bg px-2.5 py-2">
                <div className="eyebrow mb-0.5">Trading balance</div>
                <div className="tnum text-[13px]">{fmtUsd(tokenToUsd(balance))}<span className="ml-1 text-[10px] text-mutedDim">KUSDT</span></div>
              </div>
              <div className="rounded-md bg-bg px-2.5 py-2">
                <div className="eyebrow mb-0.5">Agent gas · {agentAddr ? shortAddr(agentAddr) : "—"}</div>
                <div className={`tnum text-[13px] ${agentGas < parseEther("0.01") ? "text-red" : ""}`}>
                  {Number(formatEther(agentGas)).toFixed(3)}<span className="ml-1 text-[10px] text-mutedDim">KUB</span>
                </div>
              </div>
            </div>

            <div className="flex items-center rounded-md border border-line bg-bg px-3 focus-within:border-accent/60">
              <input
                type="number" min="0" placeholder="0.00" value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="tnum w-full bg-transparent py-2.5 outline-none"
              />
              <span className="eyebrow">KUSDT</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                onClick={() => move("depositCollateral")} disabled={busy}
                className="rounded-md bg-accentDim py-2.5 text-[13px] font-semibold text-accent transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                Deposit
              </button>
              <button
                onClick={() => move("withdrawCollateral")} disabled={busy}
                className="rounded-md border border-line py-2.5 text-[13px] font-semibold text-muted transition-colors hover:text-fg disabled:opacity-40"
              >
                Withdraw
              </button>
            </div>

            <div className="flex items-center gap-2 text-[11px]">
              <button onClick={topUp} disabled={busy} className="text-accent transition-opacity hover:opacity-80 disabled:opacity-40">
                Top up gas +{formatEther(GAS_TOPUP)} KUB
              </button>
              <div className="flex-1" />
              <button onClick={disable} disabled={busy} className="text-mutedDim transition-colors hover:text-red disabled:opacity-40">
                Disable
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
