"use client";

// Minimal onboarding, shown on first visit:
//   1. Accept Terms (checkbox, no wallet popup)
//   2. Enable & Deposit — one wallet confirmation via router.setupAccount
//      (authorise agent + deposit collateral + fund gas), plus an approve
//      the first time. 1–2 popups total instead of 4–6.
import { useEffect, useState } from "react";
import { formatEther, parseEther } from "viem";
import { useAccount, useChainId, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import toast from "react-hot-toast";
import { ADDR, b32, chain, erc20Abi, kubTxOverrides, referralAbi, requestFaucet, routerAbi, tokenToUsd, usdToToken } from "@/config/contracts";
import { errMsg, fmtNum } from "@/lib/format";
import { ensureAgentAccount, useOneClick } from "@/lib/oneclick";
import { useT } from "@/lib/i18n";

const seenKey = (o: string) => `xkub.onboard.${o.toLowerCase()}`;
const termsKey = (o: string) => `xkub.terms.${o.toLowerCase()}`;
const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 31);
const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export default function OnboardingModal() {
  const { address } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const walletChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const oc = useOneClick();
  const t = useT();

  const getFaucet = async () => {
    if (!address) return;
    const p = requestFaucet(address);
    toast.promise(p, { loading: t("faucet.loading"), success: t("faucet.success"), error: t("faucet.error") });
    await p;
  };

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0); // 0 terms · 1 enable+deposit
  const [agreed, setAgreed] = useState(false);
  const [amount, setAmount] = useState("");
  const [refCode, setRefCode] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: walletBal } = useReadContract({
    address: ADDR.kusdt, abi: erc20Abi, functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 8000 },
  });
  const walletUsd = walletBal !== undefined ? Number(formatEther(tokenToUsd(walletBal))) : 0;

  const { data: myCodeHex } = useReadContract({
    address: ADDR.referral, abi: referralAbi, functionName: "ownerCode",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!ADDR.referral },
  });
  const hasCode = !!myCodeHex && myCodeHex !== ZERO32;

  useEffect(() => {
    // Already onboarded — agent authorised, or collateral already deposited.
    if (!address || oc.active || oc.balance > 0n) return;
    if (!localStorage.getItem(seenKey(address))) {
      setStep(localStorage.getItem(termsKey(address)) ? 1 : 0);
      setAgreed(!!localStorage.getItem(termsKey(address)));
      setOpen(true);
    }
  }, [address, oc.active, oc.balance]);

  useEffect(() => {
    const openIt = () => {
      const t = address ? !!localStorage.getItem(termsKey(address)) : false;
      setStep(t ? 1 : 0); setAgreed(t); setOpen(true);
    };
    window.addEventListener("xkub:getstarted", openIt);
    return () => window.removeEventListener("xkub:getstarted", openIt);
  }, [address]);

  useEffect(() => { if (address && !amount) setAmount("100"); }, [address, amount]);
  useEffect(() => { if (address && !refCode) setRefCode(clean(address.slice(2, 8))); }, [address, refCode]);

  if (!open || !address) return null;

  const dismiss = () => { localStorage.setItem(seenKey(address), "1"); setOpen(false); };

  const acceptTerms = () => {
    if (!agreed) return;
    localStorage.setItem(termsKey(address), "1");
    setStep(1);
  };

  const enableAndDeposit = async () => {
    if (!client) return;
    setBusy(true);
    try {
      // The tx silently goes nowhere if the wallet is on another network —
      // force it onto KUB testnet first, and surface a clear error if it won't.
      if (walletChainId !== chain.id) {
        toast(t("onb.switching"));
        try {
          await switchChainAsync({ chainId: chain.id });
        } catch {
          throw new Error(`請喺錢包切換到 ${chain.name}（chainId ${chain.id}）後再試`);
        }
      }

      // Email/embedded-wallet users start with 0 tKUB and can't pay for the setup
      // gas — top them up from the faucet (also mints test KUSDT) and wait for it.
      const kub = await client.getBalance({ address });
      if (kub < parseEther("0.08")) {
        toast(t("faucet.loading"));
        await requestFaucet(address);
        for (let i = 0; i < 12; i++) {
          await new Promise((r) => setTimeout(r, 2500));
          if ((await client.getBalance({ address })) >= parseEther("0.05")) break;
        }
      }

      const agent = ensureAgentAccount(address);
      const n = Number(amount || "0");
      const tokens = n > 0 ? usdToToken(parseEther(String(n))) : 0n;
      // KUB is legacy-only; force Type-0 or OKX/MetaMask txs get dropped silently.
      const fees = await kubTxOverrides(client);

      if (tokens > 0) {
        const allowance = await client.readContract({
          address: ADDR.kusdt, abi: erc20Abi, functionName: "allowance", args: [address, ADDR.router],
        });
        if (allowance < tokens) {
          toast(t("onb.approving"));
          const h = await writeContractAsync({
            address: ADDR.kusdt, abi: erc20Abi, functionName: "approve", args: [ADDR.router, 2n ** 256n - 1n],
            ...fees,
          });
          await client.waitForTransactionReceipt({ hash: h, timeout: 90_000 });
        }
      }

      toast(t("onb.settingUp"));
      // Trading is gasless (agent signs, relayer pays), so the agent needs no KUB.
      // Don't spend the user's KUB funding agent gas here — the on-chain 1-click
      // fallback can be topped up manually from the Account panel if wanted.
      const code = ADDR.referral && !hasCode && refCode.length >= 3 ? b32(refCode) : ZERO32;
      const h = await writeContractAsync({
        address: ADDR.router, abi: routerAbi, functionName: "setupAccount",
        args: [agent.address, tokens, code], value: 0n, ...fees,
      });
      await client.waitForTransactionReceipt({ hash: h, timeout: 90_000 });
      toast.success(t("onb.setupDone"));
      oc.refetch();
      dismiss();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-[440px] overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
        <div className="flex items-center justify-between border-b border-line bg-panel2 px-5 py-4">
          <div className="flex items-center gap-2 text-[15px] font-semibold">
            <span className="text-accent">⚡</span> {t("onb.title")}
          </div>
          <div className="flex items-center gap-3">
            <Steps step={step} />
            <button onClick={dismiss} className="text-muted transition-colors hover:text-fg" title="✕">✕</button>
          </div>
        </div>

        {step === 0 && (
          <div className="flex flex-col gap-4 p-5">
            <p className="text-[13px] leading-relaxed text-muted">{t("onb.termsIntro")}</p>
            <div className="flex flex-col gap-1.5 rounded-md border border-line bg-bg p-3 text-[12.5px]">
              <Legal>{t("onb.terms")}</Legal>
              <Legal>{t("onb.privacy")}</Legal>
              <Legal>{t("onb.cookie")}</Legal>
            </div>
            <label className="flex cursor-pointer items-start gap-2 text-[12.5px] text-muted">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-accent" />
              <span>{t("onb.agree")}</span>
            </label>
            <div className="flex gap-2">
              <button onClick={dismiss} className="rounded-md border border-line px-4 py-2.5 text-[13px] font-medium text-muted transition-colors hover:text-fg">
                {t("onb.decline")}
              </button>
              <button onClick={acceptTerms} disabled={!agreed}
                className="flex-1 rounded-md bg-accent py-2.5 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40">
                {t("onb.accept")}
              </button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="flex flex-col gap-4 p-5">
            <div className="text-[14px] font-semibold">{t("onb.setupTitle")}</div>
            <p className="text-[12.5px] leading-relaxed text-muted">
              {t("onb.setupDesc")}
            </p>

            {/* Testnet notice + one-tap faucet for everyone */}
            <div className="flex items-center gap-2 rounded-md border border-accent/30 bg-accentDim/40 px-3 py-2 text-[11.5px] text-muted">
              <span className="leading-relaxed">{t("onb.testnet")}</span>
              <button
                onClick={getFaucet}
                className="ml-auto shrink-0 rounded bg-accent px-2 py-1 text-[11px] font-medium text-bg transition-opacity hover:opacity-90"
              >
                {t("onb.getTestFunds")}
              </button>
            </div>

            <div>
              <div className="mb-1.5 flex justify-between text-[11px]">
                <span className="eyebrow">{t("onb.depositLabel")}</span>
                <button className="tnum text-accent" onClick={() => setAmount(String(Math.floor(walletUsd * 100) / 100))}>
                  {t("onb.wallet")} {fmtNum(walletUsd)} USD
                </button>
              </div>
              <div className="flex items-center rounded-md border border-line bg-bg px-3 focus-within:border-accent/60">
                <input type="number" min="0" placeholder="0.00" value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="tnum w-full bg-transparent py-2.5 text-[15px] outline-none" />
                <span className="eyebrow">KUSDT</span>
              </div>
              <div className="mt-1.5 grid grid-cols-4 gap-1">
                {[50, 100, 500, 1000].map((v) => (
                  <button key={v} onClick={() => setAmount(String(v))}
                    className="tnum rounded bg-panel2 py-1.5 text-[11.5px] text-muted transition-colors hover:text-fg">${v}</button>
                ))}
              </div>
            </div>

            {ADDR.referral && !hasCode && (
              <div>
                <div className="eyebrow mb-1.5">{t("onb.refCode")}</div>
                <div className="flex items-center rounded-md border border-line bg-bg px-3 focus-within:border-accent/60">
                  <input value={refCode} onChange={(e) => setRefCode(clean(e.target.value))} placeholder="YOURCODE"
                    className="tnum w-full bg-transparent py-2 text-[14px] uppercase tracking-wide outline-none" />
                </div>
              </div>
            )}

            <button onClick={enableAndDeposit} disabled={busy}
              className="rounded-md bg-accent py-2.5 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40">
              {busy ? t("onb.settingUp") : t("onb.setupBtn")}
            </button>
            <button onClick={() => setAmount("")}
              className="text-[12px] text-mutedDim transition-colors hover:text-muted"
              title={t("onb.skipDeposit")}>
              {t("onb.skipDeposit")}
            </button>
            <p className="text-[11px] leading-relaxed text-mutedDim">
              {t("onb.setupNote")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Steps({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {[0, 1].map((i) => (
        <span key={i} className={`h-1.5 w-5 rounded-full ${i <= step ? "bg-accent" : "bg-line"}`} />
      ))}
    </div>
  );
}
function Legal({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-fg">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
      {children}
    </div>
  );
}
