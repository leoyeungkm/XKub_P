"use client";

import {
  useAccount, useBalance, useConnect, useDisconnect, useReadContract,
  useWriteContract, usePublicClient,
} from "wagmi";
import toast from "react-hot-toast";
import { ADDR, CFG, chain, erc20Abi, tokenToUsd, usdToToken } from "@/config/contracts";
import { shortAddr, errMsg, fmtUsd } from "@/lib/format";
import { PRIVY_ENABLED } from "@/lib/privy";
import PrivyConnect from "./PrivyConnect";
import { formatEther, parseEther } from "viem";

export default function Header() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient();

  const { data: kubBal } = useBalance({
    address,
    query: { enabled: !!address, refetchInterval: 8000 },
  });
  const { data: kusdtBal } = useReadContract({
    address: ADDR.kusdt,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 8000 },
  });

  const faucet = async () => {
    if (!address) return toast.error("Connect wallet first");
    try {
      const hash = await writeContractAsync({
        address: ADDR.kusdt,
        abi: erc20Abi,
        functionName: "mint",
        args: [address, usdToToken(parseEther("10000"))],
      });
      await client!.waitForTransactionReceipt({ hash });
      toast.success("Minted 10,000 test KUSDT");
    } catch (e) {
      const msg = errMsg(e);
      toast.error(
        /enough funds|insufficient funds/i.test(msg)
          ? "Mint failed — wallet has no KUB for gas on this chain\n" + msg
          : "Mint failed (note: mainnet KUSDT has no faucet)\n" + msg,
      );
    }
  };

  return (
    <header className="flex items-center gap-5 border-b border-line bg-panel px-5 py-2.5">
      <div className="text-lg font-bold tracking-wide">
        X<span className="text-accent">Kub</span> Perp
      </div>
      <div className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
        {CFG.chainName} · chain {CFG.chainId}
      </div>
      <div className="flex-1" />
      <button
        onClick={faucet}
        className="rounded-lg border border-line bg-panel2 px-3.5 py-2 text-muted hover:text-fg"
      >
        Mint test KUSDT
      </button>
      {isConnected && address ? (
        <>
          <div className="hidden items-center gap-3 rounded-lg border border-line bg-panel2 px-3.5 py-2 text-[12.5px] sm:flex">
            <span>
              <span className="text-muted">KUB </span>
              {kubBal ? Number(formatEther(kubBal.value)).toLocaleString(undefined, { maximumFractionDigits: 3 }) : "—"}
            </span>
            <span className="text-line">|</span>
            <span>
              <span className="text-muted">KUSDT </span>
              {kusdtBal !== undefined ? fmtUsd(tokenToUsd(kusdtBal)) : "—"}
            </span>
          </div>
          {PRIVY_ENABLED ? (
            <PrivyConnect />
          ) : (
            <button
              onClick={() => disconnect()}
              className="rounded-lg border border-line bg-panel2 px-4 py-2 font-semibold"
              title="Disconnect"
            >
              {shortAddr(address)}
            </button>
          )}
        </>
      ) : PRIVY_ENABLED ? (
        <PrivyConnect />
      ) : (
        <button
          onClick={() => connect({ connector: connectors[0], chainId: chain.id })}
          className="rounded-lg bg-accent px-4 py-2 font-semibold text-white"
        >
          Connect Wallet
        </button>
      )}
    </header>
  );
}
