import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/*
  XKub Perp — VIP fee tiers + protocol revenue split
  Tier discounts reduce the position fee a trader pays; the protocol takes
  a configurable share of the fee, drawn from the pool after the fee lands.
*/

const BTC = ethers.encodeBytes32String("BTC");
const E18 = 10n ** 18n;
const usd = (n: number | bigint) => BigInt(n) * E18;

describe("XKub Perp — fee tiers & protocol split", () => {
  async function deployFixture() {
    const [admin, keeper, lp, trader, treasury] = await ethers.getSigners();

    const kusdt = await ethers.deployContract("MockERC20", ["Mock KUSDT", "KUSDT", 18]);
    const oracle = await ethers.deployContract("XKubPriceOracle", [admin.address]);
    const pool = await ethers.deployContract("XKubPerpPool", [await kusdt.getAddress(), 18, admin.address]);
    const market = await ethers.deployContract("XKubPerpMarket", [
      await kusdt.getAddress(), 18,
      await oracle.getAddress(), await pool.getAddress(), admin.address,
    ]);

    await pool.setMarket(await market.getAddress());
    await market.setRouter(admin.address);
    await market.setDirectTradingEnabled(true);
    await oracle.setKeeper(keeper.address, true);
    await oracle.forceSetPrice(BTC, usd(50_000));
    await market.listMarket(BTC, 10, usd(1_000_000), 10);

    await kusdt.mint(lp.address, usd(100_000));
    await kusdt.mint(trader.address, usd(50_000));
    await kusdt.connect(lp).approve(await pool.getAddress(), ethers.MaxUint256);
    await kusdt.connect(trader).approve(await market.getAddress(), ethers.MaxUint256);
    await pool.connect(lp).deposit(usd(100_000));

    return { admin, keeper, lp, trader, treasury, kusdt, oracle, pool, market };
  }

  // ─── VIP tiers ────────────────────────────────────────────────────────────

  it("default tier pays the full fee", async () => {
    const { market, trader } = await loadFixture(deployFixture);
    expect(await market.effectiveFeeBps(trader.address)).to.equal(3n);
  });

  it("a VIP tier discounts the fee and the trader pays less", async () => {
    const { market, trader, admin } = await loadFixture(deployFixture);
    await market.connect(admin).setTierDiscount(2, 5000); // 50% off
    await market.connect(admin).setFeeTier(trader.address, 2);
    expect(await market.effectiveFeeBps(trader.address)).to.equal(1n); // 3 * 50% floor → 1 bps

    // open 10k size → fee = 10000 * 1bps = 1 USD (vs 3 at full rate)
    await market.connect(trader).increasePosition(BTC, true, usd(1_000), usd(10_000));
    const p = await market.getPosition(trader.address, BTC, true);
    expect(p.collateralUsd).to.equal(usd(999)); // 1000 - 1 fee
  });

  it("batch tier assignment works", async () => {
    const { market, trader, lp, admin } = await loadFixture(deployFixture);
    await market.connect(admin).setFeeTiers([trader.address, lp.address], 3);
    expect(await market.feeTier(trader.address)).to.equal(3);
    expect(await market.feeTier(lp.address)).to.equal(3);
  });

  it("rejects a tier discount at or above 100%", async () => {
    const { market, admin } = await loadFixture(deployFixture);
    await expect(market.connect(admin).setTierDiscount(1, 10000)).to.be.revertedWith("discount < 100%");
  });

  // ─── Protocol split ──────────────────────────────────────────────────────

  it("routes a protocol share of the fee to the treasury", async () => {
    const { market, pool, trader, treasury, kusdt, admin } = await loadFixture(deployFixture);
    await market.connect(admin).setTreasury(treasury.address);
    await market.connect(admin).setProtocolFeeShareBps(3000); // 30% of the fee

    const before = await kusdt.balanceOf(treasury.address);
    // open 10k → fee 3 USD → protocol 30% = 0.9 USD
    await market.connect(trader).increasePosition(BTC, true, usd(1_000), usd(10_000));
    expect(await kusdt.balanceOf(treasury.address)).to.equal(before + usd(3) * 3000n / 10000n);
  });

  it("no protocol cut when treasury unset or share zero", async () => {
    const { market, trader, treasury, kusdt, admin } = await loadFixture(deployFixture);
    // share set but no treasury
    await market.connect(admin).setProtocolFeeShareBps(3000);
    const before = await kusdt.balanceOf(treasury.address);
    await market.connect(trader).increasePosition(BTC, true, usd(1_000), usd(10_000));
    expect(await kusdt.balanceOf(treasury.address)).to.equal(before); // nothing routed
  });

  it("rejects a protocol share above the hard cap", async () => {
    const { market, admin } = await loadFixture(deployFixture);
    await expect(market.connect(admin).setProtocolFeeShareBps(5001)).to.be.revertedWith("> max");
  });

  it("protocol cut comes out of pool value (LPs net fee minus cut)", async () => {
    const { market, pool, trader, treasury, admin } = await loadFixture(deployFixture);
    await market.connect(admin).setTreasury(treasury.address);
    await market.connect(admin).setProtocolFeeShareBps(3000);

    const poolBefore = await pool.poolValueUsd();
    await market.connect(trader).increasePosition(BTC, true, usd(1_000), usd(10_000));
    // pool gained fee(3) then paid protocol(0.9) → net +2.1
    expect(await pool.poolValueUsd()).to.equal(poolBefore + usd(3) - (usd(3) * 3000n / 10000n));
  });

  it("only admin can set tiers, treasury and protocol share", async () => {
    const { market, trader } = await loadFixture(deployFixture);
    await expect(market.connect(trader).setFeeTier(trader.address, 1)).to.be.revertedWith("!admin");
    await expect(market.connect(trader).setTierDiscount(1, 100)).to.be.revertedWith("!admin");
    await expect(market.connect(trader).setTreasury(trader.address)).to.be.revertedWith("!admin");
    await expect(market.connect(trader).setProtocolFeeShareBps(100)).to.be.revertedWith("!admin");
  });

  // ─── Rapid-close LP fee ──────────────────────────────────────────────────

  it("charges an extra 0.01% LP fee when closing within 30s", async () => {
    const { market, trader, kusdt } = await loadFixture(deployFixture);
    await market.connect(trader).increasePosition(BTC, true, usd(2_000), usd(10_000));
    const before = await kusdt.balanceOf(trader.address);
    await market.connect(trader).decreasePosition(BTC, true, usd(10_000)); // immediate close
    const got = (await kusdt.balanceOf(trader.address)) - before;
    // 2000 - openFee(3) - closeFee(3) - rapidFee(1) ≈ 1993
    expect(got).to.be.closeTo(usd(1_993), usd(1) / 2n);
  });

  it("no rapid fee once the window has passed", async () => {
    const { market, trader, kusdt } = await loadFixture(deployFixture);
    await market.connect(trader).increasePosition(BTC, true, usd(2_000), usd(10_000));
    await time.increase(31);
    const before = await kusdt.balanceOf(trader.address);
    await market.connect(trader).decreasePosition(BTC, true, usd(10_000));
    const got = (await kusdt.balanceOf(trader.address)) - before;
    // 2000 - openFee(3) - closeFee(3) - no rapid ≈ 1994
    expect(got).to.be.closeTo(usd(1_994), usd(1) / 2n);
  });

  it("rapid-close fee is admin-tunable within bounds", async () => {
    const { market, admin } = await loadFixture(deployFixture);
    await market.connect(admin).setRapidCloseParams(5, 60);
    expect(await market.rapidCloseFeeBps()).to.equal(5);
    expect(await market.rapidCloseWindow()).to.equal(60);
    await expect(market.connect(admin).setRapidCloseParams(101, 60)).to.be.revertedWith("fee <= 1%");
    await expect(market.connect(admin).setRapidCloseParams(5, 601)).to.be.revertedWith("window <= 10m");
  });
});
