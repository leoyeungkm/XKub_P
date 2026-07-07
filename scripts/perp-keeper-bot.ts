/**
 * XKub Perp — combined keeper bot (3 duties per round)
 *
 *   1. PRICE   — read CEX prices, post to XKubPriceOracle
 *                  BTC, ETH — Binance spot (BTCUSDT / ETHUSDT)
 *                  KUB      — Bitkub Exchange (KUB/THB ÷ USDT/THB)
 *                When the real price moved more than the oracle's deviation
 *                cap since the last post, it walks there in capped steps.
 *   2. EXECUTE — execute pending two-step requests on XKubPerpRouter
 *   3. LIQUIDATE — scan open positions on XKubPerpMarket, liquidate any
 *                  flagged by getOpenPositions()
 *
 * Usage:
 *   PERP_DEPLOYMENT=deployments/perp-kubTestnet-XXXX.json \
 *     npx hardhat run scripts/perp-keeper-bot.ts --network kubTestnet
 *
 * Env:
 *   PERP_DEPLOYMENT     — deployment json (default: newest perp-<network>-*.json)
 *   KEEPER_INTERVAL_MS  — round interval (default 15000)
 *   The signer (KUB_PRIVATE_KEY in .env) must be whitelisted on BOTH the
 *   oracle and the router via setKeeper().
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const E18 = 10n ** 18n;
const INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS ?? "15000");

const MARKETS = ["BTC", "ETH", "KUB"] as const;
type Sym = (typeof MARKETS)[number];

// ─── helpers ─────────────────────────────────────────────────────────────────

const now = () => new Date().toISOString();
const toWei = (price: number) => BigInt(Math.round(price * 1e8)) * (E18 / 10n ** 8n);

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function fetchPrices(): Promise<Record<Sym, number>> {
  // Bitkub v3 ticker: sym is BASE_QUOTE (e.g. KUB_THB), returns an array of
  // one object with string-encoded numbers.
  const [btc, eth, kubThb, usdtThb] = await Promise.all([
    fetchJson("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"),
    fetchJson("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT"),
    fetchJson("https://api.bitkub.com/api/v3/market/ticker?sym=KUB_THB"),
    fetchJson("https://api.bitkub.com/api/v3/market/ticker?sym=USDT_THB"),
  ]);
  const kubLast = Number(kubThb?.[0]?.last);
  const usdtLast = Number(usdtThb?.[0]?.last);
  if (!(kubLast > 0) || !(usdtLast > 0)) throw new Error("Bitkub ticker: bad response");
  return {
    BTC: Number(btc.price),
    ETH: Number(eth.price),
    KUB: kubLast / usdtLast,
  };
}

/** Clamp target into the oracle's allowed deviation band around last. */
function step(last: bigint, target: bigint, maxDeviationBps: bigint): bigint {
  if (last === 0n) return target;
  const maxUp = last + (last * maxDeviationBps) / 10000n;
  const maxDown = last - (last * maxDeviationBps) / 10000n;
  return target > maxUp ? maxUp : target < maxDown ? maxDown : target;
}

function loadDeployment(): any {
  let file = process.env.PERP_DEPLOYMENT;
  if (!file) {
    const dir = path.join(__dirname, "..", "deployments");
    const candidates = fs.readdirSync(dir)
      .filter((f) => f.startsWith(`perp-${network.name}-`) && f.endsWith(".json"))
      .sort();
    if (!candidates.length) throw new Error(`no perp-${network.name}-*.json in deployments/`);
    file = path.join(dir, candidates[candidates.length - 1]);
  }
  console.log(`deployment: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ─── duties ──────────────────────────────────────────────────────────────────

async function pushPrices(oracle: any, maxDeviationBps: bigint) {
  const prices = await fetchPrices();
  const ids: string[] = [];
  const values: bigint[] = [];
  for (const sym of MARKETS) {
    const id = ethers.encodeBytes32String(sym);
    const [last] = await oracle.peekPrice(id);
    ids.push(id);
    values.push(step(last, toWei(prices[sym]), maxDeviationBps));
  }
  await (await oracle.setPrices(ids, values)).wait();
  console.log(`[${now()}] prices: ` +
    MARKETS.map((s, i) => `${s}=$${Number(ethers.formatEther(values[i])).toFixed(s === "KUB" ? 4 : 0)}`).join(" "));
}

async function executePending(router: any) {
  const ids: bigint[] = await router.getPendingRequests(20);
  for (const id of ids) {
    try {
      const tx = await router.executeRequest(id);
      await tx.wait();
      console.log(`[${now()}] executed request #${id}`);
    } catch (e: any) {
      console.error(`[${now()}] execute #${id} failed: ${e.message ?? e}`);
    }
  }
}

async function liquidateUnderwater(market: any) {
  const count: bigint = await market.openPositionCount();
  const PAGE = 100n;
  for (let offset = 0n; offset < count; offset += PAGE) {
    const [, metas, flags] = await market.getOpenPositions(offset, PAGE);
    for (let i = 0; i < flags.length; i++) {
      if (!flags[i]) continue;
      const m = metas[i];
      try {
        const tx = await market.liquidate(m.owner, m.marketId, m.isLong);
        await tx.wait();
        console.log(`[${now()}] liquidated ${m.owner} ${ethers.decodeBytes32String(m.marketId)} ${m.isLong ? "long" : "short"}`);
      } catch (e: any) {
        console.error(`[${now()}] liquidate failed: ${e.message ?? e}`);
      }
    }
  }
}

// ─── main loop ───────────────────────────────────────────────────────────────

async function main() {
  const dep = loadDeployment();
  const [keeper] = await ethers.getSigners();

  const oracle = await ethers.getContractAt("XKubPriceOracle", dep.addresses.XKubPriceOracle);
  const market = await ethers.getContractAt("XKubPerpMarket", dep.addresses.XKubPerpMarket);
  const router = await ethers.getContractAt("XKubPerpRouter", dep.addresses.XKubPerpRouter);

  console.log(`XKub keeper bot — ${keeper.address} on ${network.name}, every ${INTERVAL_MS}ms`);
  if (!(await oracle.isKeeper(keeper.address))) throw new Error("not an oracle keeper — oracle.setKeeper() first");
  if (!(await router.isKeeper(keeper.address))) throw new Error("not a router keeper — router.setKeeper() first");

  // Safety margin below the on-chain cap (race with a second keeper)
  const maxDeviationBps = ((await oracle.maxDeviationBps()) * 9n) / 10n;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await pushPrices(oracle, maxDeviationBps); }
    catch (e: any) { console.error(`[${now()}] price round failed: ${e.message ?? e}`); }

    try { await executePending(router); }
    catch (e: any) { console.error(`[${now()}] execute round failed: ${e.message ?? e}`); }

    try { await liquidateUnderwater(market); }
    catch (e: any) { console.error(`[${now()}] liquidation round failed: ${e.message ?? e}`); }

    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
