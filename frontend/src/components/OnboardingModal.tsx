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
import { ADDR, b32, chain, erc20Abi, kubTxOverrides, referralAbi, routerAbi, tokenToUsd, usdToToken } from "@/config/contracts";
import { errMsg, fmtNum } from "@/lib/format";
import { ensureAgentAccount, useOneClick } from "@/lib/oneclick";

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
        toast(`切換到 ${chain.name}…`);
        try {
          await switchChainAsync({ chainId: chain.id });
        } catch {
          throw new Error(`請喺錢包切換到 ${chain.name}（chainId ${chain.id}）後再試`);
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
          toast("Approving KUSDT…");
          const h = await writeContractAsync({
            address: ADDR.kusdt, abi: erc20Abi, functionName: "approve", args: [ADDR.router, 2n ** 256n - 1n],
            ...fees,
          });
          await client.waitForTransactionReceipt({ hash: h, timeout: 90_000 });
        }
      }

      toast("Setting up…");
      // Trading is gasless (agent signs, relayer pays), so the agent needs no KUB.
      // Don't spend the user's KUB funding agent gas here — the on-chain 1-click
      // fallback can be topped up manually from the Account panel if wanted.
      const code = ADDR.referral && !hasCode && refCode.length >= 3 ? b32(refCode) : ZERO32;
      const h = await writeContractAsync({
        address: ADDR.router, abi: routerAbi, functionName: "setupAccount",
        args: [agent.address, tokens, code], value: 0n, ...fees,
      });
      await client.waitForTransactionReceipt({ hash: h, timeout: 90_000 });
      toast.success("設定完成，開始交易");
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
            <span className="text-accent">⚡</span> 開始交易 · Get Started
          </div>
          <div className="flex items-center gap-3">
            <Steps step={step} />
            <button onClick={dismiss} className="text-muted transition-colors hover:text-fg" title="關閉">✕</button>
          </div>
        </div>

        {step === 0 && (
          <div className="flex flex-col gap-4 p-5">
            <p className="text-[13px] leading-relaxed text-muted">繼續前，請檢閱並接受以下條款：</p>
            <div className="flex flex-col gap-1.5 rounded-md border border-line bg-bg p-3 text-[12.5px]">
              <Legal>Terms of Use · 使用條款</Legal>
              <Legal>Privacy Policy · 私隱政策</Legal>
              <Legal>Cookie Policy · Cookie 政策</Legal>
            </div>
            <label className="flex cursor-pointer items-start gap-2 text-[12.5px] text-muted">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-accent" />
              <span>我已閱讀並同意上述條款。明白 XKub Perp 為未經審計嘅測試網軟件，永續合約具高風險，可能損失全部本金。</span>
            </label>
            <div className="flex gap-2">
              <button onClick={dismiss} className="rounded-md border border-line px-4 py-2.5 text-[13px] font-medium text-muted transition-colors hover:text-fg">
                拒絕
              </button>
              <button onClick={acceptTerms} disabled={!agreed}
                className="flex-1 rounded-md bg-accent py-2.5 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40">
                接受並繼續
              </button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="flex flex-col gap-4 p-5">
            <div className="text-[14px] font-semibold">啟用一鍵交易並入金</div>
            <p className="text-[12.5px] leading-relaxed text-muted">
              一筆交易同時完成：授權代理密鑰（免彈窗交易）、存入交易保證金。之後交易走 relayer 代付 gas，零彈窗零 gas，資金隨時可於 Portfolio 提取。
            </p>
            <div>
              <div className="mb-1.5 flex justify-between text-[11px]">
                <span className="eyebrow">入金金額 · Deposit</span>
                <button className="tnum text-accent" onClick={() => setAmount(String(Math.floor(walletUsd * 100) / 100))}>
                  錢包 {fmtNum(walletUsd)} USD
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
                <div className="eyebrow mb-1.5">邀請碼（同時生成，可留空）· Referral Code</div>
                <div className="flex items-center rounded-md border border-line bg-bg px-3 focus-within:border-accent/60">
                  <input value={refCode} onChange={(e) => setRefCode(clean(e.target.value))} placeholder="YOURCODE"
                    className="tnum w-full bg-transparent py-2 text-[14px] uppercase tracking-wide outline-none" />
                </div>
              </div>
            )}

            <button onClick={enableAndDeposit} disabled={busy}
              className="rounded-md bg-accent py-2.5 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40">
              {busy ? "設定中…" : "一鍵啟用並入金"}
            </button>
            <button onClick={() => setAmount("")}
              className="text-[12px] text-mutedDim transition-colors hover:text-muted"
              title="只啟用一鍵交易，稍後再入金">
              暫不入金，只啟用一鍵交易
            </button>
            <p className="text-[11px] leading-relaxed text-mutedDim">
              授權代理、入金、生成邀請碼一筆交易完成。交易 gas 由平台代付,你唔使入 KUB。首次需額外一次 KUSDT 授權（approve）。
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
