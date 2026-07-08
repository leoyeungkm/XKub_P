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

  const navItems = [
    { href: "/", label: t("nav.trade") },
    { href: "/portfolio", label: t("nav.portfolio") },
    { href: "/earn", label: t("nav.earn") },
    { href: "/referral", label: t("nav.referral") },
    ...(isAdmin ? [{ href: "/admin", label: "Admin" }] : []),
  ];

  return (
    <>
    <header className="flex items-center gap-2 border-b border-line bg-panel/60 px-3 py-2.5 backdrop-blur sm:gap-4 sm:px-5 sm:py-3">
      <div className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-accent text-[13px] font-bold text-bg">X</span>
        <span className="hidden sm:inline">Kub<span className="text-muted">Perp</span></span>
      </div>
      {/* desktop nav — mobile uses the bottom bar */}
      <nav className="hidden items-center gap-0.5 text-[13px] md:flex">
        {navItems.map((n) => <NavLink key={n.href} href={n.href} label={n.label} active={pathname === n.href} />)}
      </nav>
      <div className="hidden items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[10.5px] text-muted lg:flex">
        <span className="h-1.5 w-1.5 rounded-full bg-green" />
        {CFG.chainName}
      </div>
      <div className="flex-1" />
      {isConnected && (
        <button
          onClick={() => window.dispatchEvent(new Event("xkub:getstarted"))}
          className="hidden rounded-md bg-accentDim px-3 py-2 text-[12px] font-medium text-accent transition-opacity hover:opacity-90 sm:block"
        >
          {t("onb.getStarted")}
        </button>
      )}
      <LangToggle />
      <ThemeToggle />
      <button
        title={t("faucet.button")}
        onClick={faucet}
        className="rounded-md border border-line px-2.5 py-2 text-[12px] text-muted transition-colors hover:border-accent/40 hover:text-fg sm:px-3"
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
          className="rounded-md bg-accent px-3 py-2 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90 sm:px-4 sm:text-[14px]"
        >
          Connect
        </button>
      )}
    </header>

    {/* mobile bottom tab bar */}
    <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-panel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      {navItems.map((n) => {
        const active = pathname === n.href;
        return (
          <Link key={n.href} href={n.href}
            className={`flex-1 py-2.5 text-center text-[12px] font-medium transition-colors ${active ? "text-accent" : "text-muted"}`}>
            {n.label}
          </Link>
        );
      })}
    </nav>
    </>
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
