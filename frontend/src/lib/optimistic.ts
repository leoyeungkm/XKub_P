"use client";

// Optimistic open positions: the instant a user submits an open, we show a
// "confirming" row so the UI feels immediate. It's replaced by the real position
// as soon as the tx mines (or dropped if the order fails / after a timeout). This
// is display-only — it never feeds account value / PnL, which stay on-chain-true.
import { useSyncExternalStore } from "react";

export type PendingOpen = {
  symbol: string;
  isLong: boolean;
  sizeUsd: bigint;
  collateralUsd: bigint;
  entry: bigint; // price at submit (display estimate)
};

let pending: PendingOpen[] = [];
const subs = new Set<() => void>();
const EMPTY: PendingOpen[] = [];
const notify = () => subs.forEach((f) => f());
const sameKey = (a: { symbol: string; isLong: boolean }, s: string, l: boolean) =>
  a.symbol === s && a.isLong === l;

export function addPendingOpen(p: PendingOpen) {
  pending = [...pending.filter((x) => !sameKey(x, p.symbol, p.isLong)), p];
  notify();
  // Safety expiry: never let a stuck placeholder linger.
  setTimeout(() => removePendingOpen(p.symbol, p.isLong), 25000);
}

export function removePendingOpen(symbol: string, isLong: boolean) {
  const next = pending.filter((x) => !sameKey(x, symbol, isLong));
  if (next.length !== pending.length) { pending = next; notify(); }
}

export function usePendingOpens(): PendingOpen[] {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => subs.delete(cb); },
    () => pending,
    () => EMPTY,
  );
}
