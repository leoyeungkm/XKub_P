"use client";

// Hyperliquid-style onboarding wizard, shown on first visit:
//   1. Accept Terms  →  2. Establish Connection (1-click + referral)  →  3. Deposit
import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { useAccount, useReadContract, useSignMessage } from "wagmi";
import toast from "react-hot-toast";
import { ADDR, erc20Abi, referralAbi, tokenToUsd } from "@/config/contracts";
import { fmtNum, fmtUsd } from "@/lib/format";
import { GAS_TOPUP, useOneClickActions } from "@/lib/oneclickActions";
import { useGetStarted } from "@/lib/getStarted";

const seenKey = (o: string) => `xkub.onboard.${o.toLowerCase()}`;
const termsKey = (o: string) => `xkub.terms.${o.toLowerCase()}`;
const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 31);
const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const TERMS_MSG = "I accept the XKub Perp Terms of Use, Privacy Policy and Cookie Policy.";

export default function OnboardingModal() {
  const { address } = useAccount();
  const gs = useGetStarted();
  const oc = useOneClickActions();
  const { signMessageAsync } = useSignMessage();

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0); // 0 terms · 1 connect · 2 deposit
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [withCode, setWithCode] = useState(true);
  const [amount, setAmount] = useState("");

  const { data: myCodeHex } = useReadContract({
    address: ADDR.referral, abi: referralAbi, functionName: "ownerCode",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!ADDR.referral },
  });
  const hasCode = !!myCodeHex && myCodeHex !== ZERO32;

  const { data: walletBal } = useReadContract({
    address: ADDR.kusdt, abi: erc20Abi, functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 8000 },
  });
  const walletUsd = walletBal !== undefined ? Number(formatEther(tokenToUsd(walletBal))) : 0;

  useEffect(() => {
    if (!address || oc.active) return;
    if (!localStorage.getItem(seenKey(address))) {
      setStep(localStorage.getItem(termsKey(address)) ? 1 : 0);
      setOpen(true);
    }
  }, [address, oc.active]);

  useEffect(() => { if (address && !code) setCode(clean(address.slice(2, 8))); }, [address, code]);

  if (!open || !address) return null;

  const dismiss = () => { localStorage.setItem(seenKey(address), "1"); setOpen(false); };

  const acceptTerms = async () => {
    setBusy(true);
    try {
      await signMessageAsync({ message: TERMS_MSG }); // gas-free consent
      localStorage.setItem(termsKey(address), "1");
      setStep(1);
    } catch { toast.error("需接受條款方可繼續"); }
    finally { setBusy(false); }
  };

  const establish = async () => {
    const ok = await gs.start(withCode && !hasCode && ADDR.referral ? code : undefined);
    if (ok) setStep(2);
  };

  const deposit = async () => {
    const ok = await oc.move("depositCollateral", amount);
    if (ok) dismiss();
  };

  const link = typeof window !== "undefined" ? `${window.location.origin}/?ref=${code || "…"}` : "";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-[440px] overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
        <div className="flex items-center justify-between border-b border-line bg-panel2 px-5 py-4">
          <div className="flex items-center gap-2 text-[15px] font-semibold">
            <span className="text-accent">⚡</span> 開始交易 · Get Started
          </div>
          <Steps step={step} />
        </div>

        {/* Step 1 — Terms */}
        {step === 0 && (
          <div className="flex flex-col gap-4 p-5">
            <p className="text-[13px] leading-relaxed text-muted">
              繼續前，請檢閱並接受以下條款：
            </p>
            <div className="flex flex-col gap-1.5 rounded-md border border-line bg-bg p-3 text-[12.5px]">
              <Legal>Terms of Use · 使用條款</Legal>
              <Legal>Privacy Policy · 私隱政策</Legal>
              <Legal>Cookie Policy · Cookie 政策</Legal>
            </div>
            <p className="text-[11px] leading-relaxed text-mutedDim">
              XKub Perp 為未經審計嘅測試網軟件，不構成投資建議。永續合約具高風險，可能損失全部本金。接受即以錢包簽署一次免 gas 的確認。
            </p>
            <div className="flex gap-2">
              <button onClick={dismiss} className="rounded-md border border-line px-4 py-2.5 text-[13px] font-medium text-muted transition-colors hover:text-fg">
                拒絕 Decline
              </button>
              <button onClick={acceptTerms} disabled={busy}
                className="flex-1 rounded-md bg-accent py-2.5 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40">
                {busy ? "簽署中…" : "接受 Accept"}
              </button>
            </div>
          </div>
        )}

        {/* Step 2 — Establish Connection */}
        {step === 1 && (
          <div className="flex flex-col gap-4 p-5">
            <div className="flex items-center gap-2 text-[14px] font-semibold">建立連線 · Establish Connection</div>
            <p className="text-[12.5px] leading-relaxed text-muted">
              開通一條專屬通道，之後交易免彈窗、即時成交。瀏覽器代理密鑰只可交易、無法提款。
            </p>
            <ul className="flex flex-col gap-2 text-[12.5px]">
              <Point>啟用 1-Click Trading（授權代理密鑰）</Point>
              <Point>充值 {formatEther(GAS_TOPUP)} KUB 作 gas</Point>
              {ADDR.referral && !hasCode && <Point>生成你的專屬邀請連結</Point>}
            </ul>
            {ADDR.referral && !hasCode && (
              <div className="rounded-md border border-line bg-bg p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="eyebrow">邀請碼 · Referral Code</span>
                  <button onClick={() => setWithCode((v) => !v)} className="text-[11px] text-muted hover:text-fg">
                    {withCode ? "跳過" : "加返"}
                  </button>
                </div>
                {withCode && (
                  <>
                    <div className="flex items-center rounded-md border border-line bg-panel px-2.5 focus-within:border-accent/60">
                      <input value={code} onChange={(e) => setCode(clean(e.target.value))} placeholder="YOURCODE"
                        className="tnum w-full bg-transparent py-2 text-[14px] uppercase tracking-wide outline-none" />
                    </div>
                    <div className="mt-1.5 truncate text-[11px] text-mutedDim">{link}</div>
                  </>
                )}
              </div>
            )}
            <button onClick={establish} disabled={gs.busy}
              className="rounded-md bg-accent py-2.5 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40">
              {gs.busy ? "建立中…" : "建立連線 Establish Connection"}
            </button>
            <button onClick={dismiss} className="text-[12px] text-mutedDim transition-colors hover:text-muted">
              稍後再說
            </button>
          </div>
        )}

        {/* Step 3 — Deposit */}
        {step === 2 && (
          <div className="flex flex-col gap-4 p-5">
            <div className="text-[14px] font-semibold">入金 · Deposit</div>
            <p className="text-[12.5px] leading-relaxed text-muted">
              存入 KUSDT 到你的交易帳戶，即可開始交易。之後可隨時於 Portfolio 提取。
            </p>
            <div>
              <div className="mb-1.5 flex justify-between text-[11px]">
                <span className="eyebrow">金額 · Amount</span>
                <span className="tnum text-muted">錢包 {fmtNum(walletUsd)} USD</span>
              </div>
              <div className="flex items-center rounded-md border border-line bg-bg px-3 focus-within:border-accent/60">
                <input type="number" min="0" placeholder="0.00" value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="tnum w-full bg-transparent py-2.5 text-[15px] outline-none" />
                <span className="eyebrow">KUSDT</span>
              </div>
              <div className="mt-1.5 grid grid-cols-5 gap-1">
                {[10, 50, 100, 500].map((v) => (
                  <button key={v} onClick={() => setAmount(String(v))}
                    className="tnum rounded bg-panel2 py-1.5 text-[11.5px] text-muted transition-colors hover:text-fg">${v}</button>
                ))}
                <button onClick={() => setAmount(String(Math.floor(walletUsd * 100) / 100))}
                  className="tnum rounded bg-panel2 py-1.5 text-[11.5px] text-accent transition-colors hover:opacity-80">Max</button>
              </div>
            </div>
            <button onClick={deposit} disabled={oc.busy}
              className="rounded-md bg-accent py-2.5 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40">
              {oc.busy ? "入金中…" : "入金並開始交易"}
            </button>
            <button onClick={dismiss} className="text-[12px] text-mutedDim transition-colors hover:text-muted">
              稍後再入金
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Steps({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-1.5">
      {[0, 1, 2].map((i) => (
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

function Point({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-muted">
      <span className="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
      <span>{children}</span>
    </li>
  );
}
