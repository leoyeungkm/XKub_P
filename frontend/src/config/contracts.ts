import { defineChain, parseAbi, stringToHex, type Hex } from "viem";
import deployment from "./deployment.json";

export const CFG = deployment;

export const chain = defineChain({
  id: CFG.chainId,
  name: CFG.chainName,
  nativeCurrency: { name: "KUB", symbol: "KUB", decimals: 18 },
  rpcUrls: { default: { http: [CFG.rpcUrl] } },
  ...(CFG.explorer
    ? { blockExplorers: { default: { name: "KubScan", url: CFG.explorer } } }
    : {}),
});

export const ADDR = {
  kusdt: CFG.addresses.KUSDT as `0x${string}`,
  oracle: CFG.addresses.XKubPriceOracle as `0x${string}`,
  market: CFG.addresses.XKubPerpMarket as `0x${string}`,
  router: CFG.addresses.XKubPerpRouter as `0x${string}`,
  pool: CFG.addresses.XKubPerpPool as `0x${string}`,
  referral: (CFG.addresses as Record<string, string>).XKubReferral as `0x${string}` | undefined,
} as const;

export const MARKETS = CFG.markets as { symbol: string; maxLeverageX: number }[];

export const E18 = 10n ** 18n;
// KUSDT native units per 1e18 USD
export const SCALER = 10n ** BigInt(18 - CFG.kusdtDecimals);
export const usdToToken = (usd: bigint) => usd / SCALER;
export const tokenToUsd = (tokens: bigint) => tokens * SCALER;

export const b32 = (s: string): Hex => stringToHex(s, { size: 32 });
export const parseB32 = (hex: string): string => {
  const bytes = hex.slice(2).match(/.{2}/g) ?? [];
  let out = "";
  for (const b of bytes) {
    const c = parseInt(b, 16);
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out;
};

export const TV_SYMBOLS: Record<string, string> = {
  BTC: "BINANCE:BTCUSDT",
  ETH: "BINANCE:ETHUSDT",
  KUB: "BITKUB:KUBTHB",
};

// ─── ABIs ────────────────────────────────────────────────────────────────────

export const oracleAbi = parseAbi([
  "function peekPrice(bytes32 marketId) view returns (uint256 price, uint256 updatedAt)",
]);

export const marketAbi = parseAbi([
  "function getPosition(address owner, bytes32 marketId, bool isLong) view returns ((uint256 sizeUsd, uint256 sizeTokens, uint256 collateralUsd, uint256 entryBorrowX18))",
  "function getPositionPnl(address owner, bytes32 marketId, bool isLong) view returns (int256)",
  "function getMarketState(bytes32 marketId) view returns (uint256 longSizeUsd, uint256 shortSizeUsd, uint256 cumBorrowLongX18, uint256 cumBorrowShortX18, uint256 lastAccrual)",
  "function positionFeeBps() view returns (uint256)",
  "function marketConfig(bytes32 marketId) view returns (bool listed, uint256 maxLeverageX, uint256 maxOiUsd, uint256 borrowRateFactorBps)",
]);

export const routerAbi = parseAbi([
  "function createIncreaseRequest(bytes32 marketId, bool isLong, uint256 collateralTokens, uint256 sizeDeltaUsd, uint256 acceptablePrice) payable returns (uint256)",
  "function createDecreaseRequest(bytes32 marketId, bool isLong, uint256 sizeDeltaUsd, uint256 acceptablePrice) payable returns (uint256)",
  "function cancelRequest(uint256 id)",
  "function minExecutionFee() view returns (uint256)",
  "function requestsCount() view returns (uint256)",
  "function requests(uint256 id) view returns (address owner, bytes32 marketId, bool isLong, bool isIncrease, uint256 collateralTokens, uint256 sizeDeltaUsd, uint256 acceptablePrice, uint256 executionFee, uint64 createdAt, uint8 status, bool fromBalance)",
  // One-click trading
  "function depositCollateral(uint256 tokens)",
  "function withdrawCollateral(uint256 tokens)",
  "function setAgent(address agent, bool allowed)",
  "function isAgent(address owner, address agent) view returns (bool)",
  "function collateralBalance(address owner) view returns (uint256)",
  "function createIncreaseRequestFor(address owner, bytes32 marketId, bool isLong, uint256 collateralTokens, uint256 sizeDeltaUsd, uint256 acceptablePrice) payable returns (uint256)",
  "function createDecreaseRequestFor(address owner, bytes32 marketId, bool isLong, uint256 sizeDeltaUsd, uint256 acceptablePrice) payable returns (uint256)",
]);

export const poolAbi = parseAbi([
  "function deposit(uint256 kusdtAmount) returns (uint256)",
  "function withdraw(uint256 shares) returns (uint256)",
  "function poolValueUsd() view returns (uint256)",
  "function sharePriceUsd() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
]);

// Event ABIs for portfolio history (getLogs)
export const marketEventsAbi = parseAbi([
  "event PositionIncreased(address indexed owner, bytes32 indexed marketId, bool isLong, uint256 collateralDeltaUsd, uint256 sizeDeltaUsd, uint256 price, uint256 feeUsd)",
  "event PositionDecreased(address indexed owner, bytes32 indexed marketId, bool isLong, uint256 sizeDeltaUsd, uint256 price, int256 pnlUsd, uint256 payoutUsd, uint256 feeUsd)",
  "event PositionLiquidated(address indexed owner, bytes32 indexed marketId, bool isLong, address indexed liquidator, uint256 price, uint256 keeperRewardUsd, uint256 traderRefundUsd, uint256 toPoolUsd)",
]);

export const routerEventsAbi = parseAbi([
  "event CollateralDeposited(address indexed owner, uint256 tokens)",
  "event CollateralWithdrawn(address indexed owner, uint256 tokens)",
]);

export const referralAbi = parseAbi([
  "function registerCode(bytes32 code)",
  "function setReferrer(bytes32 code)",
  "function claim() returns (uint256)",
  "function ownerCode(address owner) view returns (bytes32)",
  "function codeOwner(bytes32 code) view returns (address)",
  "function referredBy(address trader) view returns (bytes32)",
  "function claimableUsd(address referrer) view returns (uint256)",
  "function defaultRebateBps() view returns (uint256)",
  "function bound(address trader) view returns (bool)",
]);
