"use client";

// Aggregates a trader's account: balances, open positions, unrealized PnL,
// and (from event logs) realized PnL + trade/funding history.
import { useQuery } from "@tanstack/react-query";
import { useAccount, usePublicClient, useReadContract, useReadContracts } from "wagmi";
import {
  ADDR, E18, MARKETS, b32, parseB32, erc20Abi, marketAbi, oracleAbi, poolAbi,
  routerAbi, marketEventsAbi, routerEventsAbi, tokenToUsd,
} from "@/config/contracts";

const COMBOS = MARKETS.flatMap((m) => [
  { symbol: m.symbol, isLong: true },
  { symbol: m.symbol, isLong: false },
]);

export type PositionRow = {
  symbol: string; isLong: boolean; sizeUsd: bigint; sizeTokens: bigint;
  collateralUsd: bigint; entry: bigint; mark: bigint; pnl: bigint;
};

export function usePositions() {
  const { address } = useAccount();
  const { data } = useReadContracts({
    contracts: COMBOS.flatMap((c) => [
      { address: ADDR.market, abi: marketAbi, functionName: "getPosition", args: [address!, b32(c.symbol), c.isLong] },
      { address: ADDR.market, abi: marketAbi, functionName: "getPositionPnl", args: [address!, b32(c.symbol), c.isLong] },
      { address: ADDR.oracle, abi: oracleAbi, functionName: "peekPrice", args: [b32(c.symbol)] },
    ]) as never[],
    query: { enabled: !!address, refetchInterval: 6000 },
  });

  const rows: PositionRow[] = COMBOS.map((c, i) => {
    const pos = data?.[i * 3]?.result as { sizeUsd: bigint; sizeTokens: bigint; collateralUsd: bigint } | undefined;
    const pnl = (data?.[i * 3 + 1]?.result as bigint | undefined) ?? 0n;
    const peek = data?.[i * 3 + 2]?.result as readonly [bigint, bigint] | undefined;
    if (!pos || pos.sizeUsd === 0n) return null;
    return {
      symbol: c.symbol, isLong: c.isLong, sizeUsd: pos.sizeUsd, sizeTokens: pos.sizeTokens,
      collateralUsd: pos.collateralUsd,
      entry: (pos.sizeUsd * E18) / pos.sizeTokens, mark: peek?.[0] ?? 0n, pnl,
    };
  }).filter(Boolean) as PositionRow[];

  return rows;
}

export function useAccountSummary() {
  const { address } = useAccount();
  const positions = usePositions();

  const { data: walletBal } = useReadContract({
    address: ADDR.kusdt, abi: erc20Abi, functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 8000 },
  });
  const { data: tradingBal } = useReadContract({
    address: ADDR.router, abi: routerAbi, functionName: "collateralBalance",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 8000 },
  });

  const posCollateral = positions.reduce((s, p) => s + p.collateralUsd, 0n);
  const unrealized = positions.reduce((s, p) => s + p.pnl, 0n);
  const trading = tradingBal !== undefined ? tokenToUsd(tradingBal) : 0n;
  const wallet = walletBal !== undefined ? tokenToUsd(walletBal) : 0n;

  // Account value = free trading balance + margin locked in positions + unrealized PnL
  const accountValue = trading + posCollateral + unrealized;

  return {
    address,
    walletUsd: wallet,
    tradingUsd: trading,        // available (withdrawable) trading balance
    positionMarginUsd: posCollateral,
    unrealizedUsd: unrealized,
    accountValueUsd: accountValue,
    positions,
  };
}

export type HistoryItem = {
  kind: "open" | "close" | "liquidation" | "deposit" | "withdraw";
  symbol?: string; isLong?: boolean; sizeUsd?: bigint; pnlUsd?: bigint;
  amountUsd?: bigint; price?: bigint; block: bigint; txHash: string;
};

export function useHistory() {
  const { address } = useAccount();
  const client = usePublicClient();

  return useQuery({
    queryKey: ["portfolioHistory", address],
    enabled: !!address && !!client,
    refetchInterval: 15000,
    queryFn: async (): Promise<HistoryItem[]> => {
      const owner = address!;
      const items: HistoryItem[] = [];
      const pull = async (addr: `0x${string}`, abi: readonly unknown[], name: string, extra: Record<string, unknown>) => {
        try {
          return await client!.getLogs({
            address: addr,
            event: (abi as { name?: string }[]).find((e) => e.name === name) as never,
            args: { owner, ...extra } as never,
            fromBlock: 0n, toBlock: "latest",
          });
        } catch { return []; }
      };

      const [inc, dec, liq, dep, wd] = await Promise.all([
        pull(ADDR.market, marketEventsAbi, "PositionIncreased", {}),
        pull(ADDR.market, marketEventsAbi, "PositionDecreased", {}),
        pull(ADDR.market, marketEventsAbi, "PositionLiquidated", {}),
        pull(ADDR.router, routerEventsAbi, "CollateralDeposited", {}),
        pull(ADDR.router, routerEventsAbi, "CollateralWithdrawn", {}),
      ]);

      for (const l of inc as never[]) {
        const a = (l as { args: { marketId: string; isLong: boolean; sizeDeltaUsd: bigint; price: bigint }; blockNumber: bigint; transactionHash: string });
        if (a.args.sizeDeltaUsd === 0n) continue;
        items.push({ kind: "open", symbol: parseB32(a.args.marketId), isLong: a.args.isLong, sizeUsd: a.args.sizeDeltaUsd, price: a.args.price, block: a.blockNumber, txHash: a.transactionHash });
      }
      for (const l of dec as never[]) {
        const a = (l as { args: { marketId: string; isLong: boolean; sizeDeltaUsd: bigint; pnlUsd: bigint; price: bigint }; blockNumber: bigint; transactionHash: string });
        items.push({ kind: "close", symbol: parseB32(a.args.marketId), isLong: a.args.isLong, sizeUsd: a.args.sizeDeltaUsd, pnlUsd: a.args.pnlUsd, price: a.args.price, block: a.blockNumber, txHash: a.transactionHash });
      }
      for (const l of liq as never[]) {
        const a = (l as { args: { marketId: string; isLong: boolean; price: bigint }; blockNumber: bigint; transactionHash: string });
        items.push({ kind: "liquidation", symbol: parseB32(a.args.marketId), isLong: a.args.isLong, price: a.args.price, block: a.blockNumber, txHash: a.transactionHash });
      }
      for (const l of dep as never[]) {
        const a = (l as { args: { tokens: bigint }; blockNumber: bigint; transactionHash: string });
        items.push({ kind: "deposit", amountUsd: tokenToUsd(a.args.tokens), block: a.blockNumber, txHash: a.transactionHash });
      }
      for (const l of wd as never[]) {
        const a = (l as { args: { tokens: bigint }; blockNumber: bigint; transactionHash: string });
        items.push({ kind: "withdraw", amountUsd: tokenToUsd(a.args.tokens), block: a.blockNumber, txHash: a.transactionHash });
      }
      items.sort((x, y) => Number(y.block - x.block));
      return items;
    },
  });
}

/** Realized PnL summed from close events. */
export function realizedPnl(history: HistoryItem[] | undefined): bigint {
  if (!history) return 0n;
  return history.filter((h) => h.kind === "close").reduce((s, h) => s + (h.pnlUsd ?? 0n), 0n);
}
