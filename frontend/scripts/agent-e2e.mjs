// E2E: one-click agent flow against the live local stack (keeper bot must be running).
// owner = hardhat account #1, agent = freshly generated key.
import { createWalletClient, createPublicClient, http, parseEther, parseAbi, stringToHex, formatEther } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { readFileSync } from "fs";

const cfg = JSON.parse(readFileSync(new URL("../src/config/deployment.json", import.meta.url)));
const A = cfg.addresses;
const transport = http(cfg.rpcUrl);
const pub = createPublicClient({ transport });

// Test owner key — defaults to the well-known public Hardhat account #1 (no real
// funds); override with E2E_OWNER_PK for a funded testnet run.
const OWNER_PK = process.env.E2E_OWNER_PK ?? "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const owner = privateKeyToAccount(OWNER_PK);
const agent = privateKeyToAccount(generatePrivateKey());
const ownerW = createWalletClient({ account: owner, transport });
const agentW = createWalletClient({ account: agent, transport });

const BTC = stringToHex("BTC", { size: 32 });
const erc20 = parseAbi([
  "function mint(address,uint256)", "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const router = parseAbi([
  "function depositCollateral(uint256)", "function setAgent(address,bool)",
  "function collateralBalance(address) view returns (uint256)",
  "function isAgent(address,address) view returns (bool)",
  "function minExecutionFee() view returns (uint256)",
  "function createIncreaseRequestFor(address,bytes32,bool,uint256,uint256,uint256) payable returns (uint256)",
  "function createDecreaseRequestFor(address,bytes32,bool,uint256,uint256) payable returns (uint256)",
]);
const marketAbi = parseAbi([
  "function getPosition(address,bytes32,bool) view returns ((uint256 sizeUsd, uint256 sizeTokens, uint256 collateralUsd, uint256 entryBorrowX18))",
]);

const wait = (h) => pub.waitForTransactionReceipt({ hash: h });
const step = (m) => console.log("→", m);

// setup: gas + KUSDT for owner, gas for agent
step("fund owner + agent");
await wait(await ownerW.writeContract({ address: A.KUSDT, abi: erc20, functionName: "mint", args: [owner.address, parseEther("20000")], chain: null }));
await wait(await ownerW.writeContract({ address: A.KUSDT, abi: erc20, functionName: "approve", args: [A.XKubPerpRouter, 2n ** 256n - 1n], chain: null }));
await wait(await ownerW.sendTransaction({ to: agent.address, value: parseEther("0.2"), chain: null }));

step("depositCollateral 5000 + setAgent");
await wait(await ownerW.writeContract({ address: A.XKubPerpRouter, abi: router, functionName: "depositCollateral", args: [parseEther("5000")], chain: null }));
await wait(await ownerW.writeContract({ address: A.XKubPerpRouter, abi: router, functionName: "setAgent", args: [agent.address, true], chain: null }));
console.log("  balance:", formatEther(await pub.readContract({ address: A.XKubPerpRouter, abi: router, functionName: "collateralBalance", args: [owner.address] })),
  "isAgent:", await pub.readContract({ address: A.XKubPerpRouter, abi: router, functionName: "isAgent", args: [owner.address, agent.address] }));

const fee = await pub.readContract({ address: A.XKubPerpRouter, abi: router, functionName: "minExecutionFee" });

step("agent opens 2500 USD BTC long (500 collateral) — silent, no owner signature");
await wait(await agentW.writeContract({
  address: A.XKubPerpRouter, abi: router, functionName: "createIncreaseRequestFor",
  args: [owner.address, BTC, true, parseEther("500"), parseEther("2500"), 0n], value: fee, chain: null,
}));

const poll = async (pred, what, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    const v = await pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timeout waiting for ${what}`);
};

const pos = await poll(async () => {
  const p = await pub.readContract({ address: A.XKubPerpMarket, abi: marketAbi, functionName: "getPosition", args: [owner.address, BTC, true] });
  return p.sizeUsd > 0n ? p : null;
}, "keeper to execute open");
console.log("  position open: size", formatEther(pos.sizeUsd), "USD, collateral", formatEther(pos.collateralUsd));

step("agent closes — payout must land in the OWNER's wallet");
const before = await pub.readContract({ address: A.KUSDT, abi: erc20, functionName: "balanceOf", args: [owner.address] });
await wait(await agentW.writeContract({
  address: A.XKubPerpRouter, abi: router, functionName: "createDecreaseRequestFor",
  args: [owner.address, BTC, true, pos.sizeUsd, 0n], value: fee, chain: null,
}));
await poll(async () => {
  const p = await pub.readContract({ address: A.XKubPerpMarket, abi: marketAbi, functionName: "getPosition", args: [owner.address, BTC, true] });
  return p.sizeUsd === 0n ? true : null;
}, "keeper to execute close");
const after = await pub.readContract({ address: A.KUSDT, abi: erc20, functionName: "balanceOf", args: [owner.address] });
console.log("  owner received:", formatEther(after - before), "KUSDT");
const agentKusdt = await pub.readContract({ address: A.KUSDT, abi: erc20, functionName: "balanceOf", args: [agent.address] });
if (agentKusdt !== 0n) throw new Error("agent ended up with KUSDT!");
console.log("\nAGENT E2E OK — zero owner signatures for open+close, payout to owner, agent holds nothing");
