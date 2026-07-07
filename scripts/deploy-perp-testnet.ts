/**
 * XKub Perp — deployment script
 *
 * Deploys the perp stack: XKubPriceOracle → XKubPerpPool → XKubPerpMarket,
 * wires them together, lists BTC / ETH / KUB markets, seeds prices and
 * (on hardhat) runs a full smoke test.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-perp-testnet.ts --network hardhat
 *   npx hardhat run scripts/deploy-perp-testnet.ts --network kubTestnet
 *
 * Env:
 *   KUSDT_ADDRESS   — quote token (default: deploy MockERC20 on hardhat,
 *                     reuse testnet mock on kubTestnet)
 *   KUSDT_DECIMALS  — 18 (KAP-20 mock) or 6
 *   KEEPER_ADDRESS  — price keeper bot wallet (default: deployer)
 *   SEED_BTC / SEED_ETH / SEED_KUB — initial prices in whole USD
 *                     (keeper bot corrects them right away)
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const E18 = 10n ** 18n;
const usd = (n: number) => BigInt(Math.round(n * 1e6)) * (E18 / 10n ** 6n);

// Mock KUSDT from the 2026-05-26 kubTestnet deployment
const TESTNET_MOCK_KUSDT = "0xB16F025234661aFE6Ab43EEEE8e5a688122C3D0c";

interface MarketDef {
  symbol: string;
  maxLeverageX: number;
  maxOiUsd: bigint;
  borrowRateFactorBps: number;
  seedPrice: number;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const isLocal = network.name === "hardhat" || network.name === "localhost";
  console.log(`\n=== XKub Perp deploy — network: ${network.name}, deployer: ${deployer.address} ===\n`);

  // ─── Quote token ───────────────────────────────────────────────────────────
  let kusdtAddress = process.env.KUSDT_ADDRESS ?? "";
  let kusdtDecimals = Number(process.env.KUSDT_DECIMALS ?? "18");
  if (!kusdtAddress) {
    if (isLocal) {
      const mock = await ethers.deployContract("MockERC20", ["Mock KUSDT", "KUSDT", 18]);
      await mock.waitForDeployment();
      kusdtAddress = await mock.getAddress();
      kusdtDecimals = 18;
      console.log(`Deployed MockERC20 KUSDT: ${kusdtAddress}`);
    } else if (network.name === "kubTestnet") {
      kusdtAddress = TESTNET_MOCK_KUSDT;
      kusdtDecimals = 18;
      console.log(`Reusing testnet mock KUSDT: ${kusdtAddress}`);
    } else {
      throw new Error("KUSDT_ADDRESS is required on mainnet");
    }
  }

  // ─── Markets (BTC / ETH / KUB first wave) ──────────────────────────────────
  const markets: MarketDef[] = [
    { symbol: "BTC", maxLeverageX: 10, maxOiUsd: usd(500_000), borrowRateFactorBps: 10, seedPrice: Number(process.env.SEED_BTC ?? "100000") },
    { symbol: "ETH", maxLeverageX: 10, maxOiUsd: usd(300_000), borrowRateFactorBps: 10, seedPrice: Number(process.env.SEED_ETH ?? "4000") },
    // KUB is thin + volatile → lower leverage, smaller cap, pricier borrow
    { symbol: "KUB", maxLeverageX: 5, maxOiUsd: usd(100_000), borrowRateFactorBps: 20, seedPrice: Number(process.env.SEED_KUB ?? "1.5") },
  ];

  // ─── Core contracts ────────────────────────────────────────────────────────
  const oracle = await ethers.deployContract("XKubPriceOracle", [deployer.address]);
  await oracle.waitForDeployment();
  console.log(`XKubPriceOracle: ${await oracle.getAddress()}`);

  const pool = await ethers.deployContract("XKubPerpPool", [kusdtAddress, kusdtDecimals, deployer.address]);
  await pool.waitForDeployment();
  console.log(`XKubPerpPool:    ${await pool.getAddress()}`);

  const market = await ethers.deployContract("XKubPerpMarket", [
    kusdtAddress, kusdtDecimals, await oracle.getAddress(), await pool.getAddress(), deployer.address,
  ]);
  await market.waitForDeployment();
  console.log(`XKubPerpMarket:  ${await market.getAddress()}`);

  const router = await ethers.deployContract("XKubPerpRouter", [
    kusdtAddress, await market.getAddress(), await oracle.getAddress(), deployer.address,
  ]);
  await router.waitForDeployment();
  console.log(`XKubPerpRouter:  ${await router.getAddress()}`);

  const referral = await ethers.deployContract("XKubReferral", [
    kusdtAddress, kusdtDecimals, deployer.address,
  ]);
  await referral.waitForDeployment();
  console.log(`XKubReferral:    ${await referral.getAddress()}`);

  // ─── Wiring ────────────────────────────────────────────────────────────────
  await (await pool.setMarket(await market.getAddress())).wait();
  await (await market.setRouter(await router.getAddress())).wait();
  await (await market.setReferral(await referral.getAddress())).wait();
  await (await referral.setMarket(await market.getAddress())).wait();
  // directTradingEnabled stays FALSE — all orders go through the router

  // ─── Protocol revenue + VIP fee tiers ───────────────────────────────────────
  const treasury = process.env.TREASURY_ADDRESS ?? deployer.address;
  await (await market.setTreasury(treasury)).wait();
  await (await market.setProtocolFeeShareBps(Number(process.env.PROTOCOL_FEE_SHARE_BPS ?? "3000"))).wait(); // 30% of fees
  // VIP tiers: tier 1 = 10% off, tier 2 = 25% off, tier 3 = 50% off (tier 0 = default)
  const TIERS: Record<number, number> = { 1: 1000, 2: 2500, 3: 5000 };
  for (const [tier, disc] of Object.entries(TIERS)) {
    await (await market.setTierDiscount(Number(tier), disc)).wait();
  }
  console.log(`Treasury: ${treasury} · protocol fee share 30% · VIP tiers 1/2/3 = 10/25/50% off`);

  const keeper = process.env.KEEPER_ADDRESS ?? deployer.address;
  await (await oracle.setKeeper(keeper, true)).wait();
  await (await router.setKeeper(keeper, true)).wait();
  console.log(`Keeper: ${keeper}`);

  for (const m of markets) {
    const id = ethers.encodeBytes32String(m.symbol);
    await (await oracle.forceSetPrice(id, usd(m.seedPrice))).wait();
    await (await market.listMarket(id, m.maxLeverageX, m.maxOiUsd, m.borrowRateFactorBps)).wait();
    console.log(`Listed ${m.symbol}: ${m.maxLeverageX}x, OI cap ${ethers.formatEther(m.maxOiUsd)} USD, seed $${m.seedPrice}`);
  }

  // ─── Smoke test via the router (local only) ────────────────────────────────
  if (isLocal) {
    console.log("\n--- smoke test (two-step router flow) ---");
    const kusdt = await ethers.getContractAt("MockERC20", kusdtAddress);
    const BTC = ethers.encodeBytes32String("BTC");
    const fee = await router.minExecutionFee();

    await (await kusdt.mint(deployer.address, usd(200_000))).wait();
    await (await kusdt.approve(await pool.getAddress(), ethers.MaxUint256)).wait();
    await (await kusdt.approve(await router.getAddress(), ethers.MaxUint256)).wait();

    await (await pool.deposit(usd(100_000))).wait();
    console.log(`LP deposit 100k, XPLP: ${ethers.formatEther(await pool.balanceOf(deployer.address))}`);

    await (await router.createIncreaseRequest(BTC, true, usd(1_000), usd(10_000), 0, { value: fee })).wait();
    await (await router.executeRequest(0)).wait();
    console.log(`Opened 10k BTC long via router (request #0)`);

    const seed = markets[0].seedPrice;
    await (await oracle.forceSetPrice(BTC, usd(seed * 1.05))).wait();
    console.log(`BTC +5%, pnl: ${ethers.formatEther(await market.getPositionPnl(deployer.address, BTC, true))} USD`);

    const before = await kusdt.balanceOf(deployer.address);
    await (await router.createDecreaseRequest(BTC, true, usd(10_000), 0, { value: fee })).wait();
    await (await router.executeRequest(1)).wait();
    console.log(`Closed via router, received: ${ethers.formatEther(await kusdt.balanceOf(deployer.address) - before)} KUSDT`);
    console.log(`Pool value: ${ethers.formatEther(await pool.poolValueUsd())} USD`);
    console.log("--- smoke test OK ---\n");
  }

  // ─── Save deployment ───────────────────────────────────────────────────────
  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    kusdtDecimals,
    addresses: {
      KUSDT: kusdtAddress,
      XKubPriceOracle: await oracle.getAddress(),
      XKubPerpPool: await pool.getAddress(),
      XKubPerpMarket: await market.getAddress(),
      XKubPerpRouter: await router.getAddress(),
      XKubReferral: await referral.getAddress(),
    },
    keeper,
    markets: markets.map(m => ({
      symbol: m.symbol,
      maxLeverageX: m.maxLeverageX,
      maxOiUsd: ethers.formatEther(m.maxOiUsd),
      borrowRateFactorBps: m.borrowRateFactorBps,
    })),
    notes: {
      oracle: "keeper-posted prices — run scripts/perp-keeper-bot.ts continuously",
      pool: "deposit KUSDT → mint XPLP; pool is counterparty to all positions",
      market: "direct trading DISABLED — all orders go through XKubPerpRouter (two-step)",
      router: "createIncreaseRequest / createDecreaseRequest with executionFee; keeper executes",
    },
  };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `perp-${network.name}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Saved: ${file}`);

  // ─── Frontend config ───────────────────────────────────────────────────────
  const rpcUrl = network.name === "kubTestnet" ? "https://rpc-testnet.bitkubchain.io"
    : network.name === "kubMainnet" ? "https://rpc.bitkubchain.io"
    : "http://127.0.0.1:8545";
  const explorer = network.name === "kubTestnet" ? "https://testnet.kubscan.com"
    : network.name === "kubMainnet" ? "https://www.kubscan.com" : "";
  const cfg = {
    chainId: out.chainId,
    chainName: network.name === "kubMainnet" ? "Bitkub Chain" : "Bitkub Chain Testnet",
    rpcUrl, explorer,
    kusdtDecimals,
    addresses: out.addresses,
    markets: markets.map(m => ({ symbol: m.symbol, maxLeverageX: m.maxLeverageX })),
    // VIP fee tiers (discount in bps of the position fee) — for UI display
    feeTiers: [
      { tier: 0, name: "Standard", discountBps: 0 },
      { tier: 1, name: "VIP 1", discountBps: 1000 },
      { tier: 2, name: "VIP 2", discountBps: 2500 },
      { tier: 3, name: "VIP 3", discountBps: 5000 },
    ],
  };
  // Next.js app: static JSON import
  const feCfgDir = path.join(__dirname, "..", "frontend", "src", "config");
  if (fs.existsSync(path.join(__dirname, "..", "frontend"))) {
    fs.mkdirSync(feCfgDir, { recursive: true });
    fs.writeFileSync(path.join(feCfgDir, "deployment.json"), JSON.stringify(cfg, null, 2));
    console.log(`Frontend config written: frontend/src/config/deployment.json`);
  }
  // Legacy static page backup
  const staticDir = path.join(__dirname, "..", "frontend-static");
  if (fs.existsSync(staticDir)) {
    fs.writeFileSync(path.join(staticDir, "config.js"),
      `// Auto-generated by deploy-perp-testnet.ts (${network.name}, ${new Date().toISOString()})\n` +
      `window.XKUB_CONFIG = ${JSON.stringify(cfg, null, 2)};\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
