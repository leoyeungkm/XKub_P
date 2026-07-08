"use client";

// Testnet faucet flow: get tKUB (gas) from the keeper, then mint test KUSDT from
// the user's OWN wallet (the mock's mint is open) — reliable, no keeper nonce
// race. Works for 0-KUB email/embedded wallets: gas arrives first, then the mint.
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
    // 1. tKUB for gas (keeper pays)
    const result = await requestFaucet(address);
    if (result === "sent") {
      // 2. wait for it to land
      for (let i = 0; i < 12; i++) {
        if ((await client.getBalance({ address })) >= parseEther("0.03")) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    // 3. mint 10k test KUSDT from the user's own wallet, if low. The mock's mint
    //    is open and uncapped — it can never "run out"; the only way this fails
    //    is no gas, so check that first and surface a CLEAR error instead of a
    //    cryptic insufficient-funds revert.
    const bal = (await client.readContract({
      address: ADDR.kusdt, abi: erc20Abi, functionName: "balanceOf", args: [address],
    })) as bigint;
    if (bal >= parseEther("1000")) return; // already has plenty
    const gas = await client.getBalance({ address });
    if (gas < parseEther("0.005")) {
      if (result === "rate-limited") throw new FaucetError("rate-limited");
      if (result === "empty") throw new FaucetError("empty");
      throw new FaucetError("no-gas");
    }
    const hash = await writeContract({
      address: ADDR.kusdt, abi: erc20Abi, functionName: "mint",
      args: [address, parseEther("10000")],
    });
    await client.waitForTransactionReceipt({ hash });
  };
}
