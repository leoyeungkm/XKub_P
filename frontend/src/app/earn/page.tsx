"use client";

import { useState } from "react";
import { formatEther, parseEther } from "viem";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import { useKubWrite } from "@/lib/kubWrite";
import toast from "react-hot-toast";
import { ADDR, E18, erc20Abi, marketAbi, poolAbi, usdToToken, tokenToUsd } from "@/config/contracts";
import { errMsg, fmtNum, fmtUsd } from "@/lib/format";
import { useT } from "@/lib/i18n";

export default function Earn() {
  const t = useT();
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const { writeContract } = useKubWrite();
  const [amount, setAmount] = useState("");
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [busy, setBusy] = useState(false);

  const { data, refetch } = useReadContracts({
    contracts: [
      { address: ADDR.pool, abi: poolAbi, functionName: "poolValueUsd" },
      { address: ADDR.pool, abi: poolAbi, functionName: "sharePriceUsd" },
      { address: ADDR.pool, abi: poolAbi, functionName: "totalSupply" },
      { address: ADDR.pool, abi: poolAbi, functionName: "reserveFactorBps" },
      { address: ADDR.pool, abi: poolAbi, functionName: "withdrawCooldown" },
      { address: ADDR.market, abi: marketAbi, functionName: "totalOpenInterestUsd" },
      ...(address ? [
        { address: ADDR.pool, abi: poolAbi, functionName: "balanceOf", args: [address] },
        { address: ADDR.pool, abi: poolAbi, functionName: "lastDepositAt", args: [address] },
        { address: ADDR.kusdt, abi: erc20Abi, functionName: "balanceOf", args: [address] },
      ] : []),
    ] as never[],
    query: { refetchInterval: 8000 },
  });

  const poolValue = data?.[0]?.result as bigint | undefined;
  const sharePrice = data?.[1]?.result as bigint | undefined;
  const supply = data?.[2]?.result as bigint | undefined;
  const reserveBps = data?.[3]?.result as bigint | undefined;
  const cooldown = data?.[4]?.result as bigint | undefined;
  const totalOi = data?.[5]?.result as bigint | undefined;
  const myPlp = data?.[6]?.result as bigint | undefined;
  const lastDeposit = data?.[7]?.result as bigint | undefined;
  const walletBal = data?.[8]?.result as bigint | undefined;

  const utilization = poolValue && poolValue > 0n && totalOi !== undefined
    ? Math.min(100, (Number(totalOi) / Number(poolValue)) * 100) : 0;
  const myValue = myPlp !== undefined && sharePrice !== undefined ? (myPlp * sharePrice) / E18 : 0n;
  const mySharePct = myPlp !== undefined && supply && supply > 0n ? (Number(myPlp) / Number(supply)) * 100 : 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const cooldownLeft = lastDeposit !== undefined && cooldown !== undefined
    ? Math.max(0, Number(lastDeposit) + Number(cooldown) - nowSec) : 0;
  const walletUsd = walletBal !== undefined ? Number(formatEther(tokenToUsd(walletBal))) : 0;

  const run = async () => {
    if (!address || !client) return toast.error("Connect wallet first");
    const n = Number(amount || "0");
    if (!(n > 0)) return toast.error("Enter amount");
    setBusy(true);
    try {
      const amt18 = parseEther(String(n));
      if (tab === "deposit") {
        const tokens = usdToToken(amt18);
        const allowance = await client.readContract({
          address: ADDR.kusdt, abi: erc20Abi, functionName: "allowance", args: [address, ADDR.pool],
        });
        if (allowance < tokens) {
          toast("Approving KUSDT…");
          const h = await writeContract({ address: ADDR.kusdt, abi: erc20Abi, functionName: "approve", args: [ADDR.pool, 2n ** 256n - 1n] });
          await client.waitForTransactionReceipt({ hash: h });
        }
        const h = await writeContract({ address: ADDR.pool, abi: poolAbi, functionName: "deposit", args: [tokens] });
        await client.waitForTransactionReceipt({ hash: h });
        toast.success("Deposited");
      } else {
        const h = await writeContract({ address: ADDR.pool, abi: poolAbi, functionName: "withdraw", args: [amt18] });
        await client.waitForTransactionReceipt({ hash: h });
        toast.success("Withdrawn");
      }
      setAmount("");
      refetch();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  const maxOut = tab === "deposit" ? walletUsd : Number(formatEther(myPlp ?? 0n));

  return (
    <main className="mx-auto flex max-w-[980px] flex-col gap-2.5 p-2.5">
      <div className="px-1 pt-3">
        <h1 className="text-[20px] font-semibold">{t("earn.title")}</h1>
        <p className="mt-1 max-w-[640px] text-[13px] leading-relaxed text-muted">
          {t("earn.subtitle")}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-[1fr_360px]">
        {/* Left: pool overview + stats */}
        <div className="flex flex-col gap-2.5">
          <div className="rounded-lg border border-line bg-panel p-5">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Big k={t("earn.tvl")} v={poolValue !== undefined ? `${fmtUsd(poolValue, 0)}` : "—"} unit="USD" />
              <Big k={t("earn.nav")} v={sharePrice !== undefined ? `$${Number(formatEther(sharePrice)).toFixed(4)}` : "—"} />
              <Big k={t("earn.supply")} v={supply !== undefined ? fmtNum(Number(formatEther(supply)), 0) : "—"} />
            </div>
          </div>

          <div className="rounded-lg border border-line bg-panel p-5">
            <div className="eyebrow mb-3">{t("earn.poolStatus")}</div>
            <div className="mb-1.5 flex justify-between text-[12.5px]">
              <span className="text-muted">{t("earn.utilization")}</span>
              <span className="tnum">{utilization.toFixed(1)}%</span>
            </div>
            <div className="mb-4 h-2 overflow-hidden rounded-full bg-panel2">
              <div className={`h-full transition-all duration-500 ${utilization > 80 ? "bg-red" : "bg-accent"}`} style={{ width: `${utilization}%` }} />
            </div>
            <div className="grid grid-cols-2 gap-3 text-[12.5px]">
              <Row k={t("earn.openInterest")} v={totalOi !== undefined ? `${fmtUsd(totalOi, 0)} USD` : "—"} />
              <Row k={t("earn.reserve")} v={reserveBps !== undefined ? `${Number(reserveBps) / 100}% ${t("earn.ofOi")}` : "—"} />
              <Row k={t("earn.withdrawCooldown")} v={cooldown !== undefined ? `${Number(cooldown) / 60} ${t("earn.minutes")}` : "—"} />
              <Row k={t("earn.counterparty")} v={t("earn.counterpartyValue")} />
            </div>
          </div>

          <div className="rounded-lg border border-line bg-panel p-5">
            <div className="eyebrow mb-2">{t("earn.howItWorks")}</div>
            <ul className="flex flex-col gap-2 text-[12.5px] leading-relaxed text-muted">
              <Li>{t("earn.how1")}</Li>
              <Li>{t("earn.how2")}</Li>
              <Li>{t("earn.how3")}</Li>
              <Li className="text-red/90">{t("earn.how4")}</Li>
            </ul>
          </div>
        </div>

        {/* Right: your position + deposit/withdraw */}
        <div className="flex flex-col gap-2.5">
          <div className="rounded-lg border border-line bg-panel p-5">
            <div className="eyebrow mb-3">{t("earn.yourPosition")}</div>
            <div className="grid grid-cols-2 gap-2">
              <Cell k={t("earn.xplpBalance")} v={myPlp !== undefined ? fmtNum(Number(formatEther(myPlp)), 2) : "—"} />
              <Cell k={t("earn.shareValue")} v={`${fmtUsd(myValue)} USD`} />
              <Cell k={t("earn.poolShare")} v={`${mySharePct.toFixed(3)}%`} />
              <Cell k={t("earn.withdrawCooldown")} v={cooldownLeft > 0 ? `${Math.ceil(cooldownLeft / 60)} ${t("earn.minutes")}` : t("earn.withdrawable")} tone={cooldownLeft > 0 ? "red" : "green"} />
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-line bg-panel">
            <div className="grid grid-cols-2 gap-1 p-1">
              <button onClick={() => setTab("deposit")}
                className={`rounded-md py-2.5 text-[14px] font-semibold transition-colors ${tab === "deposit" ? "bg-accentDim text-accent" : "text-muted hover:text-fg"}`}>
                {t("earn.depositTab")}
              </button>
              <button onClick={() => setTab("withdraw")}
                className={`rounded-md py-2.5 text-[14px] font-semibold transition-colors ${tab === "withdraw" ? "bg-panel2 text-fg" : "text-muted hover:text-fg"}`}>
                {t("earn.withdrawTab")}
              </button>
            </div>
            <div className="flex flex-col gap-2.5 p-3.5 pt-1.5">
              <div className="mb-0.5 flex justify-between text-[11px]">
                <span className="eyebrow">{tab === "deposit" ? t("earn.kusdtAmount") : t("earn.xplpAmount")}</span>
                <button className="tnum text-accent" onClick={() => setAmount(String(Math.floor(maxOut * 100) / 100))}>
                  {tab === "deposit" ? `${t("earn.wallet")} ${fmtNum(walletUsd)}` : `${t("earn.balance")} ${fmtNum(Number(formatEther(myPlp ?? 0n)), 2)}`}
                </button>
              </div>
              <div className="flex items-center rounded-md border border-line bg-bg px-3 focus-within:border-accent/60">
                <input type="number" min="0" placeholder="0.00" value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="tnum w-full bg-transparent py-2.5 text-[15px] outline-none" />
                <span className="eyebrow">{tab === "deposit" ? "KUSDT" : "XPLP"}</span>
              </div>
              {tab === "withdraw" && cooldownLeft > 0 && (
                <div className="rounded-md border border-red/40 bg-redDim/50 px-3 py-2 text-[11.5px] text-red">
                  {t("earn.cooldownNotePre")}{Math.ceil(cooldownLeft / 60)}{t("earn.cooldownNoteSuf")}
                </div>
              )}
              <button onClick={run} disabled={busy || !isConnected}
                className={`rounded-md py-3 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40 ${tab === "deposit" ? "bg-accent" : "bg-panel2 !text-fg border border-line"}`}>
                {!isConnected ? t("earn.connectFirst") : busy ? t("earn.processing") : tab === "deposit" ? t("earn.depositBtn") : t("earn.withdrawBtn")}
              </button>
              <p className="text-[11px] leading-relaxed text-mutedDim">
                {tab === "deposit" ? t("earn.depositHelp") : t("earn.withdrawHelp")}
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

function Big({ k, v, unit }: { k: string; v: string; unit?: string }) {
  return (
    <div>
      <div className="eyebrow mb-1">{k}</div>
      <div className="tnum text-[22px] font-semibold leading-none">{v}{unit && <span className="ml-1 text-[13px] text-mutedDim">{unit}</span>}</div>
    </div>
  );
}
function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-muted">{k}</span>
      <span className="tnum text-fg">{v}</span>
    </div>
  );
}
function Cell({ k, v, tone }: { k: string; v: string; tone?: "green" | "red" }) {
  return (
    <div className="rounded-md bg-bg px-2.5 py-2">
      <div className="eyebrow mb-0.5">{k}</div>
      <div className={`tnum text-[13px] ${tone === "green" ? "text-green" : tone === "red" ? "text-red" : ""}`}>{v}</div>
    </div>
  );
}
function Li({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <li className={`flex items-start gap-2 ${className}`}>
      <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
      <span>{children}</span>
    </li>
  );
}
