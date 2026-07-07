/**
 * deploy-kub-factory.ts
 * ─────────────────────
 * Deploys the PRODUCTION XKub protocol (XKubFactory + implementations).
 *
 * Usage:
 *   cd contracts
 *   npx hardhat run scripts/deploy-kub-factory.ts --network kubTestnet
 *   npx hardhat run scripts/deploy-kub-factory.ts --network kubMainnet
 *   npx hardhat run scripts/deploy-kub-factory.ts --network hardhat   # local test
 *
 * Env vars (root .env):
 *   KUB_PRIVATE_KEY=0x...
 *
 * For KUB testnet: uses the Mock DEX + Mock tokens deployed in deploy-kub-testnet.ts.
 *   Pass their addresses via env vars or hardcode for quick test.
 * For mainnet: set real KUSDT / KKUB / Diamon addresses in the CONFIG section below.
 *
 * Deploy order:
 *   1. XKubToken   implementation (logic contract, not proxy)
 *   2. XKubTrading implementation
 *   3. SpotNavVaultDeployer (plain helper, not proxy)
 *   4. XKubFactory UUPS proxy
 *   5. Smoke test: createVault → buy → leaderSwap → sell
 */

import { ethers, network, upgrades } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// ─── CONFIG ────────────────────────────────────────────────────────────────────
// Override these via env vars or edit directly for mainnet.
// For testnet: deploy-kub-testnet.ts must have run first; paste its addresses here.

const CONFIG = {
  // ── Quote token ─────────────────────────────────────────────────────────────
  // Mainnet: verify KUSDT address on bkcscan.com. Likely 18 decimals (KAP-20).
  KUSDT_ADDRESS:    process.env.KUSDT_ADDRESS    || "",   // MUST set on mainnet
  KUSDT_DECIMALS:   Number(process.env.KUSDT_DECIMALS   || "18"),

  // ── Diamon DEX ───────────────────────────────────────────────────────────────
  // Mainnet: Router = 0xAb30a29168D792c5e6a54E4bcF1Aec926a3b20FA
  DIAMON_ROUTER:    process.env.DIAMON_ROUTER    || "",
  DIAMON_FACTORY:   process.env.DIAMON_FACTORY   || "",

  // ── For testnet smoke test (buy/sell needs liquidity) ────────────────────────
  KKUB_ADDRESS:     process.env.KKUB_ADDRESS     || "",   // mock KKUB on testnet

  // ── Platform ─────────────────────────────────────────────────────────────────
  TREASURY_ADDRESS: process.env.TREASURY_ADDRESS || "",   // defaults to deployer
};

const KUSDT_DECIMALS = CONFIG.KUSDT_DECIMALS;

// ─── Helpers ───────────────────────────────────────────────────────────────────
function log(msg: string) { console.log(msg); }
function section(title: string) {
  console.log(`\n${"─".repeat(52)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(52));
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const [deployer] = await ethers.getSigners();
  const balance    = await ethers.provider.getBalance(deployer.address);

  console.log("╔════════════════════════════════════════════════════╗");
  console.log("║    XKub Production Factory — Deploy Script       ║");
  console.log("╚════════════════════════════════════════════════════╝");
  log(`Network  : ${network.name} (chainId ${network.config.chainId})`);
  log(`Deployer : ${deployer.address}`);
  log(`Balance  : ${ethers.formatEther(balance)} KUB`);
  if (balance < ethers.parseEther("0.5"))
    console.warn("⚠  Balance < 0.5 KUB — may not be enough!");

  const isHardhat = network.name === "hardhat";
  const addresses: Record<string, string> = {};

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 0 (hardhat only): Deploy mock tokens + DEX so the smoke test works
  // ═══════════════════════════════════════════════════════════════════════════
  if (isHardhat) {
    section("Step 0 — Deploy mocks (hardhat only)");
    const MockERC20 = await ethers.getContractFactory("MockERC20");

    const kusdt = await MockERC20.deploy("KUB USD Tether", "KUSDT", KUSDT_DECIMALS);
    await kusdt.waitForDeployment();
    CONFIG.KUSDT_ADDRESS = await kusdt.getAddress();
    log(`KUSDT : ${CONFIG.KUSDT_ADDRESS}`);

    const kkub = await MockERC20.deploy("Wrapped KUB", "KKUB", 18);
    await kkub.waitForDeployment();
    CONFIG.KKUB_ADDRESS = await kkub.getAddress();
    log(`KKUB  : ${CONFIG.KKUB_ADDRESS}`);

    const MockDiamonFactory = await ethers.getContractFactory("MockDiamonFactory");
    const dexFactory = await MockDiamonFactory.deploy();
    await dexFactory.waitForDeployment();
    CONFIG.DIAMON_FACTORY = await dexFactory.getAddress();

    const MockDiamonRouter = await ethers.getContractFactory("MockDiamonRouter");
    const dexRouter = await MockDiamonRouter.deploy(CONFIG.DIAMON_FACTORY, CONFIG.KKUB_ADDRESS);
    await dexRouter.waitForDeployment();
    CONFIG.DIAMON_ROUTER = await dexRouter.getAddress();

    await (await dexFactory.setRouter(CONFIG.DIAMON_ROUTER, true)).wait();
    log(`Diamon Factory : ${CONFIG.DIAMON_FACTORY}`);
    log(`Diamon Router  : ${CONFIG.DIAMON_ROUTER}`);

    // Seed KKUB/KUSDT pair
    await (await dexFactory.createPair(CONFIG.KKUB_ADDRESS, CONFIG.KUSDT_ADDRESS)).wait();
    const pairAddr = await dexFactory.getPair(CONFIG.KKUB_ADDRESS, CONFIG.KUSDT_ADDRESS);
    const MockERC20_ = await ethers.getContractFactory("MockERC20");
    const kusdtC = MockERC20_.attach(CONFIG.KUSDT_ADDRESS) as any;
    const kkubC  = MockERC20_.attach(CONFIG.KKUB_ADDRESS)  as any;

    const kusdtLiq = ethers.parseUnits("200000", KUSDT_DECIMALS);
    const kkubLiq  = ethers.parseEther("2000");
    await (await kusdtC.mint(deployer.address, kusdtLiq)).wait();
    await (await kkubC.mint(deployer.address, kkubLiq)).wait();
    await (await kkubC.transfer(pairAddr,  kkubLiq  / 2n)).wait();
    await (await kusdtC.transfer(pairAddr, kusdtLiq / 2n)).wait();
    const MockDiamonPair = await ethers.getContractFactory("MockDiamonPair");
    await (await MockDiamonPair.attach(pairAddr).sync()).wait();
    log("Mock pool seeded: 1000 KKUB + 100,000 KUSDT ✓");
  }

  // Validate required addresses
  if (!CONFIG.KUSDT_ADDRESS)   throw new Error("Set KUSDT_ADDRESS env var");
  if (!CONFIG.DIAMON_ROUTER)   throw new Error("Set DIAMON_ROUTER env var");
  if (!CONFIG.DIAMON_FACTORY)  throw new Error("Set DIAMON_FACTORY env var");
  const treasury = CONFIG.TREASURY_ADDRESS || deployer.address;

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1: Deploy XKubToken implementation
  // ═══════════════════════════════════════════════════════════════════════════
  section("Step 1 — Deploy XKubToken + XKubTrading implementations");

  log("Deploying HyperFunMath library...");
  const HyperFunMathLib = await ethers.getContractFactory("HyperFunMath");
  const hyperFunMath = await HyperFunMathLib.deploy();
  await hyperFunMath.waitForDeployment();
  addresses.HyperFunMath = await hyperFunMath.getAddress();
  log(`HyperFunMath     : ${addresses.HyperFunMath}`);

  log("Deploying HyperFunTokenLib library...");
  const HyperFunTokenLibLib = await ethers.getContractFactory("HyperFunTokenLib");
  const hyperFunTokenLib = await HyperFunTokenLibLib.deploy();
  await hyperFunTokenLib.waitForDeployment();
  addresses.HyperFunTokenLib = await hyperFunTokenLib.getAddress();
  log(`HyperFunTokenLib : ${addresses.HyperFunTokenLib}`);

  // XKubToken implementation (not a proxy — just the logic contract)
  log("Deploying XKubToken implementation...");
  const XKubTokenFactory = await ethers.getContractFactory("XKubToken", {
    libraries: {
      HyperFunMath:     addresses.HyperFunMath,
      HyperFunTokenLib: addresses.HyperFunTokenLib,
    },
  });
  const coreImpl = await XKubTokenFactory.deploy();
  await coreImpl.waitForDeployment();
  addresses.XKubTokenImpl = await coreImpl.getAddress();
  log(`XKubToken impl  : ${addresses.XKubTokenImpl}`);

  // XKubTrading implementation
  log("Deploying XKubTrading implementation...");
  const XKubTradingFactory = await ethers.getContractFactory("XKubTrading");
  const tradingImpl = await XKubTradingFactory.deploy();
  await tradingImpl.waitForDeployment();
  addresses.XKubTradingImpl = await tradingImpl.getAddress();
  log(`XKubTrading impl: ${addresses.XKubTradingImpl}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2: Deploy SpotNavVaultDeployer
  // ═══════════════════════════════════════════════════════════════════════════
  section("Step 2 — Deploy SpotNavVaultDeployer");

  const SpotNavVaultDeployerFactory = await ethers.getContractFactory("SpotNavVaultDeployer");
  const spotNavVaultDeployer = await SpotNavVaultDeployerFactory.deploy();
  await spotNavVaultDeployer.waitForDeployment();
  addresses.SpotNavVaultDeployer = await spotNavVaultDeployer.getAddress();
  log(`SpotNavVaultDeployer : ${addresses.SpotNavVaultDeployer}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 3: Deploy XKubFactory UUPS proxy
  // ═══════════════════════════════════════════════════════════════════════════
  section("Step 3 — Deploy XKubFactory (UUPS proxy)");

  const XKubFactoryFactory = await ethers.getContractFactory("XKubFactory");
  const factoryInitArgs = [
    addresses.XKubTokenImpl,       // _coreImpl
    addresses.XKubTradingImpl,     // _tradingImpl
    treasury,                        // _treasury
    CONFIG.KUSDT_ADDRESS,            // _kusdt
    KUSDT_DECIMALS,                  // _quoteDecimals
    CONFIG.DIAMON_ROUTER,            // _router
    CONFIG.DIAMON_FACTORY,           // _dexFactory
    addresses.SpotNavVaultDeployer,  // _spotNavVaultDeployer
  ];

  const kubFactory = await upgrades.deployProxy(XKubFactoryFactory, factoryInitArgs, {
    kind: "uups",
    initializer: "initialize",
  });
  await kubFactory.waitForDeployment();
  addresses.XKubFactory = await kubFactory.getAddress();
  log(`XKubFactory proxy  : ${addresses.XKubFactory}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 4: Smoke test — createVault → buy → leaderSwap → sell
  // ═══════════════════════════════════════════════════════════════════════════
  section("Step 4 — Smoke Test: createVault");

  // Approve creation fee (0 by default, but still call approve to test path)
  const creationFee = await kubFactory.creationFee();
  if (creationFee > 0n) {
    const kusdtC = (await ethers.getContractFactory("MockERC20")).attach(CONFIG.KUSDT_ADDRESS) as any;
    await (await kusdtC.approve(addresses.XKubFactory, creationFee)).wait();
    log(`Creation fee approved: ${ethers.formatUnits(creationFee, KUSDT_DECIMALS)} KUSDT`);
  }

  log("Calling XKubFactory.createVault()...");
  const createTx = await kubFactory.createVault("Test Production Vault", "tPROD", 500);
  const createReceipt = await createTx.wait();

  // Parse VaultCreated event
  const vaultCreatedTopic = kubFactory.interface.getEvent("VaultCreated")!.topicHash;
  const vaultLog = createReceipt?.logs.find(l => l.topics[0] === vaultCreatedTopic);
  if (!vaultLog) throw new Error("VaultCreated event not found");
  const parsed = kubFactory.interface.parseLog({ topics: vaultLog.topics as string[], data: vaultLog.data })!;
  const vaultCore     = parsed.args.core as string;
  const vaultTrading  = parsed.args.trading as string;
  const vaultSpotNav  = parsed.args.spotNavVault as string;

  addresses.VaultCore    = vaultCore;
  addresses.VaultTrading = vaultTrading;
  addresses.VaultSpotNav = vaultSpotNav;

  log(`Vault core     : ${vaultCore}`);
  log(`Vault trading  : ${vaultTrading}`);
  log(`Vault SpotNav  : ${vaultSpotNav}`);

  // Verify factory registered vault
  const info = await kubFactory.getVaultInfo(vaultCore);
  log(`Factory registered: ${info.core} (leader: ${info.leader}) ✓`);
  log(`SpotNavVault admin: ${info.spotNavVault} ✓`);

  if (isHardhat && CONFIG.KKUB_ADDRESS) {
    section("Step 4b — Smoke Test: buy → leaderSwap → sell");

    // Track KKUB in SpotNavVault (owner = deployer)
    await (await kubFactory.trackTokenForVault(vaultCore, CONFIG.KKUB_ADDRESS)).wait();
    log("KKUB tracked in SpotNavVault ✓");

    const kusdtC = (await ethers.getContractFactory("MockERC20")).attach(CONFIG.KUSDT_ADDRESS) as any;
    const vault  = (await ethers.getContractFactory("XKubToken", {
      libraries: {
        HyperFunMath:     addresses.HyperFunMath,
        HyperFunTokenLib: addresses.HyperFunTokenLib,
      },
    })).attach(vaultCore) as any;
    const trading = (await ethers.getContractFactory("XKubTrading")).attach(vaultTrading) as any;

    // Mint KUSDT to deployer
    const buyAmt = ethers.parseUnits("100", KUSDT_DECIMALS);
    await (await kusdtC.mint(deployer.address, buyAmt * 2n)).wait();
    await (await kusdtC.approve(vaultCore, buyAmt)).wait();

    // Buy
    const buyTx = await vault.buy(buyAmt, 0, ethers.ZeroAddress);
    await buyTx.wait();
    const vtBal = await vault.balanceOf(deployer.address);
    log(`buy() ✓ — received ${ethers.formatEther(vtBal)} vault tokens`);
    log(`NAV: ${ethers.formatEther(await vault.getNAV())}`);

    // Leader swap: 50 KUSDT → KKUB
    const swapAmt = ethers.parseUnits("50", KUSDT_DECIMALS);
    const previewOut = await trading.previewSwap(CONFIG.KUSDT_ADDRESS, CONFIG.KKUB_ADDRESS, swapAmt);
    const minOut = previewOut * 95n / 100n;
    await (await trading.executeSwap(CONFIG.KUSDT_ADDRESS, CONFIG.KKUB_ADDRESS, swapAmt, minOut)).wait();
    log(`leaderSwap() ✓ — ${ethers.formatUnits(swapAmt, KUSDT_DECIMALS)} KUSDT → ${ethers.formatEther(previewOut)} KKUB`);

    // Sell half vault tokens (triggers auto-liquidation)
    const sellTokens = vtBal / 2n;
    await (await vault.sell(sellTokens, 0)).wait();
    const kusdtAfter = await kusdtC.balanceOf(deployer.address);
    log(`sell() ✓ — KUSDT balance now: ${ethers.formatUnits(kusdtAfter, KUSDT_DECIMALS)}`);

    log("\n✅ Full smoke test passed!");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════════
  section("Deployment Summary");

  addresses.KUSDT          = CONFIG.KUSDT_ADDRESS;
  addresses.DiamonRouter   = CONFIG.DIAMON_ROUTER;
  addresses.DiamonFactory  = CONFIG.DIAMON_FACTORY;
  if (CONFIG.KKUB_ADDRESS) addresses.KKUB = CONFIG.KKUB_ADDRESS;

  for (const [name, addr] of Object.entries(addresses)) {
    log(`${name.padEnd(22)}: ${addr}`);
  }

  const deployInfo = {
    network:       network.name,
    chainId:       network.config.chainId,
    deployer:      deployer.address,
    deployedAt:    new Date().toISOString(),
    treasury,
    kusdtDecimals: KUSDT_DECIMALS,
    addresses,
    notes: {
      XKubFactory:       "UUPS proxy — upgrade via factory owner",
      XKubTokenImpl:     "Logic contract — shared by all vault proxies",
      XKubTradingImpl:   "Logic contract — shared by all trading proxies",
      SpotNavVaultDeployer:"Plain contract — deploys SpotNavVault per createVault()",
      createVault:         "Call XKubFactory.createVault(name, symbol, feeBps) to launch a vault",
    }
  };

  const outDir  = path.resolve(__dirname, "../deployments");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `kub-factory-${network.name}-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(deployInfo, null, 2));
  log(`\nDeployment info saved to: ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
