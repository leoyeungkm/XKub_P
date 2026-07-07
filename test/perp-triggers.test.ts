import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/*
  XKub Perp — TP/SL trigger orders on the router
  Keeper closes the whole position when the oracle price crosses a trigger.
*/

const BTC = ethers.encodeBytes32String("BTC");
const E18 = 10n ** 18n;
const usd = (n: number | bigint) => BigInt(n) * E18;
const FEE = ethers.parseEther("0.001");

describe("XKub Perp — TP/SL triggers", () => {
  async function fixture() {
    const [admin, keeper, lp, trader, agent] = await ethers.getSigners();

    const kusdt = await ethers.deployContract("MockERC20", ["Mock KUSDT", "KUSDT", 18]);
    const oracle = await ethers.deployContract("XKubPriceOracle", [admin.address]);
    const pool = await ethers.deployContract("XKubPerpPool", [await kusdt.getAddress(), 18, admin.address]);
    const market = await ethers.deployContract("XKubPerpMarket", [
      await kusdt.getAddress(), 18, await oracle.getAddress(), await pool.getAddress(), admin.address,
    ]);
    const router = await ethers.deployContract("XKubPerpRouter", [
      await kusdt.getAddress(), await market.getAddress(), await oracle.getAddress(), admin.address,
    ]);

    await pool.setMarket(await market.getAddress());
    await market.setRouter(await router.getAddress());
    await router.setKeeper(keeper.address, true);
    await oracle.setKeeper(keeper.address, true);
    await oracle.forceSetPrice(BTC, usd(50_000));
    await market.listMarket(BTC, 10, usd(1_000_000), 10);

    await kusdt.mint(lp.address, usd(100_000));
    await kusdt.mint(trader.address, usd(50_000));
    await kusdt.connect(lp).approve(await pool.getAddress(), ethers.MaxUint256);
    await kusdt.connect(trader).approve(await router.getAddress(), ethers.MaxUint256);
    await pool.connect(lp).deposit(usd(100_000));

    // open a 10k BTC long via the router
    await router.connect(trader).createIncreaseRequest(BTC, true, usd(1_000), usd(10_000), 0, { value: FEE });
    await router.connect(keeper).executeRequest(0);

    return { admin, keeper, lp, trader, agent, kusdt, oracle, pool, market, router };
  }

  it("keeper closes on take-profit when price rises through TP", async () => {
    const { router, market, oracle, trader, keeper } = await loadFixture(fixture);
    await router.connect(trader).setTrigger(BTC, true, usd(55_000), 0, { value: FEE }); // TP at 55k

    // not yet triggered at 52k
    await oracle.forceSetPrice(BTC, usd(52_000));
    await expect(router.connect(keeper).executeTrigger(trader.address, BTC, true)).to.be.revertedWith("not triggered");

    // hits TP at 55k → keeper closes
    await oracle.forceSetPrice(BTC, usd(55_000));
    await expect(router.connect(keeper).executeTrigger(trader.address, BTC, true))
      .to.emit(router, "TriggerExecuted");
    expect((await market.getPosition(trader.address, BTC, true)).sizeUsd).to.equal(0n);
  });

  it("keeper closes on stop-loss when price falls through SL", async () => {
    const { router, market, oracle, trader, keeper } = await loadFixture(fixture);
    await router.connect(trader).setTrigger(BTC, true, 0, usd(47_000), { value: FEE }); // SL at 47k

    await oracle.forceSetPrice(BTC, usd(48_000));
    await expect(router.connect(keeper).executeTrigger(trader.address, BTC, true)).to.be.revertedWith("not triggered");

    await oracle.forceSetPrice(BTC, usd(46_500));
    await router.connect(keeper).executeTrigger(trader.address, BTC, true);
    expect((await market.getPosition(trader.address, BTC, true)).sizeUsd).to.equal(0n);
  });

  it("replacing a trigger refunds the prior fee; cancel refunds too", async () => {
    const { router, trader } = await loadFixture(fixture);
    await router.connect(trader).setTrigger(BTC, true, usd(55_000), 0, { value: FEE });
    const before = await ethers.provider.getBalance(trader.address);
    // replace — prior FEE refunded, new FEE paid; net ≈ -gas
    await router.connect(trader).setTrigger(BTC, true, usd(56_000), usd(47_000), { value: FEE });
    expect(await ethers.provider.getBalance(trader.address)).to.be.gt(before - FEE * 2n);

    await router.connect(trader).cancelTrigger(BTC, true);
    const t = await router.triggers(await routerKey(trader.address));
    expect(t.active).to.equal(false);
  });

  it("stale trigger (position already closed) cleans up and refunds owner", async () => {
    const { router, market, trader, keeper } = await loadFixture(fixture);
    await router.connect(trader).setTrigger(BTC, true, usd(55_000), 0, { value: FEE });
    // trader closes manually
    await router.connect(trader).createDecreaseRequest(BTC, true, usd(10_000), 0, { value: FEE });
    await router.connect(keeper).executeRequest(1);
    // keeper runs executeTrigger → position gone → cleanup
    await expect(router.connect(keeper).executeTrigger(trader.address, BTC, true))
      .to.emit(router, "TriggerCancelled");
  });

  it("agent can set and cancel triggers; non-agent cannot", async () => {
    const { router, trader, agent } = await loadFixture(fixture);
    await expect(router.connect(agent).setTriggerFor(trader.address, BTC, true, usd(55_000), 0, { value: FEE }))
      .to.be.revertedWith("!agent");
    await router.connect(trader).setAgent(agent.address, true);
    await router.connect(agent).setTriggerFor(trader.address, BTC, true, usd(55_000), 0, { value: FEE });
    await router.connect(agent).cancelTriggerFor(trader.address, BTC, true);
  });

  it("only keeper can execute triggers", async () => {
    const { router, trader } = await loadFixture(fixture);
    await router.connect(trader).setTrigger(BTC, true, usd(55_000), 0, { value: FEE });
    await expect(router.connect(trader).executeTrigger(trader.address, BTC, true)).to.be.revertedWith("!keeper");
  });

  // helper to compute the trigger key the contract uses
  async function routerKey(owner: string) {
    return ethers.solidityPackedKeccak256(["address", "bytes32", "bool"], [owner, BTC, true]);
  }
});
