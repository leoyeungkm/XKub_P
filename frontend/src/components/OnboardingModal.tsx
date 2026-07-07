"use client";

// First-time gate: when a wallet connects and 1-click trading isn't enabled,
// prompt to turn it on. Shown once per address (until dismissed or enabled).
import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { GAS_TOPUP, useOneClickActions } from "@/lib/oneclickActions";

const seenKey = (owner: string) => `xkub.onboard.${owner.toLowerCase()}`;

export default function OnboardingModal() {
  const oc = useOneClickActions();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!oc.owner) return;
    if (oc.active) return; // already set up
    const seen = localStorage.getItem(seenKey(oc.owner));
    if (!seen) setOpen(true);
  }, [oc.owner, oc.active]);

  if (!open || !oc.owner) return null;

  const dismiss = () => {
    localStorage.setItem(seenKey(oc.owner!), "1");
    setOpen(false);
  };

  const enable = async () => {
    const ok = await oc.enable();
    if (ok) dismiss();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-[420px] overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
        <div className="border-b border-line bg-panel2 px-5 py-4">
          <div className="flex items-center gap-2 text-[15px] font-semibold">
            <span className="text-accent">⚡</span> Enable 1-Click Trading
          </div>
        </div>
        <div className="flex flex-col gap-4 p-5">
          <p className="text-[13px] leading-relaxed text-muted">
            Trade without a wallet popup on every order. A key held in your
            browser signs orders for you — it can <span className="text-fg">only trade</span>,
            never withdraw your funds.
          </p>
          <ul className="flex flex-col gap-2 text-[12.5px]">
            <Point>Authorise the agent key on-chain (one signature)</Point>
            <Point>Fund it with {formatEther(GAS_TOPUP)} KUB for gas</Point>
            <Point>Deposit collateral anytime from Portfolio</Point>
          </ul>
          <button
            onClick={enable}
            disabled={oc.busy}
            className="rounded-md bg-accent py-2.5 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {oc.busy ? "Enabling…" : "Enable 1-Click Trading"}
          </button>
          <button
            onClick={dismiss}
            className="text-[12px] text-mutedDim transition-colors hover:text-muted"
          >
            Maybe later — I'll sign each order
          </button>
        </div>
      </div>
    </div>
  );
}

function Point({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-muted">
      <span className="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
      <span>{children}</span>
    </li>
  );
}
