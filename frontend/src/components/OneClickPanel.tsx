"use client";

import Link from "next/link";
import { formatEther, parseEther } from "viem";
import { useAccount } from "wagmi";
import { fmtUsd, shortAddr } from "@/lib/format";
import { tokenToUsd } from "@/config/contracts";
import { GAS_TOPUP, useOneClickActions } from "@/lib/oneclickActions";

// Trade-page widget: status + gas top-up + disable. Enabling is driven by the
// onboarding modal; collateral deposit/withdraw lives in Portfolio.
export default function OneClickPanel() {
  const oc = useOneClickActions();
  const { connector } = useAccount();

  // Privy embedded wallets already sign silently — the agent key only helps
  // external wallets that pop a confirmation per tx.
  if (connector?.id === "io.privy.wallet") return null;
  // Nothing to configure without a connected wallet.
  if (!oc.owner) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-panel">
      <h3 className="eyebrow flex items-center justify-between border-b border-line px-3.5 py-2.5">
        <span>⚡ 1-Click Trading</span>
        <span className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium ${
          oc.active ? "bg-greenDim text-green" : "bg-panel2 text-mutedDim"
        }`}>
          <span className={`h-1.5 w-1.5 rounded-full ${oc.active ? "bg-green" : "bg-mutedDim"}`} />
          {oc.active ? "ON" : "OFF"}
        </span>
      </h3>

      <div className="flex flex-col gap-2 p-3">
        {!oc.active ? (
          <>
            <p className="text-[12px] leading-relaxed text-muted">
              Sign orders silently with a browser-held key that can only trade,
              never withdraw.
            </p>
            <button
              onClick={oc.enable} disabled={oc.busy}
              className="rounded-md bg-accent py-2.5 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {oc.busy ? "Enabling…" : "Enable 1-Click Trading"}
            </button>
          </>
        ) : (
          <>
            <p className="text-[12px] leading-relaxed text-muted">
              一鍵交易已啟用，餘額與 Agent gas 見下方 Account。
            </p>
            <div className="flex items-center gap-2 text-[11px]">
              <button onClick={oc.topUp} disabled={oc.busy} className="text-accent transition-opacity hover:opacity-80 disabled:opacity-40">
                充 gas +{formatEther(GAS_TOPUP)} KUB
              </button>
              <Link href="/portfolio" className="text-muted hover:text-fg">入金 →</Link>
              <div className="flex-1" />
              <button onClick={oc.disable} disabled={oc.busy} className="text-mutedDim transition-colors hover:text-red disabled:opacity-40">
                停用
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
