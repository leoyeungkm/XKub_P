"use client";

// Custom candlestick chart (TradingView Lightweight Charts) so we can overlay the
// user's own markers — entry price, TP/SL and open orders — each with a show/hide
// toggle. Candles: BTC/ETH from Binance, KUB from Bitkub (THB→USD). The last
// candle tracks the live price.
import { createChart, ColorType, LineStyle, type IChartApi, type ISeriesApi, type IPriceLine, type CandlestickData, type UTCTimestamp } from "lightweight-charts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { formatEther } from "viem";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import { ADDR, parseB32, routerAbi, triggerKey } from "@/config/contracts";
import { useIsLight } from "@/lib/theme";
import { usePositions } from "@/lib/portfolio";
import { useLivePrices } from "@/lib/cexPrice";

type Toggles = { entry: boolean; tpsl: boolean; orders: boolean };
const TOGGLE_KEY = "xkub.chart.toggles";

async function fetchKlines(symbol: string): Promise<CandlestickData[]> {
  const num = (x: unknown) => Number(x);
  if (symbol === "KUB") {
    const to = Math.floor(Date.now() / 1000);
    const from = to - 200 * 15 * 60;
    const j = (u: string) => fetch(u, { signal: AbortSignal.timeout(9000) }).then((r) => r.json());
    const [kub, usdt] = await Promise.all([
      j(`https://api.bitkub.com/tradingview/history?symbol=KUB_THB&resolution=15&from=${from}&to=${to}`),
      j(`https://api.bitkub.com/tradingview/history?symbol=USDT_THB&resolution=15&from=${from}&to=${to}`),
    ]);
    if (kub?.s !== "ok" || !Array.isArray(kub.t)) return [];
    const uByT = new Map<number, number>();
    if (usdt?.s === "ok") usdt.t.forEach((t: number, i: number) => uByT.set(t, num(usdt.c[i])));
    const lastU = usdt?.s === "ok" ? num(usdt.c[usdt.c.length - 1]) : 33;
    return kub.t.map((t: number, i: number) => {
      const u = uByT.get(t) || lastU || 33;
      return { time: t as UTCTimestamp, open: num(kub.o[i]) / u, high: num(kub.h[i]) / u, low: num(kub.l[i]) / u, close: num(kub.c[i]) / u };
    });
  }
  const data = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=15m&limit=200`, { signal: AbortSignal.timeout(9000) }).then((r) => r.json());
  if (!Array.isArray(data)) return [];
  return data.map((k: unknown[]) => ({
    time: Math.floor(num(k[0]) / 1000) as UTCTimestamp,
    open: num(k[1]), high: num(k[2]), low: num(k[3]), close: num(k[4]),
  }));
}

export default function Chart({ symbol, height = 460 }: { symbol: string; height?: number }) {
  const light = useIsLight();
  const { address } = useAccount();
  const client = usePublicClient();
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const lastRef = useRef<CandlestickData | null>(null);

  const [toggles, setToggles] = useState<Toggles>({ entry: true, tpsl: true, orders: true });
  useEffect(() => {
    try { const s = localStorage.getItem(TOGGLE_KEY); if (s) setToggles(JSON.parse(s)); } catch { /* ignore */ }
  }, []);
  const flip = (k: keyof Toggles) => setToggles((t) => {
    const next = { ...t, [k]: !t[k] };
    try { localStorage.setItem(TOGGLE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    return next;
  });

  const { data: klines } = useQuery({
    queryKey: ["klines", symbol],
    queryFn: () => fetchKlines(symbol),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // ── overlay data ──────────────────────────────────────────────────────────
  const positions = usePositions().filter((p) => p.symbol === symbol);
  const { data: trigData } = useReadContracts({
    contracts: address ? [true, false].map((isLong) => ({
      address: ADDR.router, abi: routerAbi, functionName: "triggers",
      args: [triggerKey(address, symbol, isLong)],
    })) as never[] : [],
    query: { enabled: !!address, refetchInterval: 10_000 },
  });
  const { data: orders } = useQuery({
    queryKey: ["chartOrders", symbol, address],
    enabled: !!address && !!client,
    refetchInterval: 8_000,
    queryFn: async (): Promise<number[]> => {
      const count = await client!.readContract({ address: ADDR.router, abi: routerAbi, functionName: "requestsCount" }) as bigint;
      const out: number[] = [];
      const start = count > 30n ? count - 30n : 0n;
      for (let i = count - 1n; i >= start; i--) {
        const r = await client!.readContract({ address: ADDR.router, abi: routerAbi, functionName: "requests", args: [i] }) as readonly unknown[];
        if ((r[0] as string).toLowerCase() === address!.toLowerCase() && r[9] === 0 && parseB32(r[1] as string) === symbol) {
          const px = Number(formatEther(r[6] as bigint));
          if (px > 0) out.push(px);
        }
        if (i === 0n) break;
      }
      return out;
    },
  });

  const live = useLivePrices()[symbol];

  // ── create chart (once per symbol/theme) ────────────────────────────────────
  useEffect(() => {
    if (!wrapRef.current) return;
    const fg = light ? "#4b5563" : "#9aa4b2";
    const grid = light ? "#eef1f5" : "#1c2230";
    const chart = createChart(wrapRef.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: fg, fontSize: 11 },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      rightPriceScale: { borderColor: grid },
      timeScale: { borderColor: grid, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
      autoSize: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: "#16b979", downColor: "#ef4b64", borderVisible: false,
      wickUpColor: "#16b979", wickDownColor: "#ef4b64",
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; linesRef.current = []; };
  }, [light]);

  // ── set candle data ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!seriesRef.current || !klines?.length) return;
    seriesRef.current.setData(klines);
    lastRef.current = klines[klines.length - 1];
    chartRef.current?.timeScale().fitContent();
  }, [klines]);

  // ── live-update the last candle from the ticker ─────────────────────────────
  useEffect(() => {
    if (!seriesRef.current || !lastRef.current || !(live > 0)) return;
    const c = lastRef.current;
    const upd: CandlestickData = { ...c, close: live, high: Math.max(c.high, live), low: Math.min(c.low, live) };
    seriesRef.current.update(upd);
  }, [live]);

  // ── redraw overlay price lines on data / toggle change ──────────────────────
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const l of linesRef.current) series.removePriceLine(l);
    linesRef.current = [];
    const add = (price: number, color: string, title: string, style: LineStyle = LineStyle.Solid) => {
      if (!(price > 0)) return;
      linesRef.current.push(series.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    };
    if (toggles.entry) {
      for (const p of positions) add(Number(formatEther(p.entry)), p.isLong ? "#16b979" : "#ef4b64", `Entry ${p.isLong ? "L" : "S"}`);
    }
    if (toggles.tpsl && trigData) {
      for (const t of trigData) {
        const r = t?.result as readonly [bigint, bigint, bigint, boolean] | undefined;
        if (!r || !r[3]) continue;
        add(Number(formatEther(r[0])), "#16b979", "TP", LineStyle.Dashed);
        add(Number(formatEther(r[1])), "#ef4b64", "SL", LineStyle.Dashed);
      }
    }
    if (toggles.orders && orders) {
      for (const px of orders) add(px, "#4f7cff", "Order", LineStyle.Dotted);
    }
  }, [positions, trigData, orders, toggles, klines]);

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-line bg-panel" style={{ height }}>
      <div className="flex items-center gap-1 border-b border-line px-2.5 py-1.5">
        <Toggle on={toggles.entry} onClick={() => flip("entry")} dot="#16b979">進場價</Toggle>
        <Toggle on={toggles.tpsl} onClick={() => flip("tpsl")} dot="#ef4b64">TP/SL</Toggle>
        <Toggle on={toggles.orders} onClick={() => flip("orders")} dot="#4f7cff">掛單</Toggle>
        <span className="ml-auto text-[11px] text-mutedDim">{symbol}-PERP · 15m</span>
      </div>
      <div ref={wrapRef} className="min-h-0 flex-1" />
    </div>
  );
}

function Toggle({ on, onClick, dot, children }: { on: boolean; onClick: () => void; dot: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded px-2 py-1 text-[11px] transition-colors ${on ? "bg-panel2 text-fg" : "text-mutedDim hover:text-muted"}`}
    >
      <span className="h-2 w-2 rounded-full" style={{ background: on ? dot : "transparent", border: `1px solid ${dot}` }} />
      {children}
    </button>
  );
}
