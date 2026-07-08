// Consolidated ABI for the /admin console — every onlyAdmin setter plus the
// reads needed to show current on-chain values. Kept separate from the trading
// ABIs so the admin surface is explicit and auditable.

export const adminMarketAbi = [
  // reads
  { type: "function", name: "admin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "positionFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maintenanceMarginBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "liquidationFeeUsd", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxProfitBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "minCollateralUsd", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxPriceAge", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "protocolFeeShareBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "rapidCloseFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "rapidCloseWindow", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "openPositionCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalOpenInterestUsd", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "marketConfig", stateMutability: "view", inputs: [{ type: "bytes32" }],
    outputs: [{ type: "bool", name: "listed" }, { type: "uint256", name: "maxLeverageX" }, { type: "uint256", name: "maxOiUsd" }, { type: "uint256", name: "borrowRateFactorBps" }] },
  { type: "function", name: "tierDiscountBps", stateMutability: "view", inputs: [{ type: "uint8" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "volumeThresholds", stateMutability: "view", inputs: [{ type: "uint8" }], outputs: [{ type: "uint256" }] },
  // writes
  { type: "function", name: "setPaused", stateMutability: "nonpayable", inputs: [{ type: "bool" }], outputs: [] },
  { type: "function", name: "setGlobalParams", stateMutability: "nonpayable",
    inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "configureMarket", stateMutability: "nonpayable",
    inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "setProtocolFeeShareBps", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "setTreasury", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
  { type: "function", name: "setRapidCloseParams", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "setTierDiscount", stateMutability: "nonpayable", inputs: [{ type: "uint8" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "setVolumeThreshold", stateMutability: "nonpayable", inputs: [{ type: "uint8" }, { type: "uint256" }], outputs: [] },
] as const;

export const adminOracleAbi = [
  { type: "function", name: "maxDeviationBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxSignedDeviationBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxSignedAge", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isKeeper", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "setMaxDeviationBps", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "setSignedPriceParams", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "setKeeper", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "bool" }], outputs: [] },
] as const;

export const adminPoolAbi = [
  { type: "function", name: "poolValueUsd", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "reserveFactorBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "withdrawCooldown", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "setReserveFactorBps", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "setWithdrawCooldown", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
] as const;

export const adminRouterAbi = [
  { type: "function", name: "minExecutionFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxExecuteAge", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "cancelDelay", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isKeeper", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "setParams", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "setKeeper", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "bool" }], outputs: [] },
] as const;

export const adminReferralAbi = [
  { type: "function", name: "defaultRebateBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "referredDiscountBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "setDefaultRebateBps", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "setReferredDiscountBps", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
] as const;

// Faucet /status shape (keeper endpoint)
export type KeeperStatus = {
  wallets: { address: string; roles: string[]; kub: string }[];
  faucetKusdt: string;
  gasPriceGwei: number;
  errors: number;
  prices: Record<string, number> | null;
};
