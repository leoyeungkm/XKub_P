"use client";

// Testnet faucet flow: the keeper sends tKUB (gas, IP-limited) and KUSDT (test
// collateral, from its pre-minted stock, not IP-limited) in one call. As a
// fallback, if KUSDT didn't arrive but the user has gas, mint from their own
// wallet (the mock's mint is open and uncapped — KUSDT can never "run out").
import { parseEther } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { ADDR, erc20Abi, requestFaucet } from "@/config/contracts";
import { useKubWrite } from "@/lib/kubWrite";

export class FaucetError extends Error {
  constructor(public kind: "rate-limited" | "empty" | "no-gas") { super(kind); }
}

export function useFaucet() {
  const { address } = useAccount();
  const client = usePublicClient();
  const { writeContract } = useKubWrite();

  return async (): Promise<void> => {
    if (!address || !client) throw new Error("no wallet");
    const out = await requestFaucet(address);
    // Wait for the KUB drip to land before anything gas-dependent.
    if (out.kub) {
      for (let i = 0; i < 12; i++) {
        if ((await client.getBalance({ address })) >= parseEther("0.03")) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    const bal = (await client.readContract({
      address: ADDR.kusdt, abi: erc20Abi, functionName: "balanceOf", args: [address],
    })) as bigint;
    if (bal >= parseEther("1000")) return; // keeper's KUSDT arrived (or user already had it)
    // Fallback: self-mint if the user has gas; otherwise explain what happened.
    const gas = await client.getBalance({ address });
    if (gas < parseEther("0.005")) {
      if (out.status === "rate-limited") throw new FaucetError("rate-limited");
      if (out.status === "empty") throw new FaucetError("empty");
      throw new FaucetError("no-gas");
    }
    const hash = await writeContract({
      address: ADDR.kusdt, abi: erc20Abi, functionName: "mint",
      args: [address, parseEther("10000")],
    });
    await client.waitForTransactionReceipt({ hash });
  };
}
