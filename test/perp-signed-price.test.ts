import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/*
  XKub Perp — signed (pull) prices for timely liquidation.
  A keeper signs a fresh price off-chain; anyone can bundle it with a
  liquidation so gap moves are caught immediately, minimising bad debt.
*/

const BTC = ethers.encodeBytes32String("BTC");
const E18 = 10n ** 18n;
const usd = (n: number | bigint) => BigInt(n) * E18;

describe("XKub Perp — signed-price liquidation", () => {
  async function fixture() {
    const [admin, lp, trader, liquidator] = await ethers.getSigners();
    const keeper = ethers.Wallet.createRandom();

    const kusdt = await ethers.deployContract("MockERC20", ["Mock KUSDT", "KUSDT", 18]);
    const oracle = await ethers.deployContract("XKubPriceOracle", [admin.address]);
    const pool = await ethers.deployContract("XKubPerpPool", [await kusdt.getAddress(), 18, admin.address]);
    const market = await ethers.deployContract("XKubPerpMarket", [
      await kusdt.getAddress(), 18, await oracle.getAddress(), await pool.getAddress(), admin.address,
    ]);

    await pool.setMarket(await market.getAddress());
    await market.setRouter(admin.address);
    await market.setDirectTradingEnabled(true);
    await oracle.setKeeper(keeper.address, true);
    await oracle.forceSetPrice(BTC, usd(50_000));
    await market.listMarket(BTC, 10, usd(1_000_000), 10);
    // allow bigger signed moves for the gap in this test
    await oracle.setSignedPriceParams(3000, 60);

    await kusdt.mint(lp.address, usd(100_000));
    await kusdt.mint(trader.address, usd(50_000));
    await kusdt.connect(lp).approve(await pool.getAddress(), ethers.MaxUint256);
    await kusdt.connect(trader).approve(await market.getAddress(), ethers.MaxUint256);
    await pool.connect(lp).deposit(usd(100_000));

    // trader opens a 10x long at 50k
    await market.connect(trader).increasePosition(BTC, true, usd(1_000), usd(10_000));

    return { admin, lp, trader, liquidator, keeper, kusdt, oracle, pool, market };
  }

  async function signPrice(oracle: any, keeper: any, price: bigint, ts: number) {
    const domain = {
      name: "XKubPriceOracle", version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await oracle.getAddress(),
    };
    const types = { Price: [
      { name: "marketId", type: "bytes32" }, { name: "price", type: "uint256" }, { name: "timestamp", type: "uint256" },
    ] };
    return keeper.signTypedData(domain, types, { marketId: BTC, price, timestamp: ts });
  }

  it("liquidates on a gap using a keeper-signed fresh price (permissionless)", async () => {
    const { market, oracle, trader, liquidator, keeper } = await loadFixture(fixture);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    // BTC gaps down ~12% → the 10x long is underwater; oracle still shows 50k
    const gapPrice = usd(44_000);
    const sig = await signPrice(oracle, keeper, gapPrice, now);

    expect(await market.isLiquidatable(trader.address, BTC, true)).to.equal(false); // stale oracle
    await market.connect(liquidator).liquidateWithSignedPrice(trader.address, BTC, true, gapPrice, now, sig);
    expect((await market.getPosition(trader.address, BTC, true)).sizeUsd).to.equal(0n); // liquidated
    expect((await oracle.peekPrice(BTC)).price).to.equal(gapPrice); // price updated in the same tx
  });

  it("rejects a non-keeper signature and a stale timestamp", async () => {
    const { market, oracle, trader, liquidator } = await loadFixture(fixture);
    const stranger = ethers.Wallet.createRandom();
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const bad = await signPrice(oracle, stranger, usd(44_000), now);
    await expect(market.connect(liquidator).liquidateWithSignedPrice(trader.address, BTC, true, usd(44_000), now, bad))
      .to.be.revertedWith("!keeper sig");

    const { keeper } = await loadFixture(fixture);
    const oldTs = now - 120; // older than maxSignedAge
    const staleSig = await signPrice(oracle, keeper, usd(44_000), oldTs);
    await expect(market.connect(liquidator).liquidateWithSignedPrice(trader.address, BTC, true, usd(44_000), oldTs, staleSig))
      .to.be.revertedWith("stale sig");
  });

  it("caps a single signed move (anti-compromised-keeper)", async () => {
    const { oracle, keeper } = await loadFixture(fixture);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const crazy = usd(100_000); // +100% from 50k, over the 30% signed cap
    const sig = await signPrice(oracle, keeper, crazy, now);
    await expect(oracle.applySignedPrice(BTC, crazy, now, sig)).to.be.revertedWith("signed deviation too high");
  });
});
