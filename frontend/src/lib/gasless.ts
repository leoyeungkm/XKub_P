"use client";

// Gasless trading: the agent key signs an order (EIP-712, off-chain) and the
// order is POSTed to the platform relayer (keeper), which submits it on-chain
// and pays the gas. The trader never needs KUB.
import type { PublicClient } from "viem";
import { ADDR, RELAYER_URL, b32, chain, routerAbi } from "@/config/contracts";
import { getAgentAccount } from "@/lib/oneclick";

const ORDER_TYPES = {
  Order: [
    { name: "owner", type: "address" },
    { name: "marketId", type: "bytes32" },
    { name: "isLong", type: "bool" },
    { name: "isIncrease", type: "bool" },
    { name: "collateralTokens", type: "uint256" },
    { name: "sizeDeltaUsd", type: "uint256" },
    { name: "acceptablePrice", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const gaslessAvailable = () => RELAYER_URL.length > 0;

/** Sign an order with the agent key and hand it to the relayer. Returns the
 *  relayer tx hash. Throws on relayer error so the caller can fall back. */
export async function submitGaslessOrder(params: {
  owner: `0x${string}`;
  symbol: string;
  isLong: boolean;
  isIncrease: boolean;
  collateralTokens: bigint;
  sizeDeltaUsd: bigint;
  acceptablePrice: bigint;
  client: PublicClient;
}): Promise<string> {
  const agent = getAgentAccount(params.owner);
  if (!agent) throw new Error("no agent key");

  // Deadline must be relative to CHAIN time (client and chain clocks can differ).
  // Fetch nonce + block in parallel to shave a round-trip off the sign latency.
  const [nonce, block] = await Promise.all([
    params.client.readContract({
      address: ADDR.router, abi: routerAbi, functionName: "orderNonce", args: [params.owner],
    }),
    params.client.getBlock(),
  ]);
  const deadline = block.timestamp + 300n;

  const message = {
    owner: params.owner,
    marketId: b32(params.symbol),
    isLong: params.isLong,
    isIncrease: params.isIncrease,
    collateralTokens: params.collateralTokens,
    sizeDeltaUsd: params.sizeDeltaUsd,
    acceptablePrice: params.acceptablePrice,
    nonce,
    deadline,
  };

  const sig = await agent.signTypedData({
    domain: { name: "XKubPerp", version: "1", chainId: chain.id, verifyingContract: ADDR.router },
    types: ORDER_TYPES,
    primaryType: "Order",
    message,
  });

  const post = async (): Promise<string> => {
    const res = await fetch(RELAYER_URL, {
      method: "POST",
      signal: AbortSignal.timeout(45000), // relayer waits ≤40s for the receipt
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        order: {
          owner: message.owner, marketId: message.marketId, isLong: message.isLong, isIncrease: message.isIncrease,
          collateralTokens: message.collateralTokens.toString(), sizeDeltaUsd: message.sizeDeltaUsd.toString(),
          acceptablePrice: message.acceptablePrice.toString(), nonce: message.nonce.toString(), deadline: message.deadline.toString(),
        },
        sig,
      }),
    });
    // 409 "duplicate" = this owner-nonce is already in flight → it WAS accepted.
    if (res.status === 409) return "duplicate-in-flight";
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error ?? `relayer ${res.status}`);
    }
    return (await res.json()).txHash as string;
  };

  // Retry-once with a nonce guard: if the first attempt errored client-side but
  // the order actually executed (nonce advanced), DON'T resend — resending the
  // same nonce is what produces the noisy 409s. Only resend if truly not filled.
  try {
    return await post();
  } catch (e) {
    await new Promise((r) => setTimeout(r, 1500));
    const cur = await params.client.readContract({
      address: ADDR.router, abi: routerAbi, functionName: "orderNonce", args: [params.owner],
    }) as bigint;
    if (cur > nonce) return "filled"; // already executed — no resend, no 409
    return await post(); // genuinely not filled — safe to retry
  }
}
