"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { formatEther } from "viem";
import toast from "react-hot-toast";
import {
  ADDR, BASE_FEE_BPS, REFERRED_DISCOUNT_BPS, b32, parseB32, referralAbi, referralEventsAbi, tokenToUsd,
} from "@/config/contracts";
import { errMsg, fmtNum, fmtUsd } from "@/lib/format";
import { PENDING_REF_KEY } from "@/components/RefCapture";

const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 31);

type CommissionRecord = { trader: string; usd: bigint; block: bigint; txHash: string; timestamp?: number };

function useReferralStats(referrer?: `0x${string}`) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["referralStats", referrer],
    enabled: !!referrer && !!client,
    refetchInterval: 20000,
    queryFn: async () => {
      let logs: readonly { args: { trader: string; usd: bigint }; blockNumber: bigint; transactionHash: string }[] = [];
      try {
        logs = await client!.getLogs({
          address: ADDR.referral!, event: referralEventsAbi[0] as never,
          args: { referrer } as never, fromBlock: 0n, toBlock: "latest",
        }) as never;
      } catch { /* rpc log limit */ }
      const friends = new Set<string>();
      let totalRewards = 0n;
      const records: CommissionRecord[] = [];
      for (const l of logs) {
        friends.add(l.args.trader.toLowerCase());
        totalRewards += l.args.usd;
        records.push({ trader: l.args.trader, usd: l.args.usd, block: l.blockNumber, txHash: l.transactionHash });
      }
      // Block timestamps for display
      const stamps = new Map<bigint, number>();
      await Promise.all([...new Set(records.map((r) => r.block))].map(async (bn) => {
        try { stamps.set(bn, Number((await client!.getBlock({ blockNumber: bn })).timestamp)); } catch {}
      }));
      for (const r of records) r.timestamp = stamps.get(r.block);
      records.sort((a, b) => Number(b.block - a.block));
      // Estimate referred volume from rewards: reward = vol × baseFee × rebate
      const rewardsUsd = Number(formatEther(totalRewards));
      const estVol = rewardsUsd / ((BASE_FEE_BPS / 10000) * (1000 / 10000)); // 10% rebate default
      return { friends: friends.size, totalRewards, estVol, records };
    },
  });
}

const fmtTime = (ts?: number) => {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const shortAddr = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);

export default function Referral() {
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient();
  const enabled = !!ADDR.referral;

  const { data, refetch } = useReadContracts({
    contracts: enabled && address ? [
      { address: ADDR.referral!, abi: referralAbi, functionName: "ownerCode", args: [address] },
      { address: ADDR.referral!, abi: referralAbi, functionName: "referredBy", args: [address] },
      { address: ADDR.referral!, abi: referralAbi, functionName: "claimableUsd", args: [address] },
      { address: ADDR.referral!, abi: referralAbi, functionName: "defaultRebateBps" },
    ] as never[] : [],
    query: { enabled: enabled && !!address, refetchInterval: 10000 },
  });

  const myCodeHex = data?.[0]?.result as string | undefined;
  const referredByHex = data?.[1]?.result as string | undefined;
  const claimable = data?.[2]?.result as bigint | undefined;
  const rebateBps = data?.[3]?.result as bigint | undefined;

  const myCode = myCodeHex && myCodeHex !== ZERO32 ? parseB32(myCodeHex) : "";
  const referredBy = referredByHex && referredByHex !== ZERO32 ? parseB32(referredByHex) : "";
  const stats = useReferralStats(address);

  const [newCode, setNewCode] = useState("");
  const [bindCode, setBindCode] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!referredBy) {
      const pending = localStorage.getItem(PENDING_REF_KEY);
      if (pending) setBindCode(pending);
    }
  }, [referredBy]);

  // Auto-suggest a code (from the address) so the user has a ready-to-go link.
  useEffect(() => {
    if (address && !myCode && !newCode) setNewCode(clean(address.slice(2, 8)));
  }, [address, myCode, newCode]);

  if (!enabled) return <Center>Referrals are not enabled on this deployment.</Center>;
  if (!isConnected) return <Center>Connect a wallet to manage referrals.</Center>;

  const run = async (fn: () => Promise<`0x${string}`>, ok: string) => {
    if (!client) return;
    setBusy(true);
    try {
      const h = await fn();
      await client.waitForTransactionReceipt({ hash: h });
      toast.success(ok);
      refetch();
      return true;
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  const register = () => {
    const c = clean(newCode);
    if (c.length < 3) return toast.error("Code needs 3+ characters");
    run(() => writeContractAsync({ address: ADDR.referral!, abi: referralAbi, functionName: "registerCode", args: [b32(c)] }), `Code ${c} registered`);
  };
  const bind = () => {
    const c = clean(bindCode);
    if (!c) return toast.error("Enter a code");
    run(async () => {
      const owner = await client!.readContract({ address: ADDR.referral!, abi: referralAbi, functionName: "codeOwner", args: [b32(c)] });
      if (owner === "0x0000000000000000000000000000000000000000") throw new Error("Unknown code");
      return writeContractAsync({ address: ADDR.referral!, abi: referralAbi, functionName: "setReferrer", args: [b32(c)] });
    }, `Now trading under ${c}`).then((ok) => { if (ok) localStorage.removeItem(PENDING_REF_KEY); });
  };
  const claim = () => run(() => writeContractAsync({ address: ADDR.referral!, abi: referralAbi, functionName: "claim" }), "Rewards claimed");

  const shareLink = myCode && typeof window !== "undefined" ? `${window.location.origin}/?ref=${myCode}` : "";
  const rebatePct = rebateBps !== undefined ? Number(rebateBps) / 100 : 10;
  const friendDiscountPct = REFERRED_DISCOUNT_BPS / 100;

  return (
    <main className="mx-auto flex max-w-[820px] flex-col gap-2.5 p-2.5">
      <div className="px-1 pt-3 text-center">
        <h1 className="text-[22px] font-semibold">Invite Friends &amp; Both Get Rewards</h1>
        <p className="mx-auto mt-2 max-w-[560px] text-[13px] leading-relaxed text-muted">
          你賺朋友交易手續費嘅 <span className="text-accent">{rebatePct}% 佣金</span>，朋友享 <span className="text-accent">{friendDiscountPct}% 手續費折扣</span>。雙贏。
        </p>
      </div>

      {/* Code + link */}
      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        <h3 className="eyebrow border-b border-line px-3.5 py-2.5">你的邀請 · Your Referral</h3>
        <div className="flex flex-col gap-3 p-3.5">
          {myCode ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-md bg-bg px-3.5 py-3">
                <div className="eyebrow mb-1">Referral Code</div>
                <button
                  onClick={() => { navigator.clipboard.writeText(myCode); toast.success("Code copied"); }}
                  className="tnum text-[18px] font-semibold tracking-wide transition-opacity hover:opacity-80"
                >
                  {myCode} <span className="text-[12px] text-accent">⧉</span>
                </button>
              </div>
              <div className="rounded-md bg-bg px-3.5 py-3">
                <div className="eyebrow mb-1">Referral Link</div>
                <button
                  onClick={() => { navigator.clipboard.writeText(shareLink); toast.success("Link copied"); }}
                  className="flex w-full items-center justify-between gap-2 text-left"
                >
                  <span className="truncate text-[12px] text-muted">{shareLink}</span>
                  <span className="shrink-0 text-[12px] text-accent">Copy ⧉</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              <p className="text-[12.5px] text-muted">我哋已為你準備好一個邀請碼，一撳即用（可自訂）。</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-md bg-bg px-3.5 py-3">
                  <div className="eyebrow mb-1">邀請碼 · Code</div>
                  <div className="flex items-center rounded-md border border-line bg-panel px-2.5 focus-within:border-accent/60">
                    <input value={newCode} onChange={(e) => setNewCode(clean(e.target.value))} placeholder="YOURCODE"
                      className="tnum w-full bg-transparent py-2 text-[15px] uppercase tracking-wide outline-none" />
                  </div>
                </div>
                <div className="rounded-md bg-bg px-3.5 py-3">
                  <div className="eyebrow mb-1">預覽連結 · Preview</div>
                  <div className="truncate pt-2 text-[12px] text-muted">
                    {typeof window !== "undefined" ? `${window.location.origin}/?ref=${newCode || "…"}` : ""}
                  </div>
                </div>
              </div>
              <button onClick={register} disabled={busy || newCode.length < 3}
                className="rounded-md bg-accent py-2.5 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40">
                {busy ? "生成中…" : "生成我的邀請連結"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        <h3 className="eyebrow flex items-center justify-between border-b border-line px-3.5 py-2.5">
          <span>統計 · Total Statistics</span>
          <button onClick={claim} disabled={busy || !claimable || claimable === 0n}
            className="rounded bg-accent px-3 py-1 text-[11px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40">
            領取獎勵
          </button>
        </h3>
        <div className="grid grid-cols-2 gap-1.5 p-3.5 sm:grid-cols-4">
          <S k="邀請人數" v={stats.data ? String(stats.data.friends) : "—"} />
          <S k="邀請交易量" v={stats.data ? `$${fmtNum(stats.data.estVol, 0)}` : "—"} />
          <S k="總獎勵" v={stats.data ? `${fmtUsd(stats.data.totalRewards)} USD` : "—"} />
          <S k="待領取" v={claimable !== undefined ? `${fmtUsd(claimable)} USD` : "—"} accent />
        </div>
        <p className="px-3.5 pb-3 text-[11px] text-mutedDim">
          ＊ 邀請統計與被邀請人自交易佣金即時由鏈上事件計算；邀請交易量為估算值。
        </p>
      </div>

      {/* Enter a code */}
      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        <h3 className="eyebrow border-b border-line px-3.5 py-2.5">輸入邀請碼 · Enter Code</h3>
        <div className="p-3.5">
          {referredBy ? (
            <div className="flex items-center gap-2 text-[13px]">
              你以邀請碼
              <span className="tnum rounded bg-accentDim px-2 py-0.5 font-medium text-accent">{referredBy}</span>
              交易，享 {friendDiscountPct}% 手續費折扣。
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              <p className="text-[12.5px] text-muted">輸入朋友嘅邀請碼，即享 {friendDiscountPct}% 手續費折扣（首次獲得佣金後鎖定）。</p>
              <div className="flex gap-2">
                <div className="flex flex-1 items-center rounded-md border border-line bg-bg px-3 focus-within:border-accent/60">
                  <input value={bindCode} onChange={(e) => setBindCode(clean(e.target.value))} placeholder="FRIENDCODE"
                    className="tnum w-full bg-transparent py-2.5 uppercase tracking-wide outline-none" />
                </div>
                <button onClick={bind} disabled={busy}
                  className="rounded-md border border-line px-5 text-[13px] font-semibold text-fg transition-colors hover:border-accent/40 disabled:opacity-40">
                  套用
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Commission details */}
      <div className="overflow-hidden rounded-lg border border-line bg-panel">
        <h3 className="eyebrow border-b border-line px-3.5 py-2.5">佣金明細 · Referral Commission Details</h3>
        {!stats.data || stats.data.records.length === 0 ? (
          <div className="px-3.5 py-8 text-center text-[12px] text-mutedDim">No Referral Records</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="eyebrow text-left">
                  {["時間", "被邀請人", "佣金"].map((h) => (
                    <th key={h} className="border-b border-line px-3.5 py-2 font-normal">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stats.data.records.map((r, i) => (
                  <tr key={r.txHash + i} className="border-b border-lineSoft last:border-0 hover:bg-panel2/40">
                    <td className="tnum px-3.5 py-2.5 text-muted">{fmtTime(r.timestamp)}</td>
                    <td className="tnum px-3.5 py-2.5">{shortAddr(r.trader)}</td>
                    <td className="tnum px-3.5 py-2.5 text-green">+{fmtUsd(r.usd)} USD</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

function S({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div className="rounded-md bg-bg px-3 py-2.5">
      <div className="eyebrow mb-1">{k}</div>
      <div className={`tnum text-[15px] font-medium ${accent ? "text-accent" : ""}`}>{v}</div>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="grid place-items-center py-32 text-[13px] text-muted">{children}</div>;
}
