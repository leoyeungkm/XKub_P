"use client";

// Live CEX prices for the UI ticker, served by the keeper's relayer at /prices.
// This keeps the displayed price moving even when the keeper isn't posting
// on-chain (idle / conditional posting). Falls back to the on-chain oracle
// price when the relayer is unavailable.
import { useQuery } from "@tanstack/react-query";
import { parseEther } from "viem";
import { RELAYER_URL } from "@/config/contracts";

const PRICES_URL = RELAYER_URL ? RELAYER_URL.replace(/\/order\/?$/, "/prices") : "";

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

/** Live display price (USD 1e18) for a symbol; falls back to the oracle price. */
export function useDisplayPrice(symbol: string, oraclePrice: bigint): bigint {
  const { data } = useCexPrices();
  const cex = data?.[symbol];
  if (cex && cex > 0) {
    try { return parseEther(cex.toFixed(6)); } catch { /* ignore */ }
  }
  return oraclePrice;
}
