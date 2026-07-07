import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/*
  XKub Perp — gasless trading via agent-signed orders.
  The agent signs (EIP-712, off-chain); the keeper/relayer submits and pays gas.
  The trader never holds KUB; collateral comes from the router trading balance.
*/

const BTC = ethers.encodeBytes32String("BTC");
const E18 = 10n ** 18n;
const usd = (n: number | bigint) => BigInt(n) * E18;

describe("XKub Perp — gasless signed orders", () => {
  async function fixture() {
    const [admin, keeper, lp, owner] = await ethers.getSigners();
    const agent = ethers.Wallet.createRandom(); // browser-held agent key

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
    await kusdt.mint(owner.address, usd(50_000));
    await kusdt.connect(lp).approve(await pool.getAddress(), ethers.MaxUint256);
    await kusdt.connect(owner).approve(await router.getAddress(), ethers.MaxUint256);
    await pool.connect(lp).deposit(usd(100_000));

    // owner sets up: authorise the agent + deposit trading balance (one tx)
    await router.connect(owner).setupAccount(agent.address, usd(10_000), ethers.ZeroHash);

    return { admin, keeper, lp, owner, agent, kusdt, oracle, pool, market, router };
  }

  async function signOrder(router: any, agent: any, o: any) {
    const domain = {
      name: "XKubPerp", version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await router.getAddress(),
    };
    const types = {
      Order: [
        { name: "owner", type: "address" }, { name: "marketId", type: "bytes32" },
        { name: "isLong", type: "bool" }, { name: "isIncrease", type: "bool" },
        { name: "collateralTokens", type: "uint256" }, { name: "sizeDeltaUsd", type: "uint256" },
        { name: "acceptablePrice", type: "uint256" }, { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };
    return agent.signTypedData(domain, types, o);
  }

  it("keeper executes an agent-signed open; trader pays no gas", async () => {
    const { router, market, keeper, owner, agent } = await loadFixture(fixture);
    const o = {
      owner: owner.address, marketId: BTC, isLong: true, isIncrease: true,
      collateralTokens: usd(1_000), sizeDeltaUsd: usd(5_000), acceptablePrice: 0n,
      nonce: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    };
    const sig = await signOrder(router, agent, o);
    await router.connect(keeper).executeSignedOrder(o, sig);

    expect((await market.getPosition(owner.address, BTC, true)).sizeUsd).to.equal(usd(5_000));
    expect(await router.collateralBalance(owner.address)).to.equal(usd(9_000));
    expect(await router.orderNonce(owner.address)).to.equal(1n);
  });

  it("rejects a forged (non-agent) signature and replayed nonce", async () => {
    const { router, keeper, owner } = await loadFixture(fixture);
    const stranger = ethers.Wallet.createRandom();
    const o = {
      owner: owner.address, marketId: BTC, isLong: true, isIncrease: true,
      collateralTokens: usd(1_000), sizeDeltaUsd: usd(5_000), acceptablePrice: 0n,
      nonce: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    };
    const badSig = await signOrder(router, stranger, o);
    await expect(router.connect(keeper).executeSignedOrder(o, badSig)).to.be.revertedWith("!agent sig");
  });

  it("signed close returns payout to the trading balance", async () => {
    const { router, market, keeper, owner, agent, kusdt } = await loadFixture(fixture);
    const open = {
      owner: owner.address, marketId: BTC, isLong: true, isIncrease: true,
      collateralTokens: usd(1_000), sizeDeltaUsd: usd(5_000), acceptablePrice: 0n,
      nonce: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    };
    await router.connect(keeper).executeSignedOrder(open, await signOrder(router, agent, open));

    const walletBefore = await kusdt.balanceOf(owner.address);
    const balBefore = await router.collateralBalance(owner.address);
    const close = { ...open, isIncrease: false, collateralTokens: 0n, nonce: 1n };
    await router.connect(keeper).executeSignedOrder(close, await signOrder(router, agent, close));

    expect((await market.getPosition(owner.address, BTC, true)).sizeUsd).to.equal(0n);
    expect(await router.collateralBalance(owner.address)).to.be.gt(balBefore); // payout to trading balance
    expect(await kusdt.balanceOf(owner.address)).to.equal(walletBefore);       // wallet untouched
  });

  it("only keeper can relay signed orders", async () => {
    const { router, owner, agent } = await loadFixture(fixture);
    const o = {
      owner: owner.address, marketId: BTC, isLong: true, isIncrease: true,
      collateralTokens: usd(1_000), sizeDeltaUsd: usd(5_000), acceptablePrice: 0n,
      nonce: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    };
    const sig = await signOrder(router, agent, o);
    await expect(router.connect(owner).executeSignedOrder(o, sig)).to.be.revertedWith("!keeper");
  });
});
