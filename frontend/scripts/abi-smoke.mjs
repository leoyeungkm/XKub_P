// Verifies every view call the frontend makes against the live local deployment.
import { createPublicClient, http, parseAbi, stringToHex, formatEther } from "viem";
import { readFileSync } from "fs";

const cfg = JSON.parse(readFileSync(new URL("../src/config/deployment.json", import.meta.url)));
const A = cfg.addresses;
const client = createPublicClient({ transport: http(cfg.rpcUrl) });
const b32 = (s) => stringToHex(s, { size: 32 });

const oracleAbi = parseAbi([
  "function peekPrice(bytes32 marketId) view returns (uint256 price, uint256 updatedAt)",
]);
const marketAbi = parseAbi([
  "function getPosition(address owner, bytes32 marketId, bool isLong) view returns ((uint256 sizeUsd, uint256 sizeTokens, uint256 collateralUsd, uint256 entryBorrowX18))",
  "function getPositionPnl(address owner, bytes32 marketId, bool isLong) view returns (int256)",
  "function getMarketState(bytes32 marketId) view returns (uint256 longSizeUsd, uint256 shortSizeUsd, uint256 cumBorrowLongX18, uint256 cumBorrowShortX18, uint256 lastAccrual)",
]);
const routerAbi = parseAbi([
  "function minExecutionFee() view returns (uint256)",
  "function requestsCount() view returns (uint256)",
  "function requests(uint256 id) view returns (address owner, bytes32 marketId, bool isLong, bool isIncrease, uint256 collateralTokens, uint256 sizeDeltaUsd, uint256 acceptablePrice, uint256 executionFee, uint64 createdAt, uint8 status)",
]);
const poolAbi = parseAbi([
  "function poolValueUsd() view returns (uint256)",
  "function sharePriceUsd() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
let fails = 0;
const check = async (label, fn) => {
  try {
    const v = await fn();
    console.log(`ok   ${label}: ${typeof v === "object" ? JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x) : v}`);
  } catch (e) {
    fails++;
    console.error(`FAIL ${label}: ${e.shortMessage ?? e.message}`);
  }
};

for (const m of cfg.markets) {
  await check(`oracle.peekPrice(${m.symbol})`, async () => {
    const [p] = await client.readContract({ address: A.XKubPriceOracle, abi: oracleAbi, functionName: "peekPrice", args: [b32(m.symbol)] });
    return `$${formatEther(p)}`;
  });
  await check(`market.getMarketState(${m.symbol})`, () =>
    client.readContract({ address: A.XKubPerpMarket, abi: marketAbi, functionName: "getMarketState", args: [b32(m.symbol)] }));
  await check(`market.getPosition(${m.symbol},long)`, () =>
    client.readContract({ address: A.XKubPerpMarket, abi: marketAbi, functionName: "getPosition", args: [DEPLOYER, b32(m.symbol), true] }));
  await check(`market.getPositionPnl(${m.symbol},long)`, () =>
    client.readContract({ address: A.XKubPerpMarket, abi: marketAbi, functionName: "getPositionPnl", args: [DEPLOYER, b32(m.symbol), true] }));
}
await check("router.minExecutionFee", () =>
  client.readContract({ address: A.XKubPerpRouter, abi: routerAbi, functionName: "minExecutionFee" }));
await check("router.requestsCount", () =>
  client.readContract({ address: A.XKubPerpRouter, abi: routerAbi, functionName: "requestsCount" }));
await check("router.requests(0)", () =>
  client.readContract({ address: A.XKubPerpRouter, abi: routerAbi, functionName: "requests", args: [0n] }));
await check("pool.poolValueUsd", () =>
  client.readContract({ address: A.XKubPerpPool, abi: poolAbi, functionName: "poolValueUsd" }));
await check("pool.sharePriceUsd", () =>
  client.readContract({ address: A.XKubPerpPool, abi: poolAbi, functionName: "sharePriceUsd" }));
await check("pool.balanceOf(deployer)", () =>
  client.readContract({ address: A.XKubPerpPool, abi: poolAbi, functionName: "balanceOf", args: [DEPLOYER] }));
await check("kusdt.balanceOf(deployer)", () =>
  client.readContract({ address: A.KUSDT, abi: erc20Abi, functionName: "balanceOf", args: [DEPLOYER] }));
await check("kusdt.allowance(deployer,router)", () =>
  client.readContract({ address: A.KUSDT, abi: erc20Abi, functionName: "allowance", args: [DEPLOYER, A.XKubPerpRouter] }));

console.log(fails ? `\n${fails} FAILURES` : "\nALL READS OK");
process.exit(fails ? 1 : 0);
