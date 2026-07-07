"use client";

// Shared write-actions for one-click trading + collateral, used by the
// onboarding modal, the status panel, and the portfolio page.
import { useState } from "react";
import { parseEther } from "viem";
import { usePublicClient, useSendTransaction, useWriteContract } from "wagmi";
import toast from "react-hot-toast";
import { ADDR, erc20Abi, routerAbi, usdToToken } from "@/config/contracts";
import { errMsg } from "@/lib/format";
import { clearAgentKey, ensureAgentAccount, useOneClick } from "@/lib/oneclick";

export const GAS_TOPUP = parseEther("0.2");

export function useOneClickActions() {
  const oc = useOneClick();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  const [busy, setBusy] = useState(false);

  const enable = async () => {
    if (!oc.owner || !client) return toast.error("Connect wallet first");
    setBusy(true);
    try {
      const agent = ensureAgentAccount(oc.owner);
      toast("Authorising agent key…");
      const h = await writeContractAsync({
        address: ADDR.router, abi: routerAbi, functionName: "setAgent",
        args: [agent.address, true],
      });
      await client.waitForTransactionReceipt({ hash: h });
      if (oc.agentGas < GAS_TOPUP / 2n) {
        toast("Funding agent gas…");
        const h2 = await sendTransactionAsync({ to: agent.address, value: GAS_TOPUP });
        await client.waitForTransactionReceipt({ hash: h2 });
      }
      toast.success("1-Click trading enabled");
      oc.refetch();
      return true;
    } catch (e) {
      toast.error(errMsg(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!oc.owner || !oc.agentAddr || !client) return;
    setBusy(true);
    try {
      const h = await writeContractAsync({
        address: ADDR.router, abi: routerAbi, functionName: "setAgent",
        args: [oc.agentAddr, false],
      });
      await client.waitForTransactionReceipt({ hash: h });
      clearAgentKey(oc.owner);
      toast.success("1-Click trading disabled");
      oc.refetch();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const move = async (fn: "depositCollateral" | "withdrawCollateral", amount: string) => {
    if (!oc.owner || !client) return toast.error("Connect wallet first");
    const n = Number(amount || "0");
    if (!(n > 0)) return toast.error("Enter amount");
    setBusy(true);
    try {
      const tokens = usdToToken(parseEther(String(n)));
      if (fn === "depositCollateral") {
        const allowance = await client.readContract({
          address: ADDR.kusdt, abi: erc20Abi, functionName: "allowance",
          args: [oc.owner, ADDR.router],
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
      toast.success(fn === "depositCollateral" ? "Deposited to trading account" : "Withdrawn to wallet");
      oc.refetch();
      return true;
    } catch (e) {
      toast.error(errMsg(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const topUp = async () => {
    if (!oc.agentAddr || !client) return;
    setBusy(true);
    try {
      const h = await sendTransactionAsync({ to: oc.agentAddr, value: GAS_TOPUP });
      await client.waitForTransactionReceipt({ hash: h });
      toast.success("Agent gas topped up");
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return { ...oc, busy, enable, disable, move, topUp };
}
