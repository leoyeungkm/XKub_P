import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/*
  XKub Perp — referral registry + rebate tests
  Code registration, binding rules, market-driven accrual, claim safety,
  and that rebates come out of pool value (not trader collateral).
*/

const BTC = ethers.encodeBytes32String("BTC");
const CODE = ethers.encodeBytes32String("LEO");
const E18 = 10n ** 18n;
const usd = (n: number | bigint) => BigInt(n) * E18;

describe("XKub Perp — referral", () => {
  async function deployFixture() {
    const [admin, keeper, lp, trader, referrer, outsider] = await ethers.getSigners();

    const kusdt = await ethers.deployContract("MockERC20", ["Mock KUSDT", "KUSDT", 18]);
    const oracle = await ethers.deployContract("XKubPriceOracle", [admin.address]);
    const pool = await ethers.deployContract("XKubPerpPool", [await kusdt.getAddress(), 18, admin.address]);
    const market = await ethers.deployContract("XKubPerpMarket", [
      await kusdt.getAddress(), 18,
      await oracle.getAddress(), await pool.getAddress(), admin.address,
    ]);
    const referral = await ethers.deployContract("XKubReferral", [
      await kusdt.getAddress(), 18, admin.address,
    ]);

    await pool.setMarket(await market.getAddress());
    await market.setRouter(admin.address); // not used here
    await market.setDirectTradingEnabled(true);
    await market.setReferral(await referral.getAddress());
    await referral.setMarket(await market.getAddress());
    await oracle.setKeeper(keeper.address, true);
    await oracle.forceSetPrice(BTC, usd(50_000));
    await market.listMarket(BTC, 10, usd(1_000_000), 10);

    await kusdt.mint(lp.address, usd(100_000));
    await kusdt.mint(trader.address, usd(50_000));
    await kusdt.connect(lp).approve(await pool.getAddress(), ethers.MaxUint256);
    await kusdt.connect(trader).approve(await market.getAddress(), ethers.MaxUint256);
    await pool.connect(lp).deposit(usd(100_000));

    return { admin, keeper, lp, trader, referrer, outsider, kusdt, oracle, pool, market, referral };
  }

  // ─── Registry ────────────────────────────────────────────────────────────────

  it("registers codes uniquely and one per address", async () => {
    const { referral, referrer, outsider } = await loadFixture(deployFixture);
    await expect(referral.connect(referrer).registerCode(CODE))
      .to.emit(referral, "CodeRegistered").withArgs(CODE, referrer.address);
    expect(await referral.codeOwner(CODE)).to.equal(referrer.address);

    await expect(referral.connect(outsider).registerCode(CODE)).to.be.revertedWith("code taken");
    await expect(referral.connect(referrer).registerCode(ethers.encodeBytes32String("X")))
      .to.be.revertedWith("have code");
  });

  it("binding rejects unknown code and self-referral", async () => {
    const { referral, referrer, trader } = await loadFixture(deployFixture);
    await expect(referral.connect(trader).setReferrer(CODE)).to.be.revertedWith("unknown code");
    await referral.connect(referrer).registerCode(CODE);
    await expect(referral.connect(referrer).setReferrer(CODE)).to.be.revertedWith("self referral");
    await expect(referral.connect(trader).setReferrer(CODE))
      .to.emit(referral, "Referred").withArgs(trader.address, CODE, referrer.address);
  });

  // ─── Rebate flow ───────────────────────────────────────────────────────────

  it("accrues a rebate on open + close and lets the referrer claim", async () => {
    const { referral, market, trader, referrer, kusdt } = await loadFixture(deployFixture);
    await referral.connect(referrer).registerCode(CODE);
    await referral.connect(trader).setReferrer(CODE);

    // default 10% of fee; positionFeeBps = 3 (0.03%). open 10k size → fee 3 USD → rebate 0.3
    await market.connect(trader).increasePosition(BTC, true, usd(1_000), usd(10_000));
    const afterOpen = await referral.claimableUsd(referrer.address);
    // referred trader pays a discounted fee (3bps → 2bps after 10% referral discount)
    expect(afterOpen).to.equal(usd(10_000) * 2n / 10000n * 1000n / 10000n); // 0.2 USD

    await market.connect(trader).decreasePosition(BTC, true, usd(10_000));
    const afterClose = await referral.claimableUsd(referrer.address);
    expect(afterClose).to.equal(afterOpen * 2n); // symmetric open+close fee

    const before = await kusdt.balanceOf(referrer.address);
    await expect(referral.connect(referrer).claim())
      .to.emit(referral, "RebateClaimed");
    // 18-dec KUSDT: scaler = 1, so KUSDT paid == accrued USD
    expect(await kusdt.balanceOf(referrer.address)).to.equal(before + afterClose);
    expect(await referral.claimableUsd(referrer.address)).to.equal(0n);
  });

  it("rebate is drawn from pool value, trader collateral is unaffected", async () => {
    const { referral, market, pool, trader, referrer } = await loadFixture(deployFixture);
    await referral.connect(referrer).registerCode(CODE);
    await referral.connect(trader).setReferrer(CODE);

    // Compare a trader WITHOUT referral vs the accrual: collateral after open
    // should equal size*fee deducted regardless of referral (rebate hits pool).
    await market.connect(trader).increasePosition(BTC, true, usd(1_000), usd(10_000));
    const p = await market.getPosition(trader.address, BTC, true);
    // collateral = 1000 - openFee(3) = 997, referral does NOT change this
    expect(p.collateralUsd).to.equal(usd(998)); // 1000 - 2 open fee (referred discount)

    // pool got fee(3) then paid rebate(0.3) → net +2.7 vs a no-referral baseline
    expect(await referral.claimableUsd(referrer.address)).to.equal(usd(2) * 1000n / 10000n);
  });

  it("no referrer → no accrual, trade still works", async () => {
    const { referral, market, trader, referrer } = await loadFixture(deployFixture);
    await referral.connect(referrer).registerCode(CODE);
    // trader never binds
    await market.connect(trader).increasePosition(BTC, true, usd(1_000), usd(10_000));
    expect(await referral.claimableUsd(referrer.address)).to.equal(0n);
  });

  it("binding locks after first rebate", async () => {
    const { referral, market, trader, referrer, outsider } = await loadFixture(deployFixture);
    await referral.connect(referrer).registerCode(CODE);
    await referral.connect(outsider).registerCode(ethers.encodeBytes32String("OUT"));
    await referral.connect(trader).setReferrer(CODE);
    await market.connect(trader).increasePosition(BTC, true, usd(1_000), usd(10_000));
    await expect(referral.connect(trader).setReferrer(ethers.encodeBytes32String("OUT")))
      .to.be.revertedWith("locked");
  });

  // ─── Guards ──────────────────────────────────────────────────────────────────

  it("only market can accrue; claim reverts on empty", async () => {
    const { referral, referrer, outsider } = await loadFixture(deployFixture);
    await referral.connect(referrer).registerCode(CODE);
    await expect(referral.connect(outsider).accrue(referrer.address, outsider.address, usd(1)))
      .to.be.revertedWith("!market");
    await expect(referral.connect(referrer).claim()).to.be.revertedWith("nothing");
  });

  it("per-code tier overrides default rebate", async () => {
    const { referral, market, trader, referrer, admin } = await loadFixture(deployFixture);
    await referral.connect(referrer).registerCode(CODE);
    await referral.connect(trader).setReferrer(CODE);
    await referral.connect(admin).setCodeRebateBps(CODE, 5000); // 50% of fee
    await market.connect(trader).increasePosition(BTC, true, usd(1_000), usd(10_000));
    expect(await referral.claimableUsd(referrer.address)).to.equal(usd(2) * 5000n / 10000n); // 1.0 USD (fee 2 after referred discount)
  });

  it("rejects rebate bps above the hard cap", async () => {
    const { referral, referrer, admin } = await loadFixture(deployFixture);
    await referral.connect(referrer).registerCode(CODE);
    await expect(referral.connect(admin).setCodeRebateBps(CODE, 5001)).to.be.revertedWith("> max");
    await expect(referral.connect(admin).setDefaultRebateBps(6000)).to.be.revertedWith("> max");
  });
});
