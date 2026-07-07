"use client";

// One-click trading: a browser-held agent key signs orders silently.
// The key can only trade (Router enforces this) — it can never withdraw
// the owner's funds. Losing it means re-enabling, nothing more.

import { useEffect, useState } from "react";
import {
  createWalletClient, createPublicClient, http, type Address, type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { useAccount, useBalance, useReadContract } from "wagmi";
import { ADDR, chain, routerAbi } from "@/config/contracts";

const storageKey = (owner: Address) => `xkub.agent.${chain.id}.${owner.toLowerCase()}`;
const CHANGED = "xkub-agent-changed";

export function getAgentAccount(owner: Address | undefined) {
  if (!owner || typeof window === "undefined") return null;
  const pk = localStorage.getItem(storageKey(owner)) as Hex | null;
  return pk ? privateKeyToAccount(pk) : null;
}

export function ensureAgentAccount(owner: Address) {
  const existing = getAgentAccount(owner);
  if (existing) return existing;
  const pk = generatePrivateKey();
  localStorage.setItem(storageKey(owner), pk);
  window.dispatchEvent(new Event(CHANGED));
  return privateKeyToAccount(pk);
}

export function clearAgentKey(owner: Address) {
  localStorage.removeItem(storageKey(owner));
  window.dispatchEvent(new Event(CHANGED));
}

export function getAgentClients(owner: Address) {
  const account = getAgentAccount(owner);
  if (!account) return null;
  return {
    account,
    wallet: createWalletClient({ account, chain, transport: http() }),
    public: createPublicClient({ chain, transport: http() }),
  };
}

/** Live one-click state: agent key presence, on-chain authorisation,
 *  router-held collateral and the agent's gas balance. */
export function useOneClick() {
  const { address } = useAccount();
  const [agentAddr, setAgentAddr] = useState<Address | null>(null);

  useEffect(() => {
    const sync = () => setAgentAddr(getAgentAccount(address)?.address ?? null);
    sync();
    window.addEventListener(CHANGED, sync);
    return () => window.removeEventListener(CHANGED, sync);
  }, [address]);

  const { data: authorized, refetch: refetchAuth } = useReadContract({
    address: ADDR.router, abi: routerAbi, functionName: "isAgent",
    args: address && agentAddr ? [address, agentAddr] : undefined,
    query: { enabled: !!address && !!agentAddr, refetchInterval: 8000 },
  });

  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: ADDR.router, abi: routerAbi, functionName: "collateralBalance",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 8000 },
  });

  const { data: agentGas } = useBalance({
    address: agentAddr ?? undefined,
    query: { enabled: !!agentAddr, refetchInterval: 8000 },
  });

  return {
    owner: address,
    agentAddr,
    active: !!address && !!agentAddr && authorized === true,
    balance: balance ?? 0n,          // router-held KUSDT (native token units)
    agentGas: agentGas?.value ?? 0n, // agent's native KUB
    refetch: () => { refetchAuth(); refetchBalance(); },
  };
}
