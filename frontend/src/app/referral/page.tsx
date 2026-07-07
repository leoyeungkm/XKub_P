"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import toast from "react-hot-toast";
import { ADDR, b32, parseB32, referralAbi } from "@/config/contracts";
import { errMsg, fmtUsd } from "@/lib/format";
import { PENDING_REF_KEY } from "@/components/RefCapture";

const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 31);

export default function Referral() {
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const enabled = !!ADDR.referral;

  const { data, refetch } = useReadContracts({
    contracts: enabled ? [
      { address: ADDR.referral!, abi: referralAbi, functionName: "defaultRebateBps" },
      ...(address ? [
        { address: ADDR.referral!, abi: referralAbi, functionName: "ownerCode", args: [address] },
        { address: ADDR.referral!, abi: referralAbi, functionName: "referredBy", args: [address] },
        { address: ADDR.referral!, abi: referralAbi, functionName: "claimableUsd", args: [address] },
        { address: ADDR.referral!, abi: referralAbi, functionName: "bound", args: [address] },
      ] : []),
    ] as never[] : [],
    query: { enabled, refetchInterval: 10000 },
  });

  const rebateBps = data?.[0]?.result as bigint | undefined;
  const myCodeHex = data?.[1]?.result as string | undefined;
  const referredByHex = data?.[2]?.result as string | undefined;
  const claimable = data?.[3]?.result as bigint | undefined;
  const isBound = data?.[4]?.result as boolean | undefined;

  const myCode = myCodeHex && myCodeHex !== ZERO32 ? parseB32(myCodeHex) : "";
  const referredBy = referredByHex && referredByHex !== ZERO32 ? parseB32(referredByHex) : "";

  const [newCode, setNewCode] = useState("");
  const [bindCode, setBindCode] = useState("");
  const [busy, setBusy] = useState(false);

  // Prefill bind field from a captured ?ref=
  useEffect(() => {
    if (!referredBy) {
      const pending = localStorage.getItem(PENDING_REF_KEY);
      if (pending) setBindCode(pending);
    }
  }, [referredBy]);

  if (!enabled) {
    return <Center>Referrals are not enabled on this deployment.</Center>;
  }
  if (!isConnected) {
    return <Center>Connect a wallet to manage referrals.</Center>;
  }

  const run = async (fn: () => Promise<`0x${string}`>, ok: string) => {
    if (!client) return;
    setBusy(true);
    try {
      const h = await fn();
      await client.waitForTransactionReceipt({ hash: h });
      toast.success(ok);
      refetch();
      return true;
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const register = () => {
    const c = clean(newCode);
    if (c.length < 3) return toast.error("Code needs 3+ characters");
    run(() => writeContractAsync({
      address: ADDR.referral!, abi: referralAbi, functionName: "registerCode", args: [b32(c)],
    }), `Code ${c} registered`);
  };

  const bind = () => {
    const c = clean(bindCode);
    if (!c) return toast.error("Enter a code");
    run(async () => {
      const owner = await client!.readContract({
        address: ADDR.referral!, abi: referralAbi, functionName: "codeOwner", args: [b32(c)],
      });
      if (owner === "0x0000000000000000000000000000000000000000") throw new Error("Unknown code");
      return writeContractAsync({
        address: ADDR.referral!, abi: referralAbi, functionName: "setReferrer", args: [b32(c)],
      });
    }, `Now trading under ${c}`).then((okDone) => {
      if (okDone) localStorage.removeItem(PENDING_REF_KEY);
    });
  };

  const claim = () =>
    run(() => writeContractAsync({
      address: ADDR.referral!, abi: referralAbi, functionName: "claim",
    }), "Rebate claimed");

  const shareLink = myCode && typeof window !== "undefined"
    ? `${window.location.origin}/?ref=${myCode}` : "";
  const rebatePct = rebateBps !== undefined ? (Number(rebateBps) / 100).toFixed(0) : "—";

  return (
    <main className="mx-auto flex max-w-[760px] flex-col gap-2.5 p-2.5">
      <div className="px-1 pt-2">
        <h1 className="text-[18px] font-semibold">Referrals</h1>
        <p className="mt-1 text-[12.5px] text-muted">
          Share your code — you earn {rebatePct}% of the trading fee every time
          someone you referred opens or closes a position.
        </p>
      </div>

      {/* Earnings */}
      <Card title="Rebate Earnings">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="eyebrow mb-1">Claimable</div>
            <div className="tnum text-[28px] font-semibold leading-none text-accent">
              {claimable !== undefined ? fmtUsd(claimable) : "—"}
              <span className="ml-1.5 text-[14px] text-mutedDim">KUSDT</span>
            </div>
          </div>
          <button
            onClick={claim}
            disabled={busy || !claimable || claimable === 0n}
            className="rounded-md bg-accent px-5 py-2.5 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Claim
          </button>
        </div>
      </Card>

      {/* Your code */}
      <Card title="Your Referral Code">
        {myCode ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between rounded-md bg-bg px-3.5 py-3">
              <span className="tnum text-[18px] font-semibold tracking-wide">{myCode}</span>
              <span className="eyebrow">{rebatePct}% rebate</span>
            </div>
            <button
              onClick={() => { navigator.clipboard.writeText(shareLink); toast.success("Share link copied"); }}
              className="flex items-center justify-between rounded-md border border-line px-3.5 py-2.5 text-left transition-colors hover:border-accent/40"
            >
              <span className="truncate text-[12px] text-muted">{shareLink}</span>
              <span className="ml-2 shrink-0 text-[12px] text-accent">Copy ⧉</span>
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <p className="text-[12.5px] text-muted">Register a code to start earning rebates. One per address.</p>
            <div className="flex gap-2">
              <div className="flex flex-1 items-center rounded-md border border-line bg-bg px-3 focus-within:border-accent/60">
                <input
                  value={newCode}
                  onChange={(e) => setNewCode(clean(e.target.value))}
                  placeholder="YOURCODE"
                  className="tnum w-full bg-transparent py-2.5 uppercase tracking-wide outline-none"
                />
              </div>
              <button
                onClick={register} disabled={busy}
                className="rounded-md bg-accent px-5 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                Register
              </button>
            </div>
          </div>
        )}
      </Card>

      {/* Referred by */}
      <Card title="Referred By">
        {referredBy ? (
          <div className="flex items-center gap-2 text-[13px]">
            You trade under code
            <span className="tnum rounded bg-accentDim px-2 py-0.5 font-medium text-accent">{referredBy}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <p className="text-[12.5px] text-muted">
              Enter a friend&apos;s code to support them. Locks after your first
              rebate — pick carefully.
            </p>
            <div className="flex gap-2">
              <div className="flex flex-1 items-center rounded-md border border-line bg-bg px-3 focus-within:border-accent/60">
                <input
                  value={bindCode}
                  onChange={(e) => setBindCode(clean(e.target.value))}
                  placeholder="FRIENDCODE"
                  className="tnum w-full bg-transparent py-2.5 uppercase tracking-wide outline-none"
                />
              </div>
              <button
                onClick={bind} disabled={busy || isBound}
                className="rounded-md border border-line px-5 text-[13px] font-semibold text-fg transition-colors hover:border-accent/40 disabled:opacity-40"
              >
                Apply
              </button>
            </div>
          </div>
        )}
      </Card>
    </main>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      <h3 className="eyebrow border-b border-line px-3.5 py-2.5">{title}</h3>
      <div className="p-3.5">{children}</div>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="grid place-items-center py-32 text-[13px] text-muted">{children}</div>;
}
