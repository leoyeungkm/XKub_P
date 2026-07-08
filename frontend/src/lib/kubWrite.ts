"use client";

// Every write that goes through the user's injected wallet (OKX/MetaMask) must:
//   1. be ON KUB testnet — auto-switch (and auto-add) the chain first. NOTE:
//      useChainId() always returns the config chain on a single-chain config, so
//      the wallet's REAL network comes from useAccount().chainId.
//   2. be a legacy (Type-0) tx — KUB Chain has no EIP-1559 and silently drops
//      Type-2 transactions.
// This wrapper handles both so call sites don't have to remember. Agent-key
// writes (viem local account through our transport) don't use this.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useAccount, usePublicClient, useSendTransaction, useSwitchChain, useWriteContract } from "wagmi";
import { chain, kubTxOverrides } from "@/config/contracts";

export function useKubWrite() {
  const client = usePublicClient();
  const { chainId: walletChainId } = useAccount(); // the wallet's actual network
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();

  // Move the wallet onto KUB testnet before any write. wagmi's switchChain adds
  // the chain (wallet_addEthereumChain, using the public RPC from our chain
  // config) when the wallet doesn't have it yet.
  const ensureChain = async () => {
    if (walletChainId !== chain.id) {
      await switchChainAsync({ chainId: chain.id });
    }
  };

  // Typed as the underlying hook fn so call sites keep identical inference. The
  // merged object can't be re-typed through wagmi's deep generic, so the inner
  // hand-off is cast — safe because the outer signature already validated it.
  const writeContract: typeof writeContractAsync = async (params) => {
    await ensureChain();
    const fees = client ? await kubTxOverrides(client) : {};
    return writeContractAsync({ ...params, ...fees, chainId: chain.id } as any);
  };

  const sendTransaction: typeof sendTransactionAsync = async (params) => {
    await ensureChain();
    const fees = client ? await kubTxOverrides(client) : {};
    return sendTransactionAsync({ ...params, ...fees, chainId: chain.id } as any);
  };

  return { writeContract, sendTransaction };
}
