import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/*
  XKub Perp — core flow tests
  Oracle guards, LP share pricing, open/close PnL, borrow fees,
  liquidation, OI caps, reserve-guarded withdrawals.
*/

const BTC = ethers.encodeBytes32String("BTC");
const ETH_ID = ethers.encodeBytes32String("ETH");
const E18 = 10n ** 18n;
const usd = (n: number | bigint) => BigInt(n) * E18;

describe("XKub Perp", () => {
  async function deployFixture() {
    const [admin, keeper, lp, trader, liquidator] = await ethers.getSigners();

    const kusdt = await ethers.deployContract("MockERC20", ["Mock KUSDT", "KUSDT", 18]);
    const oracle = await ethers.deployContract("XKubPriceOracle", [admin.address]);
    const pool = await ethers.deployContract("XKubPerpPool", [await kusdt.getAddress(), 18, admin.address]);
    const market = await ethers.deployContract("XKubPerpMarket", [
      await kusdt.getAddress(), 18,
      await oracle.getAddress(), await pool.getAddress(), admin.address,
    ]);

    const router = await ethers.deployContract("XKubPerpRouter", [
      await kusdt.getAddress(), await market.getAddress(),
      await oracle.getAddress(), admin.address,
    ]);

    await pool.setMarket(await market.getAddress());
    await market.setRouter(await router.getAddress());
    await router.setKeeper(keeper.address, true);
    await oracle.setKeeper(keeper.address, true);
    await oracle.forceSetPrice(BTC, usd(50_000));

    // Direct trading for the unit tests below; router flow tested separately
    await market.setDirectTradingEnabled(true);

    // BTC: 10x max leverage, 1M USD OI cap/side, 10bps/h borrow factor
    await market.listMarket(BTC, 10, usd(1_000_000), 10);

    // Fund LP + trader
    await kusdt.mint(lp.address, usd(100_000));
    await kusdt.mint(trader.address, usd(50_000));
    await kusdt.connect(lp).approve(await pool.getAddress(), ethers.MaxUint256);
    await kusdt.connect(trader).approve(await market.getAddress(), ethers.MaxUint256);
    await kusdt.connect(trader).approve(await router.getAddress(), ethers.MaxUint256);

    return { admin, keeper, lp, trader, liquidator, kusdt, oracle, pool, market, router };
  }

  async function fundedFixture() {
    const f = await deployFixture();
    await f.pool.connect(f.lp).deposit(usd(100_000));
    return f;
  }

  // ─── Oracle ────────────────────────────────────────────────────────────────

  describe("XKubPriceOracle", () => {
    it("only keeper can post, deviation capped, admin can force", async () => {
      const { oracle, keeper, trader } = await loadFixture(deployFixture);

      await expect(oracle.connect(trader).setPrices([BTC], [usd(50_500)]))
        .to.be.revertedWith("!keeper");

      await oracle.connect(keeper).setPrices([BTC], [usd(51_000)]); // +2% ok
      expect((await oracle.peekPrice(BTC)).price).to.equal(usd(51_000));

      // > 5% jump rejected
      await expect(oracle.connect(keeper).setPrices([BTC], [usd(60_000)]))
        .to.be.revertedWith("deviation too high");

      // admin force bypasses
      await oracle.forceSetPrice(BTC, usd(60_000));
      expect((await oracle.peekPrice(BTC)).price).to.equal(usd(60_000));
    });

    it("getPrice reverts when stale", async () => {
      const { oracle } = await loadFixture(deployFixture);
      await time.increase(600);
      await expect(oracle.getPrice(BTC, 300)).to.be.revertedWith("stale price");
      await expect(oracle.getPrice(ETH_ID, 300)).to.be.revertedWith("no price");
    });
  });

  // ─── Pool ──────────────────────────────────────────────────────────────────

  describe("XKubPerpPool", () => {
    it("first deposit mints 1:1 (minus locked dead shares), share price starts at 1", async () => {
      const { pool, lp } = await loadFixture(deployFixture);
      const MIN_LIQ = 10n ** 6n; // MINIMUM_LIQUIDITY burned to 0xdEaD
      await pool.connect(lp).deposit(usd(100_000));
      expect(await pool.balanceOf(lp.address)).to.equal(usd(100_000) - MIN_LIQ);
      expect(await pool.sharePriceUsd()).to.equal(E18);
    });

    it("blocks the first-deposit inflation attack", async () => {
      const { pool, kusdt, lp, trader } = await loadFixture(deployFixture);
      // attacker seeds 1 wei then donates a large amount directly to the pool
      await kusdt.mint(trader.address, usd(50_000));
      await kusdt.connect(trader).approve(await pool.getAddress(), ethers.MaxUint256);
      await expect(pool.connect(trader).deposit(1n)).to.be.revertedWith("first deposit too small");

      // an honest first deposit locks dead shares; a later victim is priced fairly
      await pool.connect(lp).deposit(usd(10_000));
      await kusdt.connect(trader).transfer(await pool.getAddress(), usd(40_000)); // donation
      // victim still receives shares proportional to the (now inflated) value, no zero-mint grief
      const before = await pool.balanceOf(trader.address);
      await pool.connect(trader).deposit(usd(10_000));
      expect(await pool.balanceOf(trader.address)).to.be.gt(before);
    });

    it("fees accrue to LPs (share price rises after trader pays fees)", async () => {
      const { pool, market, trader } = await loadFixture(fundedFixture);
      await market.connect(trader).increasePosition(BTC, true, usd(1_000), usd(10_000));
      // open fee = 10 USD flowed to pool
      expect(await pool.sharePriceUsd()).to.be.gt(E18);
    });

    it("withdraw blocked when it would dip into OI reserve", async () => {
      const { pool, market, lp, trader } = await loadFixture(fundedFixture);
      // 100k pool, open 100k OI → reserve = 50k (50%)
      await market.connect(trader).increasePosition(BTC, true, usd(20_000), usd(100_000));
      await time.increase(901); // past withdraw cooldown
      const shares = await pool.balanceOf(lp.address);
      await expect(pool.connect(lp).withdraw(shares)).to.be.revertedWith("reserved for OI");
      // partial withdraw under the reserve line is fine
      await pool.connect(lp).withdraw(shares / 4n);
    });

    it("withdraw cooldown blocks immediate exit and follows XPLP transfers", async () => {
      const { pool, lp, trader } = await loadFixture(fundedFixture);
      const shares = await pool.balanceOf(lp.address);
      await expect(pool.connect(lp).withdraw(shares)).to.be.revertedWith("cooldown");

      // moving shares to a fresh wallet must not dodge the cooldown
      await pool.connect(lp).transfer(trader.address, shares / 2n);
      await expect(pool.connect(trader).withdraw(shares / 2n)).to.be.revertedWith("cooldown");

      await time.increase(901);
      await pool.connect(lp).withdraw(shares / 2n);
      await pool.connect(trader).withdraw(shares / 2n);
    });
  });

  // ─── Trading ───────────────────────────────────────────────────────────────

  describe("open / close", () => {
    it("long profits when price rises; profit paid from pool", async () => {
      const { pool, market, trader, oracle, kusdt } = await loadFixture(fundedFixture);

      // 10,000 USD long at 50k with 1,000 collateral (10x)
      await market.connect(trader).increasePosition(BTC, true, usd(1_000), usd(10_000));

      await oracle.forceSetPrice(BTC, usd(55_000)); // +10%
      const pnl = await market.getPositionPnl(trader.address, BTC, true);
      expect(pnl).to.equal(usd(1_000)); // 10% of 10k

      const before = await kusdt.balanceOf(trader.address);
      await market.connect(trader).decreasePosition(BTC, true, usd(10_000));
      const got = (await kusdt.balanceOf(trader.address)) - before;

      // collateral 997 (after 3 open fee) + 1000 pnl - 3 close fee - tiny borrow fee
      expect(got).to.be.closeTo(usd(1_994), usd(2));
      expect(await market.totalOpenInterestUsd()).to.equal(0);
    });

    it("long loses when price falls; loss stays in pool", async () => {
      const { pool, market, trader, oracle } = await loadFixture(fundedFixture);
      const poolBefore = await pool.poolValueUsd();
      await market.connect(trader).increasePosition(BTC, true, usd(2_000), usd(10_000));

      await oracle.forceSetPrice(BTC, usd(47_500)); // -5% → -500 USD
      await market.connect(trader).decreasePosition(BTC, true, usd(10_000));
      // pool gained ~500 loss + ~6 fees
      expect(await pool.poolValueUsd()).to.be.closeTo(poolBefore + usd(506), usd(2));
    });

    it("short profits when price falls", async () => {
      const { market, trader, oracle, kusdt } = await loadFixture(fundedFixture);
      await market.connect(trader).increasePosition(BTC, false, usd(1_000), usd(10_000));
      await oracle.forceSetPrice(BTC, usd(45_000)); // -10%

      const before = await kusdt.balanceOf(trader.address);
      await market.connect(trader).decreasePosition(BTC, false, usd(10_000));
      const got = (await kusdt.balanceOf(trader.address)) - before;
      expect(got).to.be.closeTo(usd(1_994), usd(2));
    });

    it("partial close realizes proportional pnl and releases collateral", async () => {
      const { market, trader, oracle } = await loadFixture(fundedFixture);
      await market.connect(trader).increasePosition(BTC, true, usd(2_000), usd(10_000));
      await oracle.forceSetPrice(BTC, usd(52_500)); // +5%

      await market.connect(trader).decreasePosition(BTC, true, usd(5_000));
      const p = await market.getPosition(trader.address, BTC, true);
      expect(p.sizeUsd).to.equal(usd(5_000));
      // half of (2000 - 3 open fee) stays
      expect(p.collateralUsd).to.be.closeTo(usd(999), usd(1));
    });

    it("profit capped at maxProfitBps of collateral", async () => {
      const { market, trader, oracle, admin, kusdt } = await loadFixture(fundedFixture);
      // cap profit at 100% of collateral
      await market.connect(admin).setGlobalParams(3, 100, usd(5), 10000, usd(10), 300);
      await market.connect(trader).increasePosition(BTC, true, usd(1_000), usd(10_000));

      await oracle.forceSetPrice(BTC, usd(75_000)); // +50% (admin force)
      const pnlRaw = await market.getPositionPnl(trader.address, BTC, true);
      expect(pnlRaw).to.equal(usd(5_000)); // uncapped view

      // capped at settlement: payout ≈ 997 collateral + 997 capped pnl - 3 fee
      const before = await kusdt.balanceOf(trader.address);
      await market.connect(trader).decreasePosition(BTC, true, usd(10_000));
      const after = await kusdt.balanceOf(trader.address);
      expect(after - before).to.be.closeTo(usd(1_991), usd(2));
    });

    it("enforces leverage, OI cap, min collateral", async () => {
      const { market, trader } = await loadFixture(fundedFixture);
      await expect(market.connect(trader).increasePosition(BTC, true, usd(100), usd(2_000)))
        .to.be.revertedWith("leverage too high");
      await expect(market.connect(trader).increasePosition(BTC, true, usd(5), usd(40)))
        .to.be.revertedWith("collateral < min");
      await expect(market.connect(trader).increasePosition(BTC, true, usd(20_000), usd(1_100_000)))
        .to.be.revertedWith("OI cap");
    });
  });

  // ─── Borrow fees ───────────────────────────────────────────────────────────

  describe("borrow fee", () => {
    it("accrues over time and is deducted from collateral", async () => {
      const { market, trader } = await loadFixture(fundedFixture);
      await market.connect(trader).increasePosition(BTC, true, usd(10_000), usd(100_000));

      await time.increase(24 * 3600); // 1 day
      await market.accrueBorrow(BTC);

      // rate/h = 10bps * (100k OI / ~100k pool) ≈ 0.1%/h → ~2.4%/day on 100k size ≈ 2400 USD
      const p = await market.getPosition(trader.address, BTC, true);
      const pending = usd(10_000) - usd(30) - p.collateralUsd; // still 0 until touch
      expect(pending).to.equal(0n);

      // touch settles it
      await market.connect(trader).increasePosition(BTC, true, usd(1_000), 0);
      const p2 = await market.getPosition(trader.address, BTC, true);
      const fee = usd(10_000) - usd(30) + usd(1_000) - p2.collateralUsd;
      expect(fee).to.be.closeTo(usd(2_400), usd(150));
    });
  });

  // ─── Liquidation ───────────────────────────────────────────────────────────

  describe("liquidation", () => {
    it("healthy position cannot be liquidated; underwater one can", async () => {
      const { market, trader, liquidator, oracle, kusdt } = await loadFixture(fundedFixture);
      // 10x long: entry 50k, collateral 1000, size 10000
      await market.connect(trader).increasePosition(BTC, true, usd(1_000), usd(10_000));

      await expect(market.connect(liquidator).liquidate(trader.address, BTC, true))
        .to.be.revertedWith("not liquidatable");

      // -9% → pnl -900, equity 90 < maintenance 100
      await oracle.forceSetPrice(BTC, usd(47_500));
      await oracle.forceSetPrice(BTC, usd(45_500));
      expect(await market.isLiquidatable(trader.address, BTC, true)).to.equal(true);

      const before = await kusdt.balanceOf(liquidator.address);
      await market.connect(liquidator).liquidate(trader.address, BTC, true);
      expect((await kusdt.balanceOf(liquidator.address)) - before).to.equal(usd(5)); // keeper fee

      const p = await market.getPosition(trader.address, BTC, true);
      expect(p.sizeUsd).to.equal(0n);
      expect(await market.totalOpenInterestUsd()).to.equal(0n);
    });

    it("refunds residual equity to trader above keeper fee", async () => {
      const { market, trader, liquidator, oracle, kusdt } = await loadFixture(fundedFixture);
      await market.connect(trader).increasePosition(BTC, true, usd(1_000), usd(10_000));
      // land equity just under maintenance (100): -9% ≈ pnl -900
      await oracle.forceSetPrice(BTC, usd(47_500));
      await oracle.forceSetPrice(BTC, usd(45_500));

      const before = await kusdt.balanceOf(trader.address);
      await market.connect(liquidator).liquidate(trader.address, BTC, true);
      const refund = (await kusdt.balanceOf(trader.address)) - before;
      // equity ≈ 997 - 900 = 97, minus 5 keeper fee → ~92 back to trader
      expect(refund).to.be.closeTo(usd(92), usd(3));
    });
  });

  // ─── Two-step router (anti-front-run) ──────────────────────────────────────

  describe("router two-step execution", () => {
    const FEE = ethers.parseEther("0.001");

    it("blocks direct trading when disabled", async () => {
      const { market, trader, admin } = await loadFixture(fundedFixture);
      await market.connect(admin).setDirectTradingEnabled(false);
      await expect(market.connect(trader).increasePosition(BTC, true, usd(1_000), usd(10_000)))
        .to.be.revertedWith("use router");
      await expect(market.connect(trader).decreasePosition(BTC, true, usd(1_000)))
        .to.be.revertedWith("use router");
    });

    it("open → keeper executes → close, full round trip through router", async () => {
      const { router, market, trader, keeper, kusdt, oracle } = await loadFixture(fundedFixture);

      await router.connect(trader).createIncreaseRequest(
        BTC, true, usd(1_000), usd(10_000), usd(50_500), { value: FEE });

      const keeperBefore = await ethers.provider.getBalance(keeper.address);
      await router.connect(keeper).executeRequest(0);

      const p = await market.getPosition(trader.address, BTC, true);
      expect(p.sizeUsd).to.equal(usd(10_000));
      // keeper got the execution fee (minus its own gas)
      expect(await ethers.provider.getBalance(keeper.address)).to.be.gt(keeperBefore - FEE);

      await oracle.forceSetPrice(BTC, usd(55_000));
      const before = await kusdt.balanceOf(trader.address);
      await router.connect(trader).createDecreaseRequest(BTC, true, usd(10_000), usd(54_000), { value: FEE });
      await router.connect(keeper).executeRequest(1);

      // payout went to the trader, not the keeper/router
      expect((await kusdt.balanceOf(trader.address)) - before).to.be.closeTo(usd(1_994), usd(2));
      expect((await market.getPosition(trader.address, BTC, true)).sizeUsd).to.equal(0n);
    });

    it("cancels + refunds when price is outside acceptablePrice", async () => {
      const { router, market, trader, keeper, kusdt, oracle } = await loadFixture(fundedFixture);
      await oracle.forceSetPrice(BTC, usd(51_000));

      const before = await kusdt.balanceOf(trader.address);
      // long open with max acceptable 50,500 — current 51,000 → too expensive
      await router.connect(trader).createIncreaseRequest(
        BTC, true, usd(1_000), usd(10_000), usd(50_500), { value: FEE });
      expect(await kusdt.balanceOf(trader.address)).to.equal(before - usd(1_000)); // escrowed

      await expect(router.connect(keeper).executeRequest(0))
        .to.emit(router, "RequestCancelled");
      expect(await kusdt.balanceOf(trader.address)).to.equal(before); // refunded
      expect((await market.getPosition(trader.address, BTC, true)).sizeUsd).to.equal(0n);
    });

    it("cancels expired requests instead of executing", async () => {
      const { router, trader, keeper, kusdt } = await loadFixture(fundedFixture);
      const before = await kusdt.balanceOf(trader.address);
      await router.connect(trader).createIncreaseRequest(BTC, true, usd(1_000), usd(10_000), 0, { value: FEE });
      await time.increase(301); // > maxExecuteAge
      await expect(router.connect(keeper).executeRequest(0))
        .to.emit(router, "RequestCancelled");
      expect(await kusdt.balanceOf(trader.address)).to.equal(before);
    });

    it("cancels + refunds when the market call reverts (e.g. OI cap)", async () => {
      const { router, trader, keeper, kusdt } = await loadFixture(fundedFixture);
      const before = await kusdt.balanceOf(trader.address);
      // 1.1M size breaches the 1M OI cap → market reverts → router refunds
      await router.connect(trader).createIncreaseRequest(BTC, true, usd(20_000), usd(1_100_000), 0, { value: FEE });
      await expect(router.connect(keeper).executeRequest(0))
        .to.emit(router, "RequestCancelled");
      expect(await kusdt.balanceOf(trader.address)).to.equal(before);
    });

    it("owner can self-cancel after the delay, not before", async () => {
      const { router, trader, kusdt } = await loadFixture(fundedFixture);
      await router.connect(trader).createIncreaseRequest(BTC, true, usd(1_000), usd(10_000), 0, { value: FEE });
      await expect(router.connect(trader).cancelRequest(0)).to.be.revertedWith("too early");
      await time.increase(61);
      const before = await kusdt.balanceOf(trader.address);
      await router.connect(trader).cancelRequest(0);
      expect(await kusdt.balanceOf(trader.address)).to.equal(before + usd(1_000));
    });

    it("only whitelisted keepers can execute; only market's router can call *For", async () => {
      const { router, market, trader } = await loadFixture(fundedFixture);
      await router.connect(trader).createIncreaseRequest(BTC, true, usd(1_000), usd(10_000), 0, { value: FEE });
      await expect(router.connect(trader).executeRequest(0)).to.be.revertedWith("!keeper");
      await expect(market.connect(trader).increasePositionFor(trader.address, BTC, true, 0, usd(1_000)))
        .to.be.revertedWith("!router");
    });
  });

  // ─── Position enumeration (liquidation bot support) ────────────────────────

  describe("open position enumeration", () => {
    it("tracks opens, closes and liquidations", async () => {
      const { market, trader, lp, oracle, kusdt, liquidator } = await loadFixture(fundedFixture);
      await kusdt.mint(lp.address, usd(10_000));
      await kusdt.connect(lp).approve(await market.getAddress(), ethers.MaxUint256);

      await market.connect(trader).increasePosition(BTC, true, usd(1_000), usd(10_000));
      await market.connect(lp).increasePosition(BTC, false, usd(1_000), usd(5_000));
      expect(await market.openPositionCount()).to.equal(2n);

      const [, metas, liq] = await market.getOpenPositions(0, 10);
      expect(metas[0].owner).to.equal(trader.address);
      expect(liq[0]).to.equal(false);

      // close one → count drops
      await market.connect(lp).decreasePosition(BTC, false, usd(5_000));
      expect(await market.openPositionCount()).to.equal(1n);

      // crash → flagged liquidatable → liquidate removes it
      await oracle.forceSetPrice(BTC, usd(47_500));
      await oracle.forceSetPrice(BTC, usd(45_200));
      const [, , liq2] = await market.getOpenPositions(0, 10);
      expect(liq2[0]).to.equal(true);
      await market.connect(liquidator).liquidate(trader.address, BTC, true);
      expect(await market.openPositionCount()).to.equal(0n);
    });
  });

  // ─── Pool valuation ties to trader pnl ─────────────────────────────────────

  describe("pool valuation", () => {
    it("pool value falls as traders profit, rises as they lose", async () => {
      const { pool, market, trader, oracle } = await loadFixture(fundedFixture);
      const v0 = await pool.poolValueUsd();
      await market.connect(trader).increasePosition(BTC, true, usd(5_000), usd(50_000));

      await oracle.forceSetPrice(BTC, usd(52_500)); // traders +5% of 50k = +2500
      expect(await pool.poolValueUsd()).to.be.closeTo(v0 - usd(2_485), usd(60));

      await oracle.forceSetPrice(BTC, usd(50_000));
      await oracle.forceSetPrice(BTC, usd(47_500)); // traders -2500
      expect(await pool.poolValueUsd()).to.be.closeTo(v0 + usd(2_515), usd(60));
    });
  });
});
