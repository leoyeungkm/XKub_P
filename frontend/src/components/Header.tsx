"use client";

import {
  useAccount, useBalance, useConnect, useDisconnect, useReadContract,
  usePublicClient,
} from "wagmi";
import Link from "next/link";
import { usePathname } from "next/navigation";
import toast from "react-hot-toast";
import ThemeToggle from "./ThemeToggle";
import { useT, LangToggle } from "@/lib/i18n";
import { ADDR, CFG, chain, erc20Abi, tokenToUsd } from "@/config/contracts";
import { openFaucet } from "@/components/FaucetModal";
import { shortAddr, errMsg, fmtUsd } from "@/lib/format";
import { PRIVY_ENABLED } from "@/lib/privy";
import PrivyConnect from "./PrivyConnect";
import { formatEther } from "viem";

export default function Header() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const client = usePublicClient();
  const pathname = usePathname();
  const t = useT();

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
  const { data: adminAddr } = useReadContract({
    address: ADDR.market,
    abi: [{ type: "function", name: "admin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const,
    functionName: "admin",
    query: { enabled: !!address },
  });
  const isAdmin = !!address && !!adminAddr && address.toLowerCase() === (adminAddr as string).toLowerCase();

  const faucet = () => {
    if (!address) return toast.error(t("toast.connectFirst"));
    openFaucet(); // popup: platform claim / self-mint KUSDT / official faucet link
  };

  return (
    <header className="flex items-center gap-4 border-b border-line bg-panel/60 px-5 py-3 backdrop-blur">
      <div className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-accent text-[13px] font-bold text-bg">X</span>
        Kub<span className="text-muted">Perp</span>
      </div>
      <nav className="flex items-center gap-0.5 text-[13px]">
        <NavLink href="/" label={t("nav.trade")} active={pathname === "/"} />
        <NavLink href="/portfolio" label={t("nav.portfolio")} active={pathname === "/portfolio"} />
        <NavLink href="/earn" label={t("nav.earn")} active={pathname === "/earn"} />
        <NavLink href="/referral" label={t("nav.referral")} active={pathname === "/referral"} />
        {isAdmin && <NavLink href="/admin" label="Admin" active={pathname === "/admin"} />}
      </nav>
      <div className="hidden items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[10.5px] text-muted lg:flex">
        <span className="h-1.5 w-1.5 rounded-full bg-green" />
        {CFG.chainName}
      </div>
      <div className="flex-1" />
      {isConnected && (
        <button
          onClick={() => window.dispatchEvent(new Event("xkub:getstarted"))}
          className="rounded-md bg-accentDim px-3 py-2 text-[12px] font-medium text-accent transition-opacity hover:opacity-90"
        >
          {t("onb.getStarted")}
        </button>
      )}
      <LangToggle />
      <ThemeToggle />
      <button
        title={t("faucet.button")}
        onClick={faucet}
        className="rounded-md border border-line px-3 py-2 text-[12px] text-muted transition-colors hover:border-accent/40 hover:text-fg"
      >
        {t("faucet.button")}
      </button>
      {isConnected && address ? (
        <>
          <div className="hidden items-center gap-3 rounded-md border border-line bg-panel2 px-3.5 py-2 text-[12px] sm:flex">
            <span className="flex items-center gap-1.5">
              <span className="eyebrow !tracking-normal">KUB</span>
              <span className="tnum">{kubBal ? Number(formatEther(kubBal.value)).toLocaleString(undefined, { maximumFractionDigits: 3 }) : "—"}</span>
            </span>
            <span className="text-line">·</span>
            <span className="flex items-center gap-1.5">
              <span className="eyebrow !tracking-normal">KUSDT</span>
              <span className="tnum">{kusdtBal !== undefined ? fmtUsd(tokenToUsd(kusdtBal)) : "—"}</span>
            </span>
          </div>
          {PRIVY_ENABLED ? (
            <PrivyConnect />
          ) : (
            <button
              onClick={() => disconnect()}
              className="tnum rounded-md border border-line bg-panel2 px-3.5 py-2 font-medium transition-colors hover:border-red/40 hover:text-red"
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
          className="rounded-md bg-accent px-4 py-2 font-semibold text-bg transition-opacity hover:opacity-90"
        >
          Connect Wallet
        </button>
      )}
    </header>
  );
}

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
        active ? "bg-panel2 text-fg" : "text-muted hover:text-fg"
      }`}
    >
      {label}
    </Link>
  );
}
