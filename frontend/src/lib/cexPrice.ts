"use client";

// Live prices for the UI ticker, mark & PnL.
//   • BTC / ETH  → a single shared Binance WebSocket (sub-second, real-time)
//   • KUB        → the keeper relayer /prices (Bitkub, needs THB→USD conversion)
// When the WS is down/blocked we fall back to the relayer's REST prices, so the
// UI never goes priceless.
import { useQuery } from "@tanstack/react-query";
import { parseEther } from "viem";
import { useSyncExternalStore } from "react";
import { RELAYER_URL } from "@/config/contracts";

const PRICES_URL = RELAYER_URL ? RELAYER_URL.replace(/\/order\/?$/, "/prices") : "";

// ─── Relayer REST prices (KUB + fallback) ─────────────────────────────────────
export function useCexPrices() {
  return useQuery({
    queryKey: ["cexPrices"],
    enabled: PRICES_URL.length > 0,
    refetchInterval: 4000,
    staleTime: 3000,
    queryFn: async (): Promise<Record<string, number>> => {
      const r = await fetch(PRICES_URL, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error("prices");
      return r.json();
    },
  });
}

// ─── Shared Bitkub WebSocket (BTC/ETH real-time, THB→USD) ─────────────────────
// One connection subscribes to all three tickers; Bitkub quotes in THB, so we
// divide BTC_THB / ETH_THB by USDT_THB to get USD.
const WS_URL =
  "wss://api.bitkub.com/websocket-api/market.ticker.thb_btc,market.ticker.thb_eth,market.ticker.thb_usdt";
const STREAM_SYM: Record<string, string> = {
  "market.ticker.thb_btc": "BTC",
  "market.ticker.thb_eth": "ETH",
  "market.ticker.thb_usdt": "USDT",
};
let ws: WebSocket | null = null;
let started = false;
let thb: Record<string, number> = {};      // BTC/ETH/USDT last, in THB
let wsPrices: Record<string, number> = {}; // BTC/ETH in USD
const subs = new Set<() => void>();
const EMPTY: Record<string, number> = {};

function recompute() {
  const usdt = thb.USDT;
  if (!(usdt > 0)) return; // no USD conversion yet
  const next: Record<string, number> = {};
  if (thb.BTC > 0) next.BTC = thb.BTC / usdt;
  if (thb.ETH > 0) next.ETH = thb.ETH / usdt;
  if (next.BTC !== wsPrices.BTC || next.ETH !== wsPrices.ETH) {
    wsPrices = next;
    subs.forEach((f) => f());
  }
}

function connect() {
  if (typeof window === "undefined") return;
  try {
    ws = new WebSocket(WS_URL);
    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        const sym = d?.stream && STREAM_SYM[d.stream];
        const last = Number(d?.last);
        if (sym && last > 0 && thb[sym] !== last) {
          thb = { ...thb, [sym]: last };
          recompute();
        }
      } catch { /* ignore malformed frame */ }
    };
    ws.onclose = () => { ws = null; setTimeout(connect, 3000); };
    ws.onerror = () => { try { ws?.close(); } catch { /* noop */ } };
  } catch { setTimeout(connect, 3000); }
}

function ensureWs() {
  if (started || typeof window === "undefined") return;
  started = true;
  connect();
}

/** Real-time BTC/ETH (USD) from the Bitkub WS (empty until the first ticks arrive). */
export function useCexWs(): Record<string, number> {
  return useSyncExternalStore(
    (cb) => { ensureWs(); subs.add(cb); return () => subs.delete(cb); },
    () => wsPrices,
    () => EMPTY,
  );
}

/** Merged live prices: WS overrides REST for BTC/ETH; KUB comes from the relayer. */
export function useLivePrices(): Record<string, number> {
  const { data: rest } = useCexPrices();
  const live = useCexWs();
  return { ...(rest ?? EMPTY), ...live };
}

/** Live display price (USD 1e18) for a symbol; falls back to the oracle price. */
export function useDisplayPrice(symbol: string, oraclePrice: bigint): bigint {
  const prices = useLivePrices();
  const cex = prices[symbol];
  if (cex && cex > 0) {
    try { return parseEther(cex.toFixed(6)); } catch { /* ignore */ }
  }
  return oraclePrice;
}
