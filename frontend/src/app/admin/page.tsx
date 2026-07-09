"use client";

// Admin console — parameter governance + ops monitoring. Gated on-chain by
// market.admin(): the page renders for anyone but every write is onlyAdmin, and
// non-admins are shown a locked view. The server holds no keys; the admin signs
// with their own wallet through useKubWrite (legacy tx + auto chain-switch).
import { useEffect, useMemo, useState } from "react";
import { formatEther, parseEther } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import toast from "react-hot-toast";
import { ADDR, MARKETS, RELAYER_URL, b32, tokenToUsd, usdToToken } from "@/config/contracts";
import { adminMarketAbi, adminOracleAbi, adminPoolAbi, adminRouterAbi, adminReferralAbi, type KeeperStatus } from "@/config/adminAbi";
import { errMsg, fmtUsd, fmtNum, shortAddr } from "@/lib/format";
import { useKubWrite } from "@/lib/kubWrite";

const STATUS_URL = RELAYER_URL ? RELAYER_URL.replace(/\/order\/?$/, "/status") : "";
const ERRORS_URL = RELAYER_URL ? RELAYER_URL.replace(/\/order\/?$/, "/errors") : "";
const METRICS_URL = RELAYER_URL ? RELAYER_URL.replace(/\/order\/?$/, "/metrics") : "";

type Metrics = {
  usersTotal: number; weeklyActiveWallets: number; dailyActiveWallets: number;
  tradesTotal: number; volumeTotalUsd: number; volume7dUsd: number; volume24hUsd: number;
  indexedFromBlock: number; indexedToBlock: number; ready: boolean;
};
const bn = (x: unknown) => (x as bigint | undefined) ?? 0n;

export default function AdminPage() {
  const { address } = useAccount();
  const { writeContract } = useKubWrite();

  // ── batched reads ───────────────────────────────────────────────────────────
  const market = { address: ADDR.market, abi: adminMarketAbi } as const;
  const oracle = { address: ADDR.oracle, abi: adminOracleAbi } as const;
  const pool = { address: ADDR.pool, abi: adminPoolAbi } as const;
  const router = { address: ADDR.router, abi: adminRouterAbi } as const;
  const referral = { address: ADDR.referral as `0x${string}`, abi: adminReferralAbi } as const;

  const { data, refetch } = useReadContracts({
    contracts: [
      { ...market, functionName: "admin" },              // 0
      { ...market, functionName: "treasury" },           // 1
      { ...market, functionName: "paused" },             // 2
      { ...market, functionName: "positionFeeBps" },     // 3
      { ...market, functionName: "maintenanceMarginBps" },// 4
      { ...market, functionName: "liquidationFeeUsd" },  // 5
      { ...market, functionName: "maxProfitBps" },       // 6
      { ...market, functionName: "minCollateralUsd" },   // 7
      { ...market, functionName: "maxPriceAge" },        // 8
      { ...market, functionName: "protocolFeeShareBps" },// 9
      { ...market, functionName: "rapidCloseFeeBps" },   // 10
      { ...market, functionName: "rapidCloseWindow" },   // 11
      { ...market, functionName: "openPositionCount" },  // 12
      { ...market, functionName: "totalOpenInterestUsd" },// 13
      { ...pool, functionName: "poolValueUsd" },         // 14
      { ...pool, functionName: "totalSupply" },          // 15
      { ...pool, functionName: "reserveFactorBps" },     // 16
      { ...pool, functionName: "withdrawCooldown" },     // 17
      { ...oracle, functionName: "maxDeviationBps" },    // 18
      { ...oracle, functionName: "maxSignedDeviationBps" },// 19
      { ...oracle, functionName: "maxSignedAge" },       // 20
      { ...router, functionName: "minExecutionFee" },    // 21
      { ...router, functionName: "maxExecuteAge" },      // 22
      { ...router, functionName: "cancelDelay" },        // 23
      { ...referral, functionName: "defaultRebateBps" }, // 24
      { ...referral, functionName: "referredDiscountBps" },// 25
      ...MARKETS.map((m) => ({ ...market, functionName: "marketConfig" as const, args: [b32(m.symbol)] as const })), // 26+
    ] as never[],
    query: { refetchInterval: 12_000 },
  });

  const r = (i: number) => data?.[i]?.result;
  const adminAddr = r(0) as string | undefined;
  const isAdmin = !!address && !!adminAddr && address.toLowerCase() === adminAddr.toLowerCase();

  // ── keeper ops status + traction metrics ────────────────────────────────────
  const [status, setStatus] = useState<KeeperStatus | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  useEffect(() => {
    const load = () => {
      if (STATUS_URL) fetch(STATUS_URL, { signal: AbortSignal.timeout(15000) }).then((x) => x.json()).then(setStatus).catch(() => {});
      if (METRICS_URL) fetch(METRICS_URL, { signal: AbortSignal.timeout(15000) }).then((x) => x.json()).then(setMetrics).catch(() => {});
    };
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, []);

  // generic write wrapper
  const write = async (call: () => Promise<`0x${string}`>) => {
    try {
      const hash = await call();
      toast.success("Transaction sent");
      setTimeout(refetch, 4000);
      return hash;
    } catch (e) { toast.error(errMsg(e)); throw e; }
  };

  if (!address) return <Locked title="Admin Console" msg="Connect the admin wallet to continue." />;
  if (adminAddr && !isAdmin) return <Locked title="Not authorized" msg={`This wallet is not the admin. Admin is ${shortAddr(adminAddr)}.`} />;

  const util = bn(r(13)) > 0n && bn(r(14)) > 0n
    ? Number((bn(r(13)) * 10000n) / bn(r(14))) / 100 : 0;

  return (
    <main className="mx-auto max-w-[1100px] p-4">
      <header className="mb-4 flex items-center gap-3">
        <h1 className="text-[18px] font-semibold">Admin Console</h1>
        <span className="rounded bg-greenDim px-2 py-0.5 text-[11px] font-medium text-green">admin ✓</span>
        {bn(r(2)) === 1n
          ? <span className="rounded bg-redDim px-2 py-0.5 text-[11px] font-medium text-red">TRADING PAUSED</span>
          : <span className="rounded bg-panel2 px-2 py-0.5 text-[11px] text-muted">live</span>}
      </header>

      {/* ── TRACTION (on-chain, indexed) ── */}
      <Section title="Users & traction">
        {metrics ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat k="Total users" v={String(metrics.usersTotal)} />
              <Stat k="Weekly active" v={String(metrics.weeklyActiveWallets)} />
              <Stat k="Daily active" v={String(metrics.dailyActiveWallets)} />
              <Stat k="Total trades" v={String(metrics.tradesTotal)} />
              <Stat k="Volume · total" v={`$${metrics.volumeTotalUsd.toLocaleString()}`} />
              <Stat k="Volume · 7d" v={`$${metrics.volume7dUsd.toLocaleString()}`} />
              <Stat k="Volume · 24h" v={`$${metrics.volume24hUsd.toLocaleString()}`} />
              <Stat k="Indexed status" v={metrics.ready ? "up to date" : "indexing…"} tone={metrics.ready ? undefined : "red"} />
            </div>
            <p className="text-[11px] text-mutedDim">
              Indexed from on-chain deposit/open/close events (blocks {metrics.indexedFromBlock.toLocaleString()}–{metrics.indexedToBlock.toLocaleString()}).
              Volume counts both opens and closes. Includes all wallets — subtract team/test wallets for grant &quot;external&quot; reporting.
            </p>
          </>
        ) : <div className="px-1 py-3 text-[12px] text-mutedDim">metrics unavailable (keeper indexing or offline)</div>}
      </Section>

      {/* ── OPS (read-only) ── */}
      <Section title="Operations">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat k="Pool TVL" v={`${fmtUsd(bn(r(14)), 0)} USD`} />
          <Stat k="XPLP supply" v={fmtNum(Number(formatEther(bn(r(15)))), 0)} />
          <Stat k="Utilization" v={`${util.toFixed(1)}%`} tone={util > 80 ? "red" : undefined} />
          <Stat k="Open Interest" v={`${fmtUsd(bn(r(13)), 0)} USD`} />
          <Stat k="Open positions" v={String(bn(r(12)))} />
          <Stat k="Reserve" v={`${Number(bn(r(16))) / 100}% of OI`} />
          <Stat k="Keeper gas price" v={status ? `${status.gasPriceGwei} gwei` : "—"} />
          <Stat k="Relayer errors" v={status ? String(status.errors) : "—"} tone={status && status.errors > 0 ? "red" : undefined} />
        </div>

        <div className="mt-3 overflow-hidden rounded-md border border-line">
          <table className="w-full text-[12px]">
            <thead><tr className="eyebrow text-left">
              {["Keeper wallet", "Roles", "KUB", ""].map((h) => <th key={h} className="border-b border-line px-3 py-1.5 font-normal">{h}</th>)}
            </tr></thead>
            <tbody>
              {status?.wallets.map((w) => {
                const low = Number(w.kub) < 0.5;
                return (
                  <tr key={w.address} className="border-b border-lineSoft last:border-0">
                    <td className="tnum px-3 py-2">{shortAddr(w.address)}</td>
                    <td className="px-3 py-2 text-muted">{w.roles.join(" · ")}</td>
                    <td className={`tnum px-3 py-2 ${low ? "text-red" : ""}`}>{Number(w.kub).toFixed(3)}{low ? " ⚠️" : ""}</td>
                    <td className="px-3 py-2 text-right text-mutedDim">{w.roles.includes("faucet") ? `${fmtNum(Number(status.faucetKusdt), 0)} KUSDT stock` : ""}</td>
                  </tr>
                );
              }) ?? <tr><td colSpan={4} className="px-3 py-3 text-center text-mutedDim">keeper status unavailable</td></tr>}
            </tbody>
          </table>
        </div>
        {ERRORS_URL && <a href={ERRORS_URL} target="_blank" rel="noreferrer" className="mt-2 inline-block text-[11px] text-accent hover:opacity-80">View recent relayer errors ↗</a>}
      </Section>

      {/* ── EMERGENCY ── */}
      <Section title="Emergency">
        <div className="flex items-center justify-between rounded-md border border-line bg-bg px-3 py-2.5">
          <div>
            <div className="text-[13px] font-medium">Trading pause</div>
            <div className="text-[11px] text-mutedDim">Blocks all new opens & closes. Use for incidents.</div>
          </div>
          <button
            onClick={() => write(() => writeContract({ ...market, functionName: "setPaused", args: [bn(r(2)) !== 1n] }))}
            className={`rounded-md px-4 py-2 text-[13px] font-semibold ${bn(r(2)) === 1n ? "bg-green text-bg" : "bg-red text-bg"}`}
          >
            {bn(r(2)) === 1n ? "Resume trading" : "Pause trading"}
          </button>
        </div>
      </Section>

      {/* ── GLOBAL PARAMS ── */}
      <Section title="Global parameters">
        <GlobalParamsForm
          cur={{
            positionFeeBps: String(bn(r(3))), maintenanceMarginBps: String(bn(r(4))),
            liquidationFeeUsd: formatEther(bn(r(5))), maxProfitBps: String(bn(r(6))),
            minCollateralUsd: formatEther(bn(r(7))), maxPriceAge: String(bn(r(8))),
          }}
          onApply={(v) => write(() => writeContract({
            ...market, functionName: "setGlobalParams",
            args: [BigInt(v.positionFeeBps), BigInt(v.maintenanceMarginBps), parseEther(v.liquidationFeeUsd || "0"),
              BigInt(v.maxProfitBps), parseEther(v.minCollateralUsd || "0"), BigInt(v.maxPriceAge)],
          }))}
        />
      </Section>

      {/* ── PER-MARKET ── */}
      <Section title="Markets">
        {MARKETS.map((m, i) => {
          const cfg = r(26 + i) as readonly [boolean, bigint, bigint, bigint] | undefined;
          return (
            <MarketForm key={m.symbol} symbol={m.symbol}
              cur={{ maxLeverageX: String(cfg?.[1] ?? 0n), maxOiUsd: formatEther(cfg?.[2] ?? 0n), borrowRateFactorBps: String(cfg?.[3] ?? 0n) }}
              onApply={(v) => write(() => writeContract({
                ...market, functionName: "configureMarket",
                args: [b32(m.symbol), BigInt(v.maxLeverageX), parseEther(v.maxOiUsd || "0"), BigInt(v.borrowRateFactorBps)],
              }))}
            />
          );
        })}
      </Section>

      {/* ── FEES & TREASURY ── */}
      <Section title="Fees & treasury">
        <ParamRow label="Protocol fee share" cur={String(bn(r(9)))} unit="bps" hint="of trading fees to treasury (rest to LPs)"
          onApply={(v) => write(() => writeContract({ ...market, functionName: "setProtocolFeeShareBps", args: [BigInt(v)] }))} />
        <ParamRow label="Rapid-close fee" cur={String(bn(r(10)))} unit="bps" hint={`window ${bn(r(11))}s`}
          onApply={(v) => write(() => writeContract({ ...market, functionName: "setRapidCloseParams", args: [BigInt(v), bn(r(11))] }))} />
        <AddrRow label="Treasury address" cur={r(1) as string | undefined}
          onApply={(v) => write(() => writeContract({ ...market, functionName: "setTreasury", args: [v as `0x${string}`] }))} />
      </Section>

      {/* ── VIP TIERS ── */}
      <Section title="VIP tiers">
        <TierRows market={market} write={write} writeContract={writeContract} data={data} />
      </Section>

      {/* ── ORACLE ── */}
      <Section title="Oracle">
        <ParamRow label="Max deviation (pushed)" cur={String(bn(r(18)))} unit="bps"
          onApply={(v) => write(() => writeContract({ ...oracle, functionName: "setMaxDeviationBps", args: [BigInt(v)] }))} />
        <TwoRow label="Signed-price params" a={{ v: String(bn(r(19))), unit: "bps dev" }} b={{ v: String(bn(r(20))), unit: "s age" }}
          onApply={(a, b) => write(() => writeContract({ ...oracle, functionName: "setSignedPriceParams", args: [BigInt(a), BigInt(b)] }))} />
        <KeeperRow abi={adminOracleAbi} addr={ADDR.oracle} label="Oracle keeper" write={write} writeContract={writeContract} />
      </Section>

      {/* ── POOL ── */}
      <Section title="Liquidity pool">
        <ParamRow label="Reserve factor" cur={String(bn(r(16)))} unit="bps"
          onApply={(v) => write(() => writeContract({ ...pool, functionName: "setReserveFactorBps", args: [BigInt(v)] }))} />
        <ParamRow label="Withdraw cooldown" cur={String(bn(r(17)))} unit="sec"
          onApply={(v) => write(() => writeContract({ ...pool, functionName: "setWithdrawCooldown", args: [BigInt(v)] }))} />
      </Section>

      {/* ── ROUTER ── */}
      <Section title="Router">
        <TriRow label="Execution params"
          a={{ v: formatEther(bn(r(21))), unit: "KUB fee" }} b={{ v: String(bn(r(22))), unit: "s max age" }} c={{ v: String(bn(r(23))), unit: "s cancel" }}
          onApply={(a, b, c) => write(() => writeContract({ ...router, functionName: "setParams", args: [parseEther(a || "0"), BigInt(b), BigInt(c)] }))} />
        <KeeperRow abi={adminRouterAbi} addr={ADDR.router} label="Router keeper (relayer)" write={write} writeContract={writeContract} />
      </Section>

      {/* ── REFERRAL ── */}
      <Section title="Referral">
        <ParamRow label="Default rebate" cur={String(bn(r(24)))} unit="bps" hint="referrer earns"
          onApply={(v) => write(() => writeContract({ ...referral, functionName: "setDefaultRebateBps", args: [BigInt(v)] }))} />
        <ParamRow label="Referred discount" cur={String(bn(r(25)))} unit="bps" hint="referee saves"
          onApply={(v) => write(() => writeContract({ ...referral, functionName: "setReferredDiscountBps", args: [BigInt(v)] }))} />
      </Section>

      <p className="mt-6 text-center text-[11px] text-mutedDim">
        Every change is a transaction signed by the admin wallet. USD fields are entered in KUSDT; bps: 100 = 1%.
      </p>
    </main>
  );
}

// ─── building blocks ─────────────────────────────────────────────────────────

function Locked({ title, msg }: { title: string; msg: string }) {
  return (
    <main className="mx-auto mt-24 max-w-[420px] rounded-xl border border-line bg-panel p-8 text-center">
      <div className="mb-2 text-[24px]">🔒</div>
      <h1 className="text-[16px] font-semibold">{title}</h1>
      <p className="mt-2 text-[13px] text-muted">{msg}</p>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-3 overflow-hidden rounded-lg border border-line bg-panel">
      <h2 className="eyebrow border-b border-line bg-panel2 px-4 py-2">{title}</h2>
      <div className="flex flex-col gap-2 p-3">{children}</div>
    </section>
  );
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: "red" }) {
  return (
    <div className="rounded-md border border-line bg-bg px-3 py-2">
      <div className="eyebrow">{k}</div>
      <div className={`tnum mt-0.5 text-[15px] font-semibold ${tone === "red" ? "text-red" : ""}`}>{v}</div>
    </div>
  );
}

function Apply({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <button onClick={onClick} disabled={busy}
      className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40">
      {busy ? "…" : "Apply"}
    </button>
  );
}

function Inp({ v, set, ph, w = "w-28" }: { v: string; set: (s: string) => void; ph: string; w?: string }) {
  return (
    <input value={v} onChange={(e) => set(e.target.value)} placeholder={ph}
      className={`tnum ${w} rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] outline-none focus:border-accent/60`} />
  );
}

function useApply(fn: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  return { busy, run: async () => { setBusy(true); try { await fn(); } catch { /* toast in write */ } finally { setBusy(false); } } };
}

function ParamRow({ label, cur, unit, hint, onApply }: { label: string; cur: string; unit?: string; hint?: string; onApply: (v: string) => Promise<unknown> }) {
  const [v, setV] = useState("");
  const { busy, run } = useApply(() => onApply(v || cur));
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-bg px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        <div className="text-[11px] text-mutedDim">now <span className="tnum text-muted">{cur}</span> {unit}{hint ? ` · ${hint}` : ""}</div>
      </div>
      <Inp v={v} set={setV} ph={cur} />
      {unit && <span className="w-8 text-[11px] text-mutedDim">{unit}</span>}
      <Apply onClick={run} busy={busy} />
    </div>
  );
}

function AddrRow({ label, cur, onApply }: { label: string; cur?: string; onApply: (v: string) => Promise<unknown> }) {
  const [v, setV] = useState("");
  const { busy, run } = useApply(() => onApply(v));
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-bg px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        <div className="tnum text-[11px] text-mutedDim">{cur ? shortAddr(cur) : "—"}</div>
      </div>
      <Inp v={v} set={setV} ph="0x…" w="w-64" />
      <Apply onClick={run} busy={busy} />
    </div>
  );
}

function TwoRow({ label, a, b, onApply }: { label: string; a: { v: string; unit: string }; b: { v: string; unit: string }; onApply: (a: string, b: string) => Promise<unknown> }) {
  const [x, setX] = useState(""); const [y, setY] = useState("");
  const { busy, run } = useApply(() => onApply(x || a.v, y || b.v));
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-bg px-3 py-2">
      <div className="min-w-[140px] flex-1 text-[13px] font-medium">{label}</div>
      <Inp v={x} set={setX} ph={a.v} w="w-24" /><span className="text-[11px] text-mutedDim">{a.unit}</span>
      <Inp v={y} set={setY} ph={b.v} w="w-24" /><span className="text-[11px] text-mutedDim">{b.unit}</span>
      <Apply onClick={run} busy={busy} />
    </div>
  );
}

function TriRow({ label, a, b, c, onApply }: { label: string; a: { v: string; unit: string }; b: { v: string; unit: string }; c: { v: string; unit: string }; onApply: (a: string, b: string, c: string) => Promise<unknown> }) {
  const [x, setX] = useState(""); const [y, setY] = useState(""); const [z, setZ] = useState("");
  const { busy, run } = useApply(() => onApply(x || a.v, y || b.v, z || c.v));
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-bg px-3 py-2">
      <div className="min-w-[140px] flex-1 text-[13px] font-medium">{label}</div>
      {[[a, x, setX], [b, y, setY], [c, z, setZ]].map(([f, val, set], i) => (
        <span key={i} className="flex items-center gap-1">
          <Inp v={val as string} set={set as (s: string) => void} ph={(f as { v: string }).v} w="w-20" />
          <span className="text-[11px] text-mutedDim">{(f as { unit: string }).unit}</span>
        </span>
      ))}
      <Apply onClick={run} busy={busy} />
    </div>
  );
}

type WriteFn = ReturnType<typeof useKubWrite>["writeContract"];

function GlobalParamsForm({ cur, onApply }: { cur: Record<string, string>; onApply: (v: Record<string, string>) => Promise<unknown> }) {
  const fields: [string, string, string][] = [
    ["positionFeeBps", "Open/close fee", "bps"], ["maintenanceMarginBps", "Maintenance margin", "bps"],
    ["liquidationFeeUsd", "Liquidation fee", "USD"], ["maxProfitBps", "Max profit", "bps"],
    ["minCollateralUsd", "Min collateral", "USD"], ["maxPriceAge", "Max price age", "sec"],
  ];
  const [v, setV] = useState<Record<string, string>>({});
  const { busy, run } = useApply(() => onApply({ ...cur, ...v }));
  return (
    <div className="rounded-md border border-line bg-bg p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {fields.map(([key, label, unit]) => (
          <label key={key} className="flex items-center gap-2">
            <span className="flex-1 text-[12px]">{label} <span className="text-mutedDim">({unit})</span></span>
            <Inp v={v[key] ?? ""} set={(s) => setV((p) => ({ ...p, [key]: s }))} ph={cur[key]} w="w-24" />
          </label>
        ))}
      </div>
      <div className="mt-3 flex justify-end"><Apply onClick={run} busy={busy} /></div>
    </div>
  );
}

function MarketForm({ symbol, cur, onApply }: { symbol: string; cur: Record<string, string>; onApply: (v: Record<string, string>) => Promise<unknown> }) {
  const [v, setV] = useState<Record<string, string>>({});
  const { busy, run } = useApply(() => onApply({ ...cur, ...v }));
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-bg px-3 py-2">
      <div className="w-20 text-[13px] font-semibold">{symbol}-PERP</div>
      <span className="flex items-center gap-1"><Inp v={v.maxLeverageX ?? ""} set={(s) => setV((p) => ({ ...p, maxLeverageX: s }))} ph={cur.maxLeverageX} w="w-16" /><span className="text-[11px] text-mutedDim">x max</span></span>
      <span className="flex items-center gap-1"><Inp v={v.maxOiUsd ?? ""} set={(s) => setV((p) => ({ ...p, maxOiUsd: s }))} ph={cur.maxOiUsd} w="w-28" /><span className="text-[11px] text-mutedDim">OI cap $</span></span>
      <span className="flex items-center gap-1"><Inp v={v.borrowRateFactorBps ?? ""} set={(s) => setV((p) => ({ ...p, borrowRateFactorBps: s }))} ph={cur.borrowRateFactorBps} w="w-16" /><span className="text-[11px] text-mutedDim">borrow bps/h</span></span>
      <Apply onClick={run} busy={busy} />
    </div>
  );
}

function TierRows({ market, write, writeContract, data }: { market: { address: `0x${string}`; abi: typeof adminMarketAbi }; write: (c: () => Promise<`0x${string}`>) => Promise<unknown>; writeContract: WriteFn; data: ReturnType<typeof useReadContracts>["data"] }) {
  void data;
  return (
    <>
      {[1, 2, 3].map((tier) => (
        <TwoRow key={tier} label={`VIP ${tier}`}
          a={{ v: "—", unit: "discount bps" }} b={{ v: "—", unit: "volume $" }}
          onApply={async (disc, vol) => {
            if (disc && disc !== "—") await write(() => writeContract({ ...market, functionName: "setTierDiscount", args: [tier, BigInt(disc)] }));
            if (vol && vol !== "—") await write(() => writeContract({ ...market, functionName: "setVolumeThreshold", args: [tier, usdToToken(parseEther(vol))] }));
          }} />
      ))}
      <p className="text-[11px] text-mutedDim">Enter a discount (bps) and/or 14-day volume ($) per tier, then Apply.</p>
    </>
  );
}

function KeeperRow({ abi, addr, label, write, writeContract }: { abi: typeof adminOracleAbi | typeof adminRouterAbi; addr: `0x${string}`; label: string; write: (c: () => Promise<`0x${string}`>) => Promise<unknown>; writeContract: WriteFn }) {
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const act = async (allowed: boolean) => {
    if (!v) return;
    setBusy(true);
    try { await write(() => writeContract({ address: addr, abi, functionName: "setKeeper", args: [v as `0x${string}`, allowed] })); }
    finally { setBusy(false); }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-bg px-3 py-2">
      <div className="min-w-[140px] flex-1 text-[13px] font-medium">{label}</div>
      <Inp v={v} set={setV} ph="0x… wallet" w="w-64" />
      <button onClick={() => act(true)} disabled={busy} className="rounded-md bg-green px-3 py-1.5 text-[12px] font-semibold text-bg disabled:opacity-40">Authorize</button>
      <button onClick={() => act(false)} disabled={busy} className="rounded-md bg-red px-3 py-1.5 text-[12px] font-semibold text-bg disabled:opacity-40">Revoke</button>
    </div>
  );
}
