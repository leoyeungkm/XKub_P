"use client";

// Every write that goes through the user's injected wallet (OKX/MetaMask) must
// be a legacy (Type-0) tx — KUB Chain has no EIP-1559 and silently drops Type-2
// transactions. This wrapper injects { type:'legacy', gasPrice } automatically so
// call sites don't have to remember. Agent-key writes (viem local account through
// our transport) already pick legacy on their own and don't use this.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { usePublicClient, useSendTransaction, useWriteContract } from "wagmi";
import { kubTxOverrides } from "@/config/contracts";

export function useKubWrite() {
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { sendTransactionAsync } = useSendTransaction();

  // Typed as the underlying hook fn so call sites keep identical inference. The
  // merged object can't be re-typed through wagmi's deep generic, so the inner
  // hand-off is cast — safe because the outer signature already validated it.
  const writeContract: typeof writeContractAsync = async (params) => {
    const fees = client ? await kubTxOverrides(client) : {};
    return writeContractAsync({ ...params, ...fees } as any);
  };

  const sendTransaction: typeof sendTransactionAsync = async (params) => {
    const fees = client ? await kubTxOverrides(client) : {};
    return sendTransactionAsync({ ...params, ...fees } as any);
  };

  return { writeContract, sendTransaction };
}
