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

// ─── Shared Binance WebSocket (BTC/ETH real-time) ─────────────────────────────
const WS_SYMBOLS: Record<string, string> = { BTCUSDT: "BTC", ETHUSDT: "ETH" };
let ws: WebSocket | null = null;
let started = false;
let wsPrices: Record<string, number> = {};
const subs = new Set<() => void>();
const EMPTY: Record<string, number> = {};

function connect() {
  if (typeof window === "undefined") return;
  try {
    ws = new WebSocket(
      "wss://stream.binance.com:9443/stream?streams=btcusdt@miniTicker/ethusdt@miniTicker",
    );
    ws.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data)?.data;
        const sym = d && WS_SYMBOLS[d.s];
        const px = d && Number(d.c); // miniTicker close = last price
        if (sym && px > 0 && px !== wsPrices[sym]) {
          wsPrices = { ...wsPrices, [sym]: px };
          subs.forEach((f) => f());
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

/** Real-time BTC/ETH from Binance WS (empty until the first tick arrives). */
export function useBinanceLive(): Record<string, number> {
  return useSyncExternalStore(
    (cb) => { ensureWs(); subs.add(cb); return () => subs.delete(cb); },
    () => wsPrices,
    () => EMPTY,
  );
}

/** Merged live prices: WS overrides REST for BTC/ETH; KUB comes from the relayer. */
export function useLivePrices(): Record<string, number> {
  const { data: rest } = useCexPrices();
  const live = useBinanceLive();
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
