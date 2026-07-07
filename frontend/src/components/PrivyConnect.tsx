"use client";

// Rendered only when Privy is enabled — usePrivy throws outside PrivyProvider.
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useSetActiveWallet } from "@privy-io/wagmi";
import { useAccount } from "wagmi";
import { useEffect } from "react";
import toast from "react-hot-toast";
import { shortAddr } from "@/lib/format";

export default function PrivyConnect() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const { address, isConnected } = useAccount();

  const embedded = wallets.find((w) => w.walletClientType === "privy");

  // wagmi doesn't always adopt the embedded wallet as the active one after
  // login — force-sync so useAccount/useBalance across the app light up.
  useEffect(() => {
    if (authenticated && !isConnected && embedded) {
      setActiveWallet(embedded);
    }
  }, [authenticated, isConnected, embedded, setActiveWallet]);

  if (!ready) {
    return (
      <div className="rounded-lg border border-line bg-panel2 px-4 py-2 text-muted">…</div>
    );
  }

  if (!authenticated) {
    return (
      <button
        onClick={login}
        className="rounded-lg bg-accent px-4 py-2 font-semibold text-white"
      >
        Log in
      </button>
    );
  }

  const shown = address ?? embedded?.address;

  return (
    <div className="flex items-center gap-2">
      {shown && (
        <button
          onClick={() => {
            navigator.clipboard.writeText(shown);
            toast.success("Address copied — send KUSDT/KUB here");
          }}
          className="rounded-lg border border-line bg-panel2 px-3 py-2 text-[12.5px]"
          title={`${shown}\nClick to copy`}
        >
          {shortAddr(shown)} ⧉
        </button>
      )}
      <button
        onClick={logout}
        className="rounded-lg border border-line bg-panel2 px-4 py-2 font-semibold"
        title="Log out"
      >
        {user?.email?.address ?? "Log out"}
      </button>
    </div>
  );
}
