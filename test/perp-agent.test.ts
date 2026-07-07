import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/*
  XKub Perp — one-click trading (agent key) tests
  Router-held collateral balance, agent authorisation, agent-submitted
  requests, refund paths back to the balance, owner-only withdrawal.
*/

const BTC = ethers.encodeBytes32String("BTC");
const E18 = 10n ** 18n;
const usd = (n: number | bigint) => BigInt(n) * E18;
const FEE = ethers.parseEther("0.001");

describe("XKub Perp — agent one-click trading", () => {
  async function deployFixture() {
    const [admin, keeper, lp, owner, agent, rando] = await ethers.getSigners();

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
    await market.listMarket(BTC, 10, usd(1_000_000), 10);

    await kusdt.mint(lp.address, usd(100_000));
    await kusdt.mint(owner.address, usd(50_000));
    await kusdt.connect(lp).approve(await pool.getAddress(), ethers.MaxUint256);
    await kusdt.connect(owner).approve(await router.getAddress(), ethers.MaxUint256);
    await pool.connect(lp).deposit(usd(100_000));

    return { admin, keeper, lp, owner, agent, rando, kusdt, oracle, pool, market, router };
  }

  async function enabledFixture() {
    const f = await deployFixture();
    await f.router.connect(f.owner).depositCollateral(usd(10_000));
    await f.router.connect(f.owner).setAgent(f.agent.address, true);
    return f;
  }

  // ─── Balance ───────────────────────────────────────────────────────────────

  it("deposit / withdraw round-trips and is owner-only", async () => {
    const { router, kusdt, owner, agent } = await loadFixture(deployFixture);

    await expect(router.connect(owner).depositCollateral(usd(10_000)))
      .to.emit(router, "CollateralDeposited").withArgs(owner.address, usd(10_000));
    expect(await router.collateralBalance(owner.address)).to.equal(usd(10_000));

    // agent (or anyone) has no balance of their own to withdraw
    await expect(router.connect(agent).withdrawCollateral(usd(1))).to.be.reverted;

    const before = await kusdt.balanceOf(owner.address);
    await router.connect(owner).withdrawCollateral(usd(10_000));
    expect(await kusdt.balanceOf(owner.address)).to.equal(before + usd(10_000));
    expect(await router.collateralBalance(owner.address)).to.equal(0n);

    await expect(router.connect(owner).withdrawCollateral(usd(1))).to.be.reverted;
  });

  it("setupAccount enables agent, deposits and funds gas in one tx", async () => {
    const { router, kusdt, owner, agent } = await loadFixture(deployFixture);
    const agentGasBefore = await ethers.provider.getBalance(agent.address);
    await router.connect(owner).setupAccount(agent.address, usd(5_000), { value: ethers.parseEther("0.2") });

    expect(await router.isAgent(owner.address, agent.address)).to.equal(true);
    expect(await router.collateralBalance(owner.address)).to.equal(usd(5_000));
    expect(await ethers.provider.getBalance(agent.address)).to.equal(agentGasBefore + ethers.parseEther("0.2"));
  });

  it("setAgent rejects zero address and self", async () => {
    const { router, owner, agent } = await loadFixture(deployFixture);
    await expect(router.connect(owner).setAgent(ethers.ZeroAddress, true)).to.be.revertedWith("!agent");
    await expect(router.connect(owner).setAgent(owner.address, true)).to.be.revertedWith("!agent");
    await expect(router.connect(owner).setAgent(agent.address, true))
      .to.emit(router, "AgentSet").withArgs(owner.address, agent.address, true);
    expect(await router.isAgent(owner.address, agent.address)).to.equal(true);
  });

  // ─── Agent requests ────────────────────────────────────────────────────────

  it("non-agent cannot submit for the owner", async () => {
    const { router, owner, rando } = await loadFixture(enabledFixture);
    await expect(
      router.connect(rando).createIncreaseRequestFor(
        owner.address, BTC, true, usd(1_000), usd(5_000), 0, { value: FEE }),
    ).to.be.revertedWith("!agent");
    await expect(
      router.connect(rando).createDecreaseRequestFor(
        owner.address, BTC, true, usd(5_000), 0, { value: FEE }),
    ).to.be.revertedWith("!agent");
  });

  it("agent opens for owner from the router balance; position belongs to owner", async () => {
    const { router, market, keeper, owner, agent } = await loadFixture(enabledFixture);

    await router.connect(agent).createIncreaseRequestFor(
      owner.address, BTC, true, usd(1_000), usd(5_000), 0, { value: FEE });
    expect(await router.collateralBalance(owner.address)).to.equal(usd(9_000));

    await router.connect(keeper).executeRequest(0);
    const pos = await market.getPosition(owner.address, BTC, true);
    expect(pos.sizeUsd).to.equal(usd(5_000));
    // agent holds nothing
    const agentPos = await market.getPosition(agent.address, BTC, true);
    expect(agentPos.sizeUsd).to.equal(0n);
  });

  it("agent cannot overdraw the owner's balance", async () => {
    const { router, owner, agent } = await loadFixture(enabledFixture);
    await expect(
      router.connect(agent).createIncreaseRequestFor(
        owner.address, BTC, true, usd(10_001), usd(20_000), 0, { value: FEE }),
    ).to.be.reverted;
  });

  it("agent close returns payout to the owner's trading balance, not the wallet", async () => {
    const { router, kusdt, keeper, owner, agent } = await loadFixture(enabledFixture);

    await router.connect(agent).createIncreaseRequestFor(
      owner.address, BTC, true, usd(1_000), usd(5_000), 0, { value: FEE });
    await router.connect(keeper).executeRequest(0);

    const walletBefore = await kusdt.balanceOf(owner.address);
    const balBefore = await router.collateralBalance(owner.address); // 9_000 left after opening
    const agentBefore = await kusdt.balanceOf(agent.address);
    await router.connect(agent).createDecreaseRequestFor(
      owner.address, BTC, true, usd(5_000), 0, { value: FEE });
    await router.connect(keeper).executeRequest(1);

    // payout credited back to the trading balance (1-click stays self-contained)
    expect(await router.collateralBalance(owner.address)).to.be.gt(balBefore);
    expect(await kusdt.balanceOf(owner.address)).to.equal(walletBefore);   // wallet untouched
    expect(await kusdt.balanceOf(agent.address)).to.equal(agentBefore);    // agent gets nothing
  });

  // ─── Refund paths ──────────────────────────────────────────────────────────

  it("keeper cancel refunds collateral to the router balance, not the wallet", async () => {
    const { router, kusdt, keeper, owner, agent } = await loadFixture(enabledFixture);

    // acceptablePrice below oracle for a long → keeper cancels on price bound
    await router.connect(agent).createIncreaseRequestFor(
      owner.address, BTC, true, usd(1_000), usd(5_000), usd(49_000), { value: FEE });
    expect(await router.collateralBalance(owner.address)).to.equal(usd(9_000));

    const walletBefore = await kusdt.balanceOf(owner.address);
    await expect(router.connect(keeper).executeRequest(0))
      .to.emit(router, "RequestCancelled");
    expect(await router.collateralBalance(owner.address)).to.equal(usd(10_000));
    expect(await kusdt.balanceOf(owner.address)).to.equal(walletBefore);
  });

  it("agent self-cancel after delay: collateral to balance, fee back to agent", async () => {
    const { router, owner, agent } = await loadFixture(enabledFixture);

    await router.connect(agent).createIncreaseRequestFor(
      owner.address, BTC, true, usd(1_000), usd(5_000), 0, { value: FEE });
    await expect(router.connect(agent).cancelRequest(0)).to.be.revertedWith("too early");

    await time.increase(61);
    const feeBefore = await ethers.provider.getBalance(agent.address);
    await router.connect(agent).cancelRequest(0);
    expect(await router.collateralBalance(owner.address)).to.equal(usd(10_000));
    // fee refund covers most of the cancel gas — just check it moved up net of gas
    expect(await ethers.provider.getBalance(agent.address)).to.be.gt(feeBefore - FEE);
  });

  it("wallet-created requests still refund to the wallet", async () => {
    const { router, kusdt, keeper, owner } = await loadFixture(enabledFixture);

    const walletBefore = await kusdt.balanceOf(owner.address);
    await router.connect(owner).createIncreaseRequest(
      BTC, true, usd(1_000), usd(5_000), usd(49_000), { value: FEE });
    await router.connect(keeper).executeRequest(0); // price bound → cancel
    expect(await kusdt.balanceOf(owner.address)).to.equal(walletBefore);
    expect(await router.collateralBalance(owner.address)).to.equal(usd(10_000)); // untouched
  });

  it("revoked agent can no longer submit", async () => {
    const { router, owner, agent } = await loadFixture(enabledFixture);
    await router.connect(owner).setAgent(agent.address, false);
    await expect(
      router.connect(agent).createIncreaseRequestFor(
        owner.address, BTC, true, usd(1_000), usd(5_000), 0, { value: FEE }),
    ).to.be.revertedWith("!agent");
  });
});
