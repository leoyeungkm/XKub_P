"use client";

// One-tap onboarding: register a referral code + enable 1-click trading +
// fund the agent's gas. On wallets that support EIP-5792 atomic batching
// (Privy embedded, Coinbase, …) it's a SINGLE confirmation; otherwise it
// falls back to sequential txs so it works everywhere.
//
// (Multicall3 can't do this: registerCode/setAgent authenticate via
// msg.sender, which Multicall3 would replace with its own address.)
import { useState } from "react";
import { encodeFunctionData } from "viem";
import { usePublicClient, useSendCalls, useSendTransaction, useWriteContract } from "wagmi";
import toast from "react-hot-toast";
import { ADDR, b32, referralAbi, routerAbi } from "@/config/contracts";
import { errMsg } from "@/lib/format";
import { ensureAgentAccount, useOneClick } from "@/lib/oneclick";
import { GAS_TOPUP } from "@/lib/oneclickActions";

export function useGetStarted() {
  const oc = useOneClick();
  const client = usePublicClient();
  const { sendCallsAsync } = useSendCalls();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();
  const [busy, setBusy] = useState(false);

  // `code` (optional) registers a referral code in the same batch.
  const start = async (code?: string): Promise<boolean> => {
    if (!oc.owner || !client) { toast.error("Connect wallet first"); return false; }
    setBusy(true);
    try {
      const agent = ensureAgentAccount(oc.owner);
      const wantGas = oc.agentGas < GAS_TOPUP / 2n;

      const calls: { to: `0x${string}`; data?: `0x${string}`; value?: bigint }[] = [];
      if (code && ADDR.referral) {
        calls.push({
          to: ADDR.referral,
          data: encodeFunctionData({ abi: referralAbi, functionName: "registerCode", args: [b32(code)] }),
        });
      }
      calls.push({
        to: ADDR.router,
        data: encodeFunctionData({ abi: routerAbi, functionName: "setAgent", args: [agent.address, true] }),
      });
      if (wantGas) calls.push({ to: agent.address, value: GAS_TOPUP });

      // Try one atomic batch first.
      try {
        toast("Setting up your account…");
        await sendCallsAsync({ calls });
      } catch {
        // Wallet doesn't support EIP-5792 batching — do it sequentially.
        toast("Wallet doesn't batch — confirming steps…");
        if (code && ADDR.referral) {
          const h0 = await writeContractAsync({ address: ADDR.referral, abi: referralAbi, functionName: "registerCode", args: [b32(code)] });
          await client.waitForTransactionReceipt({ hash: h0 });
        }
        const h1 = await writeContractAsync({ address: ADDR.router, abi: routerAbi, functionName: "setAgent", args: [agent.address, true] });
        await client.waitForTransactionReceipt({ hash: h1 });
        if (wantGas) {
          const h2 = await sendTransactionAsync({ to: agent.address, value: GAS_TOPUP });
          await client.waitForTransactionReceipt({ hash: h2 });
        }
      }

      // Give the batch/txs a moment to land, then refresh state.
      await new Promise((r) => setTimeout(r, 1500));
      oc.refetch();
      toast.success("All set — 1-click trading enabled");
      return true;
    } catch (e) {
      toast.error(errMsg(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { ...oc, busy, start };
}
