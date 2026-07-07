import { formatEther } from "viem";

export const fmtUsd = (x: bigint, dp = 2) =>
  Number(formatEther(x)).toLocaleString(undefined, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });

export const fmtPrice = (x: bigint) => {
  const n = Number(formatEther(x));
  return n >= 100
    ? n.toLocaleString(undefined, { maximumFractionDigits: 1 })
    : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
};

export const fmtNum = (n: number, dp = 2) =>
  n.toLocaleString(undefined, { maximumFractionDigits: dp });

export const shortAddr = (a: string) => a.slice(0, 6) + "…" + a.slice(-4);

export const errMsg = (e: unknown): string => {
  const err = e as { shortMessage?: string; message?: string };
  const m = err?.shortMessage ?? err?.message ?? String(e);
  return m.length > 140 ? m.slice(0, 140) + "…" : m;
};
