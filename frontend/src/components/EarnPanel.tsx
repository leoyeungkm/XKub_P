"use client";

import { useState } from "react";
import { formatEther, parseEther } from "viem";
import { useAccount, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import toast from "react-hot-toast";
import { ADDR, E18, erc20Abi, poolAbi, usdToToken } from "@/config/contracts";
import { errMsg, fmtUsd } from "@/lib/format";

export default function EarnPanel() {
  const { address } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const { data, refetch } = useReadContracts({
    contracts: [
      { address: ADDR.pool, abi: poolAbi, functionName: "poolValueUsd" },
      { address: ADDR.pool, abi: poolAbi, functionName: "sharePriceUsd" },
      ...(address
        ? [{ address: ADDR.pool, abi: poolAbi, functionName: "balanceOf", args: [address] }]
        : []),
    ] as never[],
    query: { refetchInterval: 8000 },
  });

  const poolValue = data?.[0]?.result as bigint | undefined;
  const sharePrice = data?.[1]?.result as bigint | undefined;
  const myPlp = data?.[2]?.result as bigint | undefined;

  const run = async (fn: "deposit" | "withdraw") => {
    if (!address || !client) return toast.error("Connect wallet first");
    const n = Number(amount || "0");
    if (!(n > 0)) return toast.error("Enter amount");
    setBusy(true);
    try {
      const amt18 = parseEther(String(n));
      if (fn === "deposit") {
        const tokens = usdToToken(amt18);
        const allowance = await client.readContract({
          address: ADDR.kusdt, abi: erc20Abi, functionName: "allowance",
          args: [address, ADDR.pool],
        });
        if (allowance < tokens) {
          toast("Approving KUSDT…");
          const h = await writeContractAsync({
            address: ADDR.kusdt, abi: erc20Abi, functionName: "approve",
            args: [ADDR.pool, 2n ** 256n - 1n],
          });
          await client.waitForTransactionReceipt({ hash: h });
        }
        const hash = await writeContractAsync({
          address: ADDR.pool, abi: poolAbi, functionName: "deposit", args: [tokens],
        });
        await client.waitForTransactionReceipt({ hash });
        toast.success("Deposited");
      } else {
        const hash = await writeContractAsync({
          address: ADDR.pool, abi: poolAbi, functionName: "withdraw", args: [amt18],
        });
        await client.waitForTransactionReceipt({ hash });
        toast.success("Withdrawn");
      }
      setAmount("");
      refetch();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-panel">
      <h3 className="border-b border-line px-3.5 py-3 text-xs uppercase tracking-widest text-muted">
        Earn — XPLP Liquidity Pool
      </h3>
      <div className="flex flex-col gap-2.5 p-3.5">
        <div className="grid grid-cols-2 gap-2 text-[12.5px]">
          <Stat k="Pool value" v={poolValue !== undefined ? `${fmtUsd(poolValue, 0)} USD` : "—"} />
          <Stat k="XPLP price" v={sharePrice !== undefined ? `$${Number(formatEther(sharePrice)).toFixed(4)}` : "—"} />
          <Stat k="Your XPLP" v={myPlp !== undefined ? fmtUsd(myPlp) : "—"} />
          <Stat
            k="Your value"
            v={myPlp !== undefined && sharePrice !== undefined
              ? `${fmtUsd((myPlp * sharePrice) / E18)} USD` : "—"}
          />
        </div>
        <input
          type="number" min="0" placeholder="KUSDT / XPLP amount" value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="w-full rounded-lg border border-line bg-bg px-3 py-2.5 outline-none focus:border-accent"
        />
        <div className="flex gap-2">
          <button
            onClick={() => run("deposit")} disabled={busy}
            className="flex-1 rounded-lg border border-line bg-panel2 py-2.5 font-semibold hover:border-accent disabled:opacity-50"
          >
            Deposit
          </button>
          <button
            onClick={() => run("withdraw")} disabled={busy}
            className="flex-1 rounded-lg border border-line bg-panel2 py-2.5 font-semibold hover:border-accent disabled:opacity-50"
          >
            Withdraw
          </button>
        </div>
        <div className="text-[11.5px] text-muted">
          LPs are the counterparty to all trades and earn all fees.
          15-minute withdraw cooldown after each deposit.
        </div>
      </div>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-lg bg-bg px-2.5 py-2">
      <div className="text-[11px] text-muted">{k}</div>
      <div>{v}</div>
    </div>
  );
}
