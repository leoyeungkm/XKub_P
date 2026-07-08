"use client";

// Test-token popup, opened via the window event "xkub:faucet". Three ways to get
// funded, so users are never stuck:
//   1. platform faucet (keeper sends tKUB + KUSDT)
//   2. self-mint KUSDT straight from the token contract (open mint — works even
//      when the platform faucet is dry; just needs a little KUB for gas)
//   3. link to the official KUB testnet faucet for tKUB
import { useEffect, useState } from "react";
import { formatEther, parseEther } from "viem";
import { useAccount, useBalance, usePublicClient, useReadContract } from "wagmi";
import toast from "react-hot-toast";
import { ADDR, erc20Abi, tokenToUsd } from "@/config/contracts";
import { fmtUsd } from "@/lib/format";
import { useKubWrite } from "@/lib/kubWrite";
import { useFaucet, FaucetError } from "@/lib/faucet";
import { useT } from "@/lib/i18n";

export const OFFICIAL_FAUCET = "https://faucet.kubchain.com/";
export const openFaucet = () => window.dispatchEvent(new Event("xkub:faucet"));

export default function FaucetModal() {
  const { address } = useAccount();
  const client = usePublicClient();
  const { writeContract } = useKubWrite();
  const runFaucet = useFaucet();
  const t = useT();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"claim" | "mint" | null>(null);

  useEffect(() => {
    const openIt = () => setOpen(true);
    window.addEventListener("xkub:faucet", openIt);
    return () => window.removeEventListener("xkub:faucet", openIt);
  }, []);

  const { data: kubBal, refetch: refetchKub } = useBalance({
    address, query: { enabled: !!address && open, refetchInterval: 5000 },
  });
  const { data: kusdtBal, refetch: refetchKusdt } = useReadContract({
    address: ADDR.kusdt, abi: erc20Abi, functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && open, refetchInterval: 5000 },
  });

  if (!open) return null;
  const refetchAll = () => { refetchKub(); refetchKusdt(); };

  const claim = async () => {
    if (!address) return;
    setBusy("claim");
    try {
      await toast.promise(runFaucet(), {
        loading: t("faucet.loading"), success: t("faucet.success"),
        error: (e) => t(e instanceof FaucetError && e.kind === "rate-limited" ? "faucet.rateLimited"
          : e instanceof FaucetError && e.kind === "empty" ? "faucet.empty" : "faucet.error"),
      });
    } catch { /* toast already shown */ }
    finally { setBusy(null); refetchAll(); }
  };

  const mint = async () => {
    if (!address || !client) return;
    setBusy("mint");
    try {
      const hash = await writeContract({
        address: ADDR.kusdt, abi: erc20Abi, functionName: "mint",
        args: [address, parseEther("10000")], gas: 80_000n,
      });
      await client.waitForTransactionReceipt({ hash });
      toast.success(t("faucet.minted"));
    } catch (e) {
      toast.error(/insufficient|enough funds/i.test(String(e)) ? t("faucet.needGasForMint") : t("faucet.error"));
    } finally { setBusy(null); refetchAll(); }
  };

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onClick={() => setOpen(false)}>
      <div className="w-full max-w-[400px] overflow-hidden rounded-xl border border-line bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line bg-panel2 px-5 py-3.5">
          <span className="text-[14px] font-semibold">🧪 {t("faucet.title")}</span>
          <button onClick={() => setOpen(false)} className="text-muted transition-colors hover:text-fg">✕</button>
        </div>

        <div className="flex flex-col gap-3 p-5">
          {/* current balances */}
          <div className="flex items-center justify-between rounded-md bg-bg px-3 py-2 text-[12px]">
            <span className="eyebrow">{t("faucet.yourBalance")}</span>
            <span className="tnum">
              {kubBal ? Number(formatEther(kubBal.value)).toFixed(3) : "—"} KUB
              <span className="mx-1.5 text-line">·</span>
              {kusdtBal !== undefined ? fmtUsd(tokenToUsd(kusdtBal as bigint), 0) : "—"} KUSDT
            </span>
          </div>

          {/* 1. platform faucet */}
          <button onClick={claim} disabled={busy !== null}
            className="rounded-md bg-accent py-2.5 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40">
            {busy === "claim" ? t("faucet.loading") : t("faucet.claimBtn")}
          </button>
          <p className="-mt-1.5 text-[11px] leading-relaxed text-mutedDim">{t("faucet.claimDesc")}</p>

          {/* 2. self-mint KUSDT */}
          <button onClick={mint} disabled={busy !== null}
            className="rounded-md border border-accent/50 py-2.5 text-[13px] font-semibold text-accent transition-colors hover:bg-accentDim/40 disabled:opacity-40">
            {busy === "mint" ? t("faucet.loading") : t("faucet.mintBtn")}
          </button>
          <p className="-mt-1.5 text-[11px] leading-relaxed text-mutedDim">{t("faucet.mintDesc")}</p>

          {/* 3. official faucet link */}
          <a href={OFFICIAL_FAUCET} target="_blank" rel="noopener noreferrer"
            className="rounded-md border border-line py-2.5 text-center text-[13px] font-medium text-muted transition-colors hover:border-accent/40 hover:text-fg">
            {t("faucet.official")} ↗
          </a>
        </div>
      </div>
    </div>
  );
}
