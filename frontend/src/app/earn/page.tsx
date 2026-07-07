"use client";

import { useState } from "react";
import { formatEther, parseEther } from "viem";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import { useKubWrite } from "@/lib/kubWrite";
import toast from "react-hot-toast";
import { ADDR, E18, erc20Abi, marketAbi, poolAbi, usdToToken, tokenToUsd } from "@/config/contracts";
import { errMsg, fmtNum, fmtUsd } from "@/lib/format";

export default function Earn() {
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
        <h1 className="text-[20px] font-semibold">Earn · XPLP 流動性金庫</h1>
        <p className="mt-1 max-w-[640px] text-[13px] leading-relaxed text-muted">
          存入 KUSDT 成為所有交易者嘅對手方，賺取全部交易手續費。與 GMX 嘅 GLP、Hyperliquid 嘅 HLP、Jupiter 嘅 JLP 同類機制。
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-[1fr_360px]">
        {/* Left: pool overview + stats */}
        <div className="flex flex-col gap-2.5">
          <div className="rounded-lg border border-line bg-panel p-5">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Big k="金庫總值 · TVL" v={poolValue !== undefined ? `${fmtUsd(poolValue, 0)}` : "—"} unit="USD" />
              <Big k="XPLP 淨值 · NAV" v={sharePrice !== undefined ? `$${Number(formatEther(sharePrice)).toFixed(4)}` : "—"} />
              <Big k="XPLP 總量" v={supply !== undefined ? fmtNum(Number(formatEther(supply)), 0) : "—"} />
            </div>
          </div>

          <div className="rounded-lg border border-line bg-panel p-5">
            <div className="eyebrow mb-3">金庫狀態 · Pool Status</div>
            <div className="mb-1.5 flex justify-between text-[12.5px]">
              <span className="text-muted">使用率 · Utilization</span>
              <span className="tnum">{utilization.toFixed(1)}%</span>
            </div>
            <div className="mb-4 h-2 overflow-hidden rounded-full bg-panel2">
              <div className={`h-full transition-all duration-500 ${utilization > 80 ? "bg-red" : "bg-accent"}`} style={{ width: `${utilization}%` }} />
            </div>
            <div className="grid grid-cols-2 gap-3 text-[12.5px]">
              <Row k="未平倉合約 · Open Interest" v={totalOi !== undefined ? `${fmtUsd(totalOi, 0)} USD` : "—"} />
              <Row k="儲備要求 · Reserve" v={reserveBps !== undefined ? `${Number(reserveBps) / 100}% of OI` : "—"} />
              <Row k="提款冷靜期" v={cooldown !== undefined ? `${Number(cooldown) / 60} 分鐘` : "—"} />
              <Row k="對手方 · Counterparty" v="全部交易倉位" />
            </div>
          </div>

          <div className="rounded-lg border border-line bg-panel p-5">
            <div className="eyebrow mb-2">運作方式 · How it works</div>
            <ul className="flex flex-col gap-2 text-[12.5px] leading-relaxed text-muted">
              <Li>交易者虧損與所有手續費（開/平倉費、資金費、清算費）流入金庫，推升 XPLP 淨值。</Li>
              <Li>交易者盈利由金庫支付，XPLP 淨值下跌。你係莊家，賺統計優勢與費用。</Li>
              <Li>每次存款有 15 分鐘提款冷靜期（防三明治攻擊）；提款須保留足夠儲備支付未平倉位。</Li>
              <Li className="text-red/90">風險：交易者整體盈利時金庫會虧損。這是槓桿做市，非無風險收益。</Li>
            </ul>
          </div>
        </div>

        {/* Right: your position + deposit/withdraw */}
        <div className="flex flex-col gap-2.5">
          <div className="rounded-lg border border-line bg-panel p-5">
            <div className="eyebrow mb-3">你的持倉 · Your Position</div>
            <div className="grid grid-cols-2 gap-2">
              <Cell k="XPLP 餘額" v={myPlp !== undefined ? fmtNum(Number(formatEther(myPlp)), 2) : "—"} />
              <Cell k="持倉價值" v={`${fmtUsd(myValue)} USD`} />
              <Cell k="佔金庫比例" v={`${mySharePct.toFixed(3)}%`} />
              <Cell k="提款冷靜期" v={cooldownLeft > 0 ? `${Math.ceil(cooldownLeft / 60)} 分鐘` : "可提款"} tone={cooldownLeft > 0 ? "red" : "green"} />
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-line bg-panel">
            <div className="grid grid-cols-2 gap-1 p-1">
              <button onClick={() => setTab("deposit")}
                className={`rounded-md py-2.5 text-[14px] font-semibold transition-colors ${tab === "deposit" ? "bg-accentDim text-accent" : "text-muted hover:text-fg"}`}>
                存入 Deposit
              </button>
              <button onClick={() => setTab("withdraw")}
                className={`rounded-md py-2.5 text-[14px] font-semibold transition-colors ${tab === "withdraw" ? "bg-panel2 text-fg" : "text-muted hover:text-fg"}`}>
                提取 Withdraw
              </button>
            </div>
            <div className="flex flex-col gap-2.5 p-3.5 pt-1.5">
              <div className="mb-0.5 flex justify-between text-[11px]">
                <span className="eyebrow">{tab === "deposit" ? "KUSDT 金額" : "XPLP 數量"}</span>
                <button className="tnum text-accent" onClick={() => setAmount(String(Math.floor(maxOut * 100) / 100))}>
                  {tab === "deposit" ? `錢包 ${fmtNum(walletUsd)}` : `餘額 ${fmtNum(Number(formatEther(myPlp ?? 0n)), 2)}`}
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
                  提款冷靜期尚餘約 {Math.ceil(cooldownLeft / 60)} 分鐘。
                </div>
              )}
              <button onClick={run} disabled={busy || !isConnected}
                className={`rounded-md py-3 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40 ${tab === "deposit" ? "bg-accent" : "bg-panel2 !text-fg border border-line"}`}>
                {!isConnected ? "請先連接錢包" : busy ? "處理中…" : tab === "deposit" ? "存入金庫" : "提取"}
              </button>
              <p className="text-[11px] leading-relaxed text-mutedDim">
                {tab === "deposit"
                  ? "存入即按當前淨值鑄造 XPLP。首次存款起 15 分鐘內不可提款。"
                  : "按當前淨值贖回 KUSDT。若金庫需保留儲備支付未平倉位，提款可能受限。"}
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
