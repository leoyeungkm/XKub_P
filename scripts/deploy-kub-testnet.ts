/**
 * deploy-kub-testnet.ts
 * ─────────────────────
 * Full deployment of XKub protocol on KUB Chain testnet (chainId 25925)
 * Uses mock Diamon DEX since real Diamon may not exist on testnet.
 *
 * Usage:
 *   cd contracts
 *   npx hardhat run scripts/deploy-kub-testnet.ts --network kubTestnet
 *   # or local test:
 *   npx hardhat run scripts/deploy-kub-testnet.ts --network hardhat
 *
 * After deploy, get KUB testnet tokens from:
 *   https://faucet.bitkubchain.io (if available)
 *   or ask in Bitkub dev Discord
 *
 * Env vars needed:
 *   KUB_PRIVATE_KEY=0x...   (in root .env)
 */

import { ethers, network, upgrades } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// ─── Configuration ─────────────────────────────────────────────────────────────

// KUSDT decimals on KUB Chain — VERIFY on bkcscan before mainnet deploy!
// 18 = KAP-20 standard (most likely)
// 6  = bridged USDT from Ethereum
const KUSDT_DECIMALS = 18;

// Initial mock pool liquidity (for testnet price: 1 KKUB = 100 KUSDT)
const KKUB_LIQUIDITY  = ethers.parseEther("1000");         // 1000 KKUB (18 dec)
const KUSDT_LIQUIDITY = ethers.parseUnits("100000", KUSDT_DECIMALS); // 100,000 KUSDT

// Vault bonding curve initial params (scaled to 1e18)
const BC_VIRTUAL_BASE   = ethers.parseEther("2000000"); // 2M
const BC_VIRTUAL_TOKENS = ethers.parseEther("2000000"); // 2M
const BC_INITIAL_ASSETS = ethers.parseEther("1000");    // 1K KUSDT baseline

// Test buy amount
const TEST_BUY_KUSDT = ethers.parseUnits("100", KUSDT_DECIMALS); // 100 KUSDT

// ─── Helper ────────────────────────────────────────────────────────────────────

function log(msg: string) { console.log(msg); }
function section(title: string) {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(50));
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance    = await ethers.provider.getBalance(deployer.address);

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║       XKub Protocol — Testnet Deploy           ║");
  console.log("╚══════════════════════════════════════════════════╝");
  log(`Network  : ${network.name} (chainId ${network.config.chainId})`);
  log(`Deployer : ${deployer.address}`);
  log(`Balance  : ${ethers.formatEther(balance)} KUB`);

  if (balance < ethers.parseEther("0.1")) {
    console.warn("⚠  Balance < 0.1 KUB — may not be enough for deployment!");
  }

  const addresses: Record<string, string> = {};

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1: Deploy mock tokens
  // ═══════════════════════════════════════════════════════════════════════════
  section("Step 1 — Deploy Mock Tokens");

  const MockERC20 = await ethers.getContractFactory("MockERC20");

  const kusdt = await MockERC20.deploy("KUB USD Tether", "KUSDT", KUSDT_DECIMALS);
  await kusdt.waitForDeployment();
  addresses.KUSDT = await kusdt.getAddress();
  log(`KUSDT (${KUSDT_DECIMALS} dec) : ${addresses.KUSDT}`);

  const kkub = await MockERC20.deploy("Wrapped KUB", "KKUB", 18);
  await kkub.waitForDeployment();
  addresses.KKUB = await kkub.getAddress();
  log(`KKUB               : ${addresses.KKUB}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2: Deploy mock Diamon DEX + seed liquidity
  // ═══════════════════════════════════════════════════════════════════════════
  section("Step 2 — Deploy Mock Diamon DEX");

  const MockDiamonFactory = await ethers.getContractFactory("MockDiamonFactory");
  const dexFactory = await MockDiamonFactory.deploy();
  await dexFactory.waitForDeployment();
  addresses.DiamonFactory = await dexFactory.getAddress();
  log(`Diamon Factory : ${addresses.DiamonFactory}`);

  const MockDiamonRouter = await ethers.getContractFactory("MockDiamonRouter");
  const dexRouter = await MockDiamonRouter.deploy(addresses.DiamonFactory, addresses.KKUB);
  await dexRouter.waitForDeployment();
  addresses.DiamonRouter = await dexRouter.getAddress();
  log(`Diamon Router  : ${addresses.DiamonRouter}`);

  // Authorize router to call pair.swap() and pair.update()
  await (await dexFactory.setRouter(addresses.DiamonRouter, true)).wait();
  log("Router authorized on factory ✓");

  // Create KKUB/KUSDT pair
  log("\nCreating KKUB/KUSDT pair...");
  const createPairTx = await dexFactory.createPair(addresses.KKUB, addresses.KUSDT);
  await createPairTx.wait();

  const pairAddress = await dexFactory.getPair(addresses.KKUB, addresses.KUSDT);
  addresses.KKUBKUSDTPair = pairAddress;
  log(`KKUB/KUSDT pair : ${pairAddress}`);

  // Seed liquidity into pair (1000 KKUB + 100,000 KUSDT → rate: 1 KKUB = 100 KUSDT)
  log("Seeding liquidity (1000 KKUB + 100,000 KUSDT)...");
  await (await kusdt.mint(deployer.address, KUSDT_LIQUIDITY * 2n)).wait();
  await (await kkub.mint(deployer.address,  KKUB_LIQUIDITY  * 2n)).wait();

  await (await kkub.transfer(pairAddress, KKUB_LIQUIDITY)).wait();
  await (await kusdt.transfer(pairAddress, KUSDT_LIQUIDITY)).wait();

  const MockDiamonPair = await ethers.getContractFactory("MockDiamonPair");
  const pair = MockDiamonPair.attach(pairAddress);
  await (await pair.sync()).wait();
  log(`Pool reserves set. Rate: 1 KKUB ≈ ${Number(KUSDT_LIQUIDITY) / Number(KKUB_LIQUIDITY)} KUSDT`);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 3: Deploy XKubTestFactory
  // ═══════════════════════════════════════════════════════════════════════════
  section("Step 3 — Deploy XKubTestFactory");

  const XKubTestFactory = await ethers.getContractFactory("XKubTestFactory");
  const factory = await XKubTestFactory.deploy(deployer.address);
  await factory.waitForDeployment();
  addresses.XKubTestFactory = await factory.getAddress();
  log(`XKubTestFactory : ${addresses.XKubTestFactory}`);

  // Set minDepositUsdc to 1 KUSDT (accounting for KUSDT decimals)
  const minDeposit = ethers.parseUnits("1", KUSDT_DECIMALS);
  await (await factory.setMinDepositUsdc(minDeposit)).wait();
  log(`minDeposit set : 1 KUSDT (${minDeposit})`);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 4: Deploy libraries + XKubToken + XKubTrading
  // ═══════════════════════════════════════════════════════════════════════════
  section("Step 4 — Deploy XKubToken + XKubTrading (UUPS proxies)");

  // Deploy math libraries (required by XKubToken)
  log("Deploying HyperFunMath library...");
  const HyperFunMathLib = await ethers.getContractFactory("HyperFunMath");
  const hyperFunMath = await HyperFunMathLib.deploy();
  await hyperFunMath.waitForDeployment();
  addresses.HyperFunMath = await hyperFunMath.getAddress();
  log(`HyperFunMath    : ${addresses.HyperFunMath}`);

  log("Deploying HyperFunTokenLib library...");
  const HyperFunTokenLibLib = await ethers.getContractFactory("HyperFunTokenLib");
  const hyperFunTokenLib = await HyperFunTokenLibLib.deploy();
  await hyperFunTokenLib.waitForDeployment();
  addresses.HyperFunTokenLib = await hyperFunTokenLib.getAddress();
  log(`HyperFunTokenLib: ${addresses.HyperFunTokenLib}`);

  // --- XKubToken ---
  const XKubToken = await ethers.getContractFactory("XKubToken", {
    libraries: {
      HyperFunMath:     addresses.HyperFunMath,
      HyperFunTokenLib: addresses.HyperFunTokenLib,
    },
  });
  log("Deploying XKubToken proxy...");

  // We initialize with a placeholder tradingModule (address(0)) — set it after deploying trading
  const vaultInitArgs = [
    deployer.address,           // _leader
    "Test KUB Vault",           // _name
    "tKUBV",                    // _symbol
    500,                        // _feeBps (5% performance fee)
    deployer.address,           // _treasury (unused, read from factory)
    deployer.address,           // _admin
    ethers.ZeroAddress,         // _tradingModule (set after)
    addresses.XKubTestFactory,   // _factory
    BC_VIRTUAL_BASE,            // _virtualBase
    BC_VIRTUAL_TOKENS,          // _virtualTokens
    BC_INITIAL_ASSETS,          // _initialAssets
    addresses.KUSDT,            // _kusdt
    KUSDT_DECIMALS,             // _quoteDecimals
  ];

  const vault = await upgrades.deployProxy(XKubToken, vaultInitArgs, {
    kind: "uups",
    initializer: "initialize",
    unsafeAllowLinkedLibraries: true,
  });
  await vault.waitForDeployment();
  addresses.XKubToken = await vault.getAddress();
  log(`XKubToken proxy : ${addresses.XKubToken}`);

  // --- SpotNavVault (not a proxy — simple contract) ---
  log("\nDeploying SpotNavVault...");
  const SpotNavVault = await ethers.getContractFactory("SpotNavVault");
  const spotNav = await SpotNavVault.deploy(
    addresses.DiamonRouter,
    addresses.DiamonFactory,
    addresses.KUSDT,
    addresses.XKubToken,
    deployer.address
  );
  await spotNav.waitForDeployment();
  addresses.SpotNavVault = await spotNav.getAddress();
  log(`SpotNavVault       : ${addresses.SpotNavVault}`);

  // Track KKUB in SpotNavVault
  log("Tracking KKUB in SpotNavVault...");
  await (await spotNav.trackToken(addresses.KKUB)).wait();
  log("KKUB tracked ✓");

  // --- XKubTrading ---
  const XKubTrading = await ethers.getContractFactory("XKubTrading");
  log("\nDeploying XKubTrading proxy...");

  const tradingInitArgs = [
    addresses.XKubToken,      // _vault
    deployer.address,           // _admin
    addresses.XKubTestFactory,   // _factory
    addresses.DiamonRouter,     // _router
    addresses.DiamonFactory,    // _dexFactory
    addresses.KUSDT,            // _quote
    addresses.SpotNavVault,     // _spotNavVault
  ];

  const trading = await upgrades.deployProxy(XKubTrading, tradingInitArgs, {
    kind: "uups",
    initializer: "initialize",
    unsafeAllowLinkedLibraries: true,
  });
  await trading.waitForDeployment();
  addresses.XKubTrading = await trading.getAddress();
  log(`XKubTrading proxy : ${addresses.XKubTrading}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 5: Wire contracts together
  // ═══════════════════════════════════════════════════════════════════════════
  section("Step 5 — Wire Contracts");

  // Set tradingModule on vault
  log("Setting tradingModule on XKubToken...");
  await (await vault.setTradingModule(addresses.XKubTrading)).wait();
  log("tradingModule set ✓");

  // Init TWAP NAV
  log("Initializing TWAP NAV...");
  await (await vault.initTwapNav()).wait();
  log("twapNav initialized ✓");

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 6: Smoke test — buy + leader swap + sell
  // ═══════════════════════════════════════════════════════════════════════════
  section("Step 6 — Smoke Test");

  // Approve vault to spend KUSDT
  log(`Approving vault to spend ${ethers.formatUnits(TEST_BUY_KUSDT, KUSDT_DECIMALS)} KUSDT...`);
  await (await kusdt.approve(addresses.XKubToken, TEST_BUY_KUSDT)).wait();

  // Buy vault tokens
  log("Calling buy()...");
  const buyTx = await vault.buy(TEST_BUY_KUSDT, 0, ethers.ZeroAddress);
  const buyReceipt = await buyTx.wait();
  log(`buy() tx: ${buyReceipt?.hash}`);

  const vaultTokenBal = await vault.balanceOf(deployer.address);
  log(`Vault tokens received: ${ethers.formatEther(vaultTokenBal)}`);

  const nav = await vault.getNAV();
  log(`NAV: ${ethers.formatEther(nav)} (1e18 = 1 KUSDT per vault token)`);

  // Leader swap: buy some KKUB with 50 KUSDT
  const swapAmount = ethers.parseUnits("50", KUSDT_DECIMALS);
  log(`\nLeader swap: ${ethers.formatUnits(swapAmount, KUSDT_DECIMALS)} KUSDT → KKUB...`);
  await (await kusdt.approve(addresses.XKubToken, swapAmount)).wait(); // not needed — vault holds it

  // Execute swap via trading module
  const previewOut = await trading.previewSwap(addresses.KUSDT, addresses.KKUB, swapAmount);
  log(`Preview out: ${ethers.formatEther(previewOut)} KKUB`);
  const minOut = previewOut * 95n / 100n; // 5% slippage tolerance

  const swapTx = await trading.executeSwap(
    addresses.KUSDT, addresses.KKUB, swapAmount, minOut
  );
  await swapTx.wait();
  log("Swap executed ✓");

  const kkubInVault  = await kkub.balanceOf(addresses.XKubToken);
  const kusdtInVault = await kusdt.balanceOf(addresses.XKubToken);
  log(`Vault now holds: ${ethers.formatEther(kkubInVault)} KKUB + ${ethers.formatUnits(kusdtInVault, KUSDT_DECIMALS)} KUSDT`);

  const totalAssets = await trading.getTotalAssets();
  log(`Total assets (via SpotNavVault): ${ethers.formatUnits(totalAssets, KUSDT_DECIMALS)} KUSDT`);

  // Sell half the vault tokens (tests auto-liquidation)
  const sellTokens = vaultTokenBal / 2n;
  log(`\nSelling ${ethers.formatEther(sellTokens)} vault tokens (auto-liquidation test)...`);
  const sellTx = await vault.sell(sellTokens, 0);
  const sellReceipt = await sellTx.wait();
  log(`sell() tx: ${sellReceipt?.hash}`);

  const kusdtAfterSell = await kusdt.balanceOf(deployer.address);
  log(`KUSDT balance after sell: ${ethers.formatUnits(kusdtAfterSell, KUSDT_DECIMALS)}`);

  log("\n✅ All smoke tests passed!");

  // ═══════════════════════════════════════════════════════════════════════════
  // Save deployment info
  // ═══════════════════════════════════════════════════════════════════════════
  section("Deployment Summary");

  const deployInfo = {
    network:      network.name,
    chainId:      network.config.chainId,
    deployer:     deployer.address,
    deployedAt:   new Date().toISOString(),
    kusdtDecimals: KUSDT_DECIMALS,
    addresses,
    notes: {
      DiamonFactory:  "MOCK — replace with real Diamon factory on mainnet",
      DiamonRouter:   "MOCK — replace with 0xAb30a29168D792c5e6a54E4bcF1Aec926a3b20FA on mainnet",
      XKubTestFactory: "MOCK — replace with full XKubFactory on mainnet",
      KUSDT:          "MOCK — replace with real KUSDT address on mainnet",
      KKUB:           "MOCK — replace with real KKUB address on mainnet",
    }
  };

  for (const [name, addr] of Object.entries(addresses)) {
    log(`${name.padEnd(20)}: ${addr}`);
  }

  const outDir  = path.resolve(__dirname, "../deployments");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `kub-${network.name}-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(deployInfo, null, 2));
  log(`\nDeployment info saved to: ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
