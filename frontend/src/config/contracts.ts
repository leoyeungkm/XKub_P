import { defineChain, keccak256, parseAbi, stringToHex, type Hex } from "viem";
import deployment from "./deployment.json";

export const CFG = deployment;

const MC3 = (CFG as { multicall3?: string }).multicall3;

// Our own read client routes through a same-origin proxy (frontend/src/app/api/rpc)
// to dodge the KUB RPC's flaky CORS preflight. Server render / build has no
// `window`, so it hits the RPC direct.
// NOTE: this is ONLY for our viem transport. The chain's rpcUrls below stays the
// real public RPC — that's what external wallets receive via wallet_addEthereumChain,
// and they can't reach a localhost proxy.
export const RPC_HTTP =
  typeof window !== "undefined" ? `${window.location.origin}/api/rpc` : CFG.rpcUrl;

export const chain = defineChain({
  id: CFG.chainId,
  name: CFG.chainName,
  nativeCurrency: { name: "KUB", symbol: "KUB", decimals: 18 },
  rpcUrls: { default: { http: [CFG.rpcUrl] } },
  // Batches useReadContracts into a single eth_call for far fewer round-trips.
  ...(MC3 ? { contracts: { multicall3: { address: MC3 as `0x${string}` } } } : {}),
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

// Bitkub-native charts, but quoted in USD via a TradingView spread symbol
// (BITKUB:xxxTHB / BITKUB:USDTTHB) so the axis matches the platform's USD
// marks/PnL while the data still comes from Bitkub.
export const TV_SYMBOLS: Record<string, string> = {
  BTC: "BITKUB:BTCTHB/BITKUB:USDTTHB",
  ETH: "BITKUB:ETHTHB/BITKUB:USDTTHB",
  KUB: "BITKUB:KUBTHB/BITKUB:USDTTHB",
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
  "function effectiveFeeBps(address trader) view returns (uint256)",
  "function feeTier(address trader) view returns (uint8)",
  "function earnedTier(address trader) view returns (uint8)",
  "function effectiveTier(address trader) view returns (uint8)",
  "function userVolumeUsd(address trader) view returns (uint256)",
  "function weightedVolumeUsd(address trader) view returns (uint256)",
  "function totalOpenInterestUsd() view returns (uint256)",
  "function maintenanceMarginBps() view returns (uint256)",
  "function rapidCloseFeeBps() view returns (uint256)",
  "function rapidCloseWindow() view returns (uint256)",
  "function minCollateralUsd() view returns (uint256)",
]);

const CFGX = CFG as unknown as {
  feeTiers?: { tier: number; name: string; discountBps: number; volumeUsd: number }[];
  basePositionFeeBps?: number;
  referredDiscountBps?: number;
};
export const FEE_TIERS = CFGX.feeTiers
  ?? [{ tier: 0, name: "Standard", discountBps: 0, volumeUsd: 0 }];
export const BASE_FEE_BPS = CFGX.basePositionFeeBps ?? 3;
export const REFERRED_DISCOUNT_BPS = CFGX.referredDiscountBps ?? 1000;

export const routerAbi = parseAbi([
  "function createIncreaseRequest(bytes32 marketId, bool isLong, uint256 collateralTokens, uint256 sizeDeltaUsd, uint256 acceptablePrice) payable returns (uint256)",
  "function createDecreaseRequest(bytes32 marketId, bool isLong, uint256 sizeDeltaUsd, uint256 acceptablePrice) payable returns (uint256)",
  "function cancelRequest(uint256 id)",
  "function minExecutionFee() view returns (uint256)",
  "function requestsCount() view returns (uint256)",
  "function requests(uint256 id) view returns (address owner, bytes32 marketId, bool isLong, bool isIncrease, uint256 collateralTokens, uint256 sizeDeltaUsd, uint256 acceptablePrice, uint256 executionFee, uint64 createdAt, uint8 status, bool fromBalance, bool payoutToBalance)",
  // One-click trading
  "function depositCollateral(uint256 tokens)",
  "function withdrawCollateral(uint256 tokens)",
  "function setAgent(address agent, bool allowed)",
  "function setupAccount(address agent, uint256 depositTokens, bytes32 referralCode) payable",
  "function isAgent(address owner, address agent) view returns (bool)",
  "function collateralBalance(address owner) view returns (uint256)",
  "function createIncreaseRequestFor(address owner, bytes32 marketId, bool isLong, uint256 collateralTokens, uint256 sizeDeltaUsd, uint256 acceptablePrice) payable returns (uint256)",
  "function createDecreaseRequestFor(address owner, bytes32 marketId, bool isLong, uint256 sizeDeltaUsd, uint256 acceptablePrice) payable returns (uint256)",
  // TP/SL triggers
  "function setTrigger(bytes32 marketId, bool isLong, uint256 tpPrice, uint256 slPrice) payable",
  "function setTriggerFor(address owner, bytes32 marketId, bool isLong, uint256 tpPrice, uint256 slPrice) payable",
  "function cancelTrigger(bytes32 marketId, bool isLong)",
  "function cancelTriggerFor(address owner, bytes32 marketId, bool isLong)",
  "function triggers(bytes32 key) view returns (uint256 tpPrice, uint256 slPrice, uint256 executionFee, bool active)",
  "function orderNonce(address owner) view returns (uint256)",
]);

export const RELAYER_URL = (CFG as { relayerUrl?: string }).relayerUrl ?? "";

// Testnet faucet (keeper endpoint): drip tKUB for gas + mint test KUSDT, once per
// address. Lets email/embedded-wallet users onboard without an external faucet.
export const FAUCET_URL = RELAYER_URL ? RELAYER_URL.replace(/\/order\/?$/, "/faucet") : "";
export type FaucetOutcome = {
  status: "sent" | "already" | "rate-limited" | "empty" | "error";
  kub: boolean;   // native gas was sent
  kusdt: boolean; // test collateral was sent
};
export async function requestFaucet(address: string): Promise<FaucetOutcome> {
  if (!FAUCET_URL) return { status: "error", kub: false, kusdt: false };
  try {
    const r = await fetch(FAUCET_URL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }), signal: AbortSignal.timeout(60000),
    });
    const j = await r.json().catch(() => ({} as { error?: string; kub?: boolean; kusdt?: boolean }));
    if (r.ok) return { status: "sent", kub: !!j.kub, kusdt: !!j.kusdt };
    // Distinguish "this address was already funded" (fine — carry on) from
    // "the IP is rate-limited" (this address got NOTHING; don't pretend it did).
    if (r.status === 429) return { status: j.error === "already claimed" ? "already" : "rate-limited", kub: false, kusdt: false };
    if (r.status === 503) return { status: "empty", kub: false, kusdt: false };
    return { status: "error", kub: false, kusdt: false };
  } catch { return { status: "error", kub: false, kusdt: false }; }
}

// KUB Chain has NO EIP-1559 — its blocks carry no baseFeePerGas. Wallets like
// OKX/MetaMask default to Type-2 (EIP-1559) txs, which this node silently drops
// (the wallet still returns a hash, so the dapp hangs waiting for a receipt that
// never comes). Force legacy (Type-0) with an explicit gasPrice on every write
// that goes through a user's injected wallet.
const GWEI = 1_000_000_000n;
const MIN_GAS_PRICE = 60n * GWEI; // floor — above the ~55 gwei testnet min
const MAX_GAS_PRICE = 70n * GWEI; // cap — keeps a full onboarding (approve + setup)
                                  // within the 0.05 KUB faucet drip

export async function kubTxOverrides(
  client: { getGasPrice: () => Promise<bigint> },
): Promise<{ type: "legacy"; gasPrice: bigint }> {
  let gasPrice: bigint;
  try {
    gasPrice = await client.getGasPrice();
  } catch {
    gasPrice = MAX_GAS_PRICE;
  }
  // Clamp into a sane band: enough to mine, not so high it strands a low balance.
  if (gasPrice < MIN_GAS_PRICE) gasPrice = MIN_GAS_PRICE;
  if (gasPrice > MAX_GAS_PRICE) gasPrice = MAX_GAS_PRICE;
  return { type: "legacy", gasPrice };
}

// keccak256(abi.encodePacked(owner, marketId, isLong)) — matches the router
export const triggerKey = (owner: `0x${string}`, symbol: string, isLong: boolean): Hex => {
  const packed = (owner.slice(2) + b32(symbol).slice(2) + (isLong ? "01" : "00")).toLowerCase();
  return keccak256(("0x" + packed) as Hex);
};

export const poolAbi = parseAbi([
  "function deposit(uint256 kusdtAmount) returns (uint256)",
  "function withdraw(uint256 shares) returns (uint256)",
  "function poolValueUsd() view returns (uint256)",
  "function sharePriceUsd() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function reserveFactorBps() view returns (uint256)",
  "function withdrawCooldown() view returns (uint256)",
  "function lastDepositAt(address) view returns (uint256)",
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

export const referralEventsAbi = parseAbi([
  "event RebateAccrued(address indexed referrer, address indexed trader, uint256 usd)",
  "event Referred(address indexed trader, bytes32 indexed code, address indexed referrer)",
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
