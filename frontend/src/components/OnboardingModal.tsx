"use client";

// First-time gate: when a wallet connects and 1-click trading isn't enabled,
// prompt to set up the account in one tap — enable 1-click AND generate a
// referral link together (batched via EIP-5792 when the wallet supports it).
import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { useAccount, useReadContract } from "wagmi";
import { ADDR, referralAbi } from "@/config/contracts";
import { GAS_TOPUP } from "@/lib/oneclickActions";
import { useGetStarted } from "@/lib/getStarted";

const seenKey = (owner: string) => `xkub.onboard.${owner.toLowerCase()}`;
const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 31);
const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

export default function OnboardingModal() {
  const { address } = useAccount();
  const gs = useGetStarted();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [withCode, setWithCode] = useState(true);

  const { data: myCodeHex } = useReadContract({
    address: ADDR.referral, abi: referralAbi, functionName: "ownerCode",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!ADDR.referral },
  });
  const hasCode = !!myCodeHex && myCodeHex !== ZERO32;

  useEffect(() => {
    if (!gs.owner || gs.active) return;
    if (!localStorage.getItem(seenKey(gs.owner))) setOpen(true);
  }, [gs.owner, gs.active]);

  useEffect(() => {
    if (address && !code) setCode(clean(address.slice(2, 8)));
  }, [address, code]);

  if (!open || !gs.owner) return null;

  const dismiss = () => { localStorage.setItem(seenKey(gs.owner!), "1"); setOpen(false); };
  const go = async () => {
    const ok = await gs.start(withCode && !hasCode && ADDR.referral ? code : undefined);
    if (ok) dismiss();
  };

  const link = typeof window !== "undefined" ? `${window.location.origin}/?ref=${code || "…"}` : "";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-[440px] overflow-hidden rounded-xl border border-line bg-panel shadow-2xl">
        <div className="border-b border-line bg-panel2 px-5 py-4">
          <div className="flex items-center gap-2 text-[15px] font-semibold">
            <span className="text-accent">⚡</span> 一鍵開始 · Get Started
          </div>
        </div>
        <div className="flex flex-col gap-4 p-5">
          <p className="text-[13px] leading-relaxed text-muted">
            一次過完成設定，之後交易免彈窗。瀏覽器代理密鑰只可交易、無法提款。
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
                  {withCode ? "唔要，跳過" : "加返"}
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

          <button onClick={go} disabled={gs.busy}
            className="rounded-md bg-accent py-2.5 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40">
            {gs.busy ? "設定中…" : "一鍵開始"}
          </button>
          <button onClick={dismiss} className="text-[12px] text-mutedDim transition-colors hover:text-muted">
            稍後再說，我逐次簽名
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
