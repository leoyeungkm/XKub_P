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
import * as http from "http";
import * as fs from "fs";
import * as path from "path";

const E18 = 10n ** 18n;
const INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS ?? "15000");
const RELAYER_PORT = Number(process.env.RELAYER_PORT ?? "8799");

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

// Median of the valid (>0) samples — resistant to any single exchange being
// down, stale, or manipulated. Even count → mean of the two middle values.
function median(xs: number[]): number {
  const a = xs.filter((x) => x > 0 && Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Fetch one number from a URL, returning NaN on any failure so one bad source
// never sinks the whole round.
async function pick(url: string, get: (j: any) => number): Promise<number> {
  try { return get(await fetchJson(url)); } catch { return NaN; }
}

async function fetchPrices(): Promise<Record<Sym, number>> {
  // BTC/ETH: median across deep global venues + Bitkub (manipulation-resistant).
  // KUB: only trades on Bitkub, so it's inherently single-source.
  const [
    bnB, bnE, okxB, okxE, bybitB, bybitE, bkB, bkE, kubThb, usdtThb,
  ] = await Promise.all([
    pick("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", (j) => Number(j.price)),
    pick("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT", (j) => Number(j.price)),
    pick("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT", (j) => Number(j?.data?.[0]?.last)),
    pick("https://www.okx.com/api/v5/market/ticker?instId=ETH-USDT", (j) => Number(j?.data?.[0]?.last)),
    pick("https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT", (j) => Number(j?.result?.list?.[0]?.lastPrice)),
    pick("https://api.bybit.com/v5/market/tickers?category=spot&symbol=ETHUSDT", (j) => Number(j?.result?.list?.[0]?.lastPrice)),
    pick("https://api.bitkub.com/api/v3/market/ticker?sym=BTC_THB", (j) => Number(j?.[0]?.last)),
    pick("https://api.bitkub.com/api/v3/market/ticker?sym=ETH_THB", (j) => Number(j?.[0]?.last)),
    pick("https://api.bitkub.com/api/v3/market/ticker?sym=KUB_THB", (j) => Number(j?.[0]?.last)),
    pick("https://api.bitkub.com/api/v3/market/ticker?sym=USDT_THB", (j) => Number(j?.[0]?.last)),
  ]);
  // Convert Bitkub THB quotes to USD via USDT_THB.
  const usdt = usdtThb; // THB per USDT
  const bkBtcUsd = usdt > 0 ? bkB / usdt : NaN;
  const bkEthUsd = usdt > 0 ? bkE / usdt : NaN;

  const BTC = median([bnB, okxB, bybitB, bkBtcUsd]);
  const ETH = median([bnE, okxE, bybitE, bkEthUsd]);
  const KUB = usdt > 0 ? kubThb / usdt : NaN;
  if (!(BTC > 0) || !(ETH > 0) || !(KUB > 0)) throw new Error("price sources: no valid quotes");
  return { BTC, ETH, KUB };
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

// Latest off-chain CEX prices — served to the frontend at /prices so the UI
// ticker moves even when we're not posting on-chain.
let latestPrices: Record<Sym, number> | null = null;

const DEVIATION_BPS = 20;    // post if CEX moved ≥0.2% from the on-chain price
const HEARTBEAT_MS  = 60000; // ...or at least this often while there's activity
let lastPostAt = 0;

/** Post prices ONLY when needed: there must be a pending order or open position
 *  (otherwise nobody needs a fresh price), and the price must have moved past
 *  the deviation band or the heartbeat elapsed. Idle → zero gas. */
async function maybePushPrices(oracle: any, router: any, market: any, maxDeviationBps: bigint) {
  const prices = await fetchPrices(); // free, off-chain
  latestPrices = prices;

  const hasPending = (await router.getPendingRequests(1)).length > 0;
  const hasPositions = (await market.openPositionCount()) > 0n;
  if (!hasPending && !hasPositions) {
    console.log(`[${now()}] idle — no on-chain post (0 gas)`);
    return; // nobody needs a fresh price
  }

  const ids: string[] = [];
  const values: bigint[] = [];
  let deviated = false;
  for (const sym of MARKETS) {
    const id = ethers.encodeBytes32String(sym);
    const [last] = await oracle.peekPrice(id);
    const cex = toWei(prices[sym]);
    if (last === 0n || (last > 0n && (cex > last ? cex - last : last - cex) * 10000n / last >= BigInt(DEVIATION_BPS))) {
      deviated = true;
    }
    ids.push(id);
    values.push(step(last, cex, maxDeviationBps));
  }

  const heartbeat = Date.now() - lastPostAt >= HEARTBEAT_MS;
  if (!hasPending && !deviated && !heartbeat) {
    return; // positions open but price stable and within heartbeat — skip
  }

  await (await oracle.setPrices(ids, values)).wait();
  lastPostAt = Date.now();
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

async function executeTriggers(router: any, oracle: any, market: any) {
  const count: bigint = await market.openPositionCount();
  const PAGE = 100n;
  for (let offset = 0n; offset < count; offset += PAGE) {
    const [, metas] = await market.getOpenPositions(offset, PAGE);
    for (const m of metas) {
      try {
        const key = ethers.solidityPackedKeccak256(
          ["address", "bytes32", "bool"], [m.owner, m.marketId, m.isLong]);
        const t = await router.triggers(key);
        if (!t.active) continue;
        const [price] = await oracle.peekPrice(m.marketId);
        const tpHit = t.tpPrice > 0n && (m.isLong ? price >= t.tpPrice : price <= t.tpPrice);
        const slHit = t.slPrice > 0n && (m.isLong ? price <= t.slPrice : price >= t.slPrice);
        if (!tpHit && !slHit) continue;
        const tx = await router.executeTrigger(m.owner, m.marketId, m.isLong);
        await tx.wait();
        console.log(`[${now()}] ${tpHit ? "TP" : "SL"} closed ${m.owner} ${ethers.decodeBytes32String(m.marketId)} ${m.isLong ? "long" : "short"}`);
      } catch (e: any) {
        console.error(`[${now()}] trigger exec failed: ${e.message ?? e}`);
      }
    }
  }
}

async function liquidateUnderwater(oracle: any, market: any, keeperSigner: any) {
  const count: bigint = await market.openPositionCount();
  const PAGE = 100n;
  for (let offset = 0n; offset < count; offset += PAGE) {
    const [, metas, flags] = await market.getOpenPositions(offset, PAGE);
    for (let i = 0; i < flags.length; i++) {
      if (!flags[i]) continue;
      const m = metas[i];
      try {
        // Bundle a fresh keeper-signed price with the liquidation so gap moves
        // are caught immediately (minimal bad debt) without a separate post.
        const sym = ethers.decodeBytes32String(m.marketId) as Sym;
        const cex = latestPrices?.[sym];
        if (cex && cex > 0) {
          const ts = Math.floor(Date.now() / 1000);
          const price = toWei(cex);
          const sig = await signPrice(oracle, keeperSigner, m.marketId, price, ts);
          const tx = await market.liquidateWithSignedPrice(m.owner, m.marketId, m.isLong, price, ts, sig);
          await tx.wait();
        } else {
          const tx = await market.liquidate(m.owner, m.marketId, m.isLong);
          await tx.wait();
        }
        console.log(`[${now()}] liquidated ${m.owner} ${ethers.decodeBytes32String(m.marketId)} ${m.isLong ? "long" : "short"}`);
      } catch (e: any) {
        console.error(`[${now()}] liquidate failed: ${e.message ?? e}`);
      }
    }
  }
}

// EIP-712 sign a fresh price with the keeper key (for signed-price liquidation)
async function signPrice(oracle: any, signer: any, marketId: string, price: bigint, timestamp: number): Promise<string> {
  const net = await ethers.provider.getNetwork();
  const domain = { name: "XKubPriceOracle", version: "1", chainId: net.chainId, verifyingContract: await oracle.getAddress() };
  const types = { Price: [
    { name: "marketId", type: "bytes32" }, { name: "price", type: "uint256" }, { name: "timestamp", type: "uint256" },
  ] };
  return signer.signTypedData(domain, types, { marketId, price, timestamp });
}

// ─── Gasless relayer (HTTP) ────────────────────────────────────────────────────
// Accepts agent-signed orders from the frontend and submits them on-chain,
// paying the gas. The trader never needs KUB. CORS-open for the dapp.
// Post a fresh price for one market right before executing an order. The keeper
// posts conditionally (idle → no post), so the on-chain price can be stale when
// a gasless order arrives; without this, executeSignedOrder reverts "stale price".
async function postFreshPrice(oracle: any, marketId: string, maxDeviationBps: bigint) {
  const prices = latestPrices ?? await fetchPrices();
  latestPrices = prices;
  const sym = ethers.decodeBytes32String(marketId) as Sym;
  const cex = toWei(prices[sym]);
  const [last] = await oracle.peekPrice(marketId);
  const value = step(last, cex, maxDeviationBps);
  await (await oracle.setPrices([marketId], [value])).wait();
  lastPostAt = Date.now();
  console.log(`[${now()}] pre-exec price ${sym}=$${Number(ethers.formatEther(value)).toFixed(sym === "KUB" ? 4 : 0)}`);
}

function startRelayer(router: any, oracle: any, maxDeviationBps: bigint) {
  const submitted = new Set<string>(); // simple in-flight/replay guard
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    // Live CEX prices for the UI ticker (moves even when we're not posting on-chain)
    if (req.method === "GET" && req.url?.startsWith("/prices")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(latestPrices ?? {}));
    }
    if (req.method !== "POST" || !req.url?.startsWith("/order")) { res.writeHead(404); return res.end(); }

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { order, sig } = JSON.parse(body);
        const o = {
          owner: order.owner, marketId: order.marketId, isLong: order.isLong, isIncrease: order.isIncrease,
          collateralTokens: BigInt(order.collateralTokens), sizeDeltaUsd: BigInt(order.sizeDeltaUsd),
          acceptablePrice: BigInt(order.acceptablePrice), nonce: BigInt(order.nonce), deadline: BigInt(order.deadline),
        };
        const key = `${o.owner}-${o.nonce}`;
        if (submitted.has(key)) { res.writeHead(409); return res.end(JSON.stringify({ error: "duplicate" })); }
        submitted.add(key); // in-flight guard; the on-chain nonce is the real replay protection
        try {
          // Refresh the oracle for this market so execution doesn't hit "stale price".
          await postFreshPrice(oracle, o.marketId, maxDeviationBps);
          const tx = await router.executeSignedOrder(o, sig);
          const rcpt = await tx.wait();
          console.log(`[${now()}] relayed ${o.isIncrease ? "open" : "close"} for ${o.owner} #${o.nonce}`);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, txHash: rcpt.hash }));
        } catch (err) {
          submitted.delete(key); // failed → allow retry
          throw err;
        }
      } catch (e: any) {
        console.error(`[${now()}] relay failed: ${e.shortMessage ?? e.message ?? e}`);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.shortMessage ?? e.message ?? String(e) }));
      }
    });
  });
  server.listen(RELAYER_PORT, () => console.log(`Gasless relayer on http://localhost:${RELAYER_PORT}/order`));
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

  startRelayer(router, oracle, maxDeviationBps); // gasless: accept agent-signed orders over HTTP

  // Fast off-chain price refresh (no gas): keeps latestPrices — hence /prices and
  // the UI's live mark/PnL — moving every few seconds, independent of the slower
  // on-chain posting loop below.
  const refreshTicker = async () => {
    try { latestPrices = await fetchPrices(); } catch { /* transient CEX blip */ }
  };
  await refreshTicker();
  setInterval(refreshTicker, 5000);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try { await maybePushPrices(oracle, router, market, maxDeviationBps); }
    catch (e: any) { console.error(`[${now()}] price round failed: ${e.message ?? e}`); }

    try { await executePending(router); }
    catch (e: any) { console.error(`[${now()}] execute round failed: ${e.message ?? e}`); }

    try { await executeTriggers(router, oracle, market); }
    catch (e: any) { console.error(`[${now()}] trigger round failed: ${e.message ?? e}`); }

    try { await liquidateUnderwater(oracle, market, keeper); }
    catch (e: any) { console.error(`[${now()}] liquidation round failed: ${e.message ?? e}`); }

    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
