/**
 * XKub Perp keeper — STANDALONE (plain ethers, no hardhat).
 * Same duties as scripts/perp-keeper-bot.ts but ~80MB RAM so it fits a 512MB
 * host (Render etc). Run:  node scripts/keeper.mjs
 *
 * Env:
 *   KUB_PRIVATE_KEY   keeper signer (whitelisted on oracle + router)   [required]
 *   RPC_URL           default https://rpc-testnet.bitkubchain.io
 *   KEEPER_NETWORK    deployment file network tag (default kubTestnet)
 *   PERP_DEPLOYMENT   explicit deployment json (default newest match)
 *   PORT/RELAYER_PORT relayer HTTP port (default 8799)
 *   KEEPER_INTERVAL_MS round interval (default 15000)
 */
import { ethers } from "ethers";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const E18 = 10n ** 18n;
const INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS ?? "15000");
const RELAYER_PORT = Number(process.env.PORT ?? process.env.RELAYER_PORT ?? "8799");
const RPC = process.env.RPC_URL || "https://rpc-testnet.bitkubchain.io";
const NETWORK = process.env.KEEPER_NETWORK || "kubTestnet";
const MARKETS = ["BTC", "ETH", "KUB"];

const provider = new ethers.JsonRpcProvider(RPC);
const keeper = new ethers.Wallet(process.env.KUB_PRIVATE_KEY, provider);
const abis = JSON.parse(fs.readFileSync(path.join(__dirname, "keeper-abis.json"), "utf8"));

// ── helpers ──────────────────────────────────────────────────────────────────
const now = () => new Date().toISOString();
const toWei = (price) => BigInt(Math.round(price * 1e8)) * (E18 / 10n ** 8n);
let GAS_PRICE = 100n * 10n ** 9n; // refreshed from the chain; legacy (KUB has no EIP-1559)
const TX = () => ({ type: 0, gasPrice: GAS_PRICE });

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}
const median = (xs) => {
  const a = xs.filter((x) => x > 0 && Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
async function pick(url, get) { try { return get(await fetchJson(url)); } catch { return NaN; } }

async function fetchPrices() {
  const [bnB, bnE, okxB, okxE, byB, byE, bkB, bkE, kubThb, usdtThb] = await Promise.all([
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
  const usdt = usdtThb;
  const BTC = median([bnB, okxB, byB, usdt > 0 ? bkB / usdt : NaN]);
  const ETH = median([bnE, okxE, byE, usdt > 0 ? bkE / usdt : NaN]);
  const KUB = usdt > 0 ? kubThb / usdt : NaN;
  if (!(BTC > 0) || !(ETH > 0) || !(KUB > 0)) throw new Error("price sources: no valid quotes");
  return { BTC, ETH, KUB };
}

function step(last, target, maxDeviationBps) {
  if (last === 0n) return target;
  const maxUp = last + (last * maxDeviationBps) / 10000n;
  const maxDown = last - (last * maxDeviationBps) / 10000n;
  return target > maxUp ? maxUp : target < maxDown ? maxDown : target;
}

function loadDeployment() {
  let file = process.env.PERP_DEPLOYMENT;
  if (!file) {
    const dir = path.join(__dirname, "..", "deployments");
    const cands = fs.readdirSync(dir).filter((f) => f.startsWith(`perp-${NETWORK}-`) && f.endsWith(".json")).sort();
    if (!cands.length) throw new Error(`no perp-${NETWORK}-*.json in deployments/`);
    file = path.join(dir, cands[cands.length - 1]);
  }
  console.log(`deployment: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ── duties ───────────────────────────────────────────────────────────────────
let latestPrices = null;
const DEVIATION_BPS = 20;
const HEARTBEAT_MS = 60000;
let lastPostAt = 0;

async function maybePushPrices(oracle, router, market, maxDeviationBps) {
  const prices = await fetchPrices();
  latestPrices = prices;
  const hasPending = (await router.getPendingRequests(1)).length > 0;
  const hasPositions = (await market.openPositionCount()) > 0n;
  if (!hasPending && !hasPositions) { console.log(`[${now()}] idle — no on-chain post (0 gas)`); return; }

  const ids = [], values = [];
  let deviated = false;
  for (const sym of MARKETS) {
    const id = ethers.encodeBytes32String(sym);
    const [last] = await oracle.peekPrice(id);
    const cex = toWei(prices[sym]);
    if (last === 0n || (last > 0n && ((cex > last ? cex - last : last - cex) * 10000n) / last >= BigInt(DEVIATION_BPS))) deviated = true;
    ids.push(id); values.push(step(last, cex, maxDeviationBps));
  }
  const heartbeat = Date.now() - lastPostAt >= HEARTBEAT_MS;
  if (!hasPending && !deviated && !heartbeat) return;
  await (await oracle.setPrices(ids, values, TX())).wait();
  lastPostAt = Date.now();
  console.log(`[${now()}] prices: ` + MARKETS.map((s, i) => `${s}=$${Number(ethers.formatEther(values[i])).toFixed(s === "KUB" ? 4 : 0)}`).join(" "));
}

async function executePending(router) {
  const ids = await router.getPendingRequests(20);
  for (const id of ids) {
    try { await (await router.executeRequest(id, TX())).wait(); console.log(`[${now()}] executed request #${id}`); }
    catch (e) { console.error(`[${now()}] execute #${id} failed: ${e.shortMessage ?? e.message ?? e}`); }
  }
}

async function executeTriggers(router, oracle, market) {
  const count = await market.openPositionCount();
  const PAGE = 100n;
  for (let offset = 0n; offset < count; offset += PAGE) {
    const [, metas] = await market.getOpenPositions(offset, PAGE);
    for (const m of metas) {
      try {
        const key = ethers.solidityPackedKeccak256(["address", "bytes32", "bool"], [m.owner, m.marketId, m.isLong]);
        const t = await router.triggers(key);
        if (!t.active) continue;
        const [price] = await oracle.peekPrice(m.marketId);
        const tpHit = t.tpPrice > 0n && (m.isLong ? price >= t.tpPrice : price <= t.tpPrice);
        const slHit = t.slPrice > 0n && (m.isLong ? price <= t.slPrice : price >= t.slPrice);
        if (!tpHit && !slHit) continue;
        await (await router.executeTrigger(m.owner, m.marketId, m.isLong, TX())).wait();
        console.log(`[${now()}] ${tpHit ? "TP" : "SL"} closed ${m.owner} ${ethers.decodeBytes32String(m.marketId)} ${m.isLong ? "long" : "short"}`);
      } catch (e) { console.error(`[${now()}] trigger exec failed: ${e.shortMessage ?? e.message ?? e}`); }
    }
  }
}

async function liquidateUnderwater(oracle, market) {
  const count = await market.openPositionCount();
  const PAGE = 100n;
  for (let offset = 0n; offset < count; offset += PAGE) {
    const [, metas, flags] = await market.getOpenPositions(offset, PAGE);
    for (let i = 0; i < flags.length; i++) {
      if (!flags[i]) continue;
      const m = metas[i];
      try {
        const sym = ethers.decodeBytes32String(m.marketId);
        const cex = latestPrices?.[sym];
        if (cex && cex > 0) {
          const ts = Math.floor(Date.now() / 1000);
          const price = toWei(cex);
          const sig = await signPrice(oracle, m.marketId, price, ts);
          await (await market.liquidateWithSignedPrice(m.owner, m.marketId, m.isLong, price, ts, sig, TX())).wait();
        } else {
          await (await market.liquidate(m.owner, m.marketId, m.isLong, TX())).wait();
        }
        console.log(`[${now()}] liquidated ${m.owner} ${ethers.decodeBytes32String(m.marketId)} ${m.isLong ? "long" : "short"}`);
      } catch (e) { console.error(`[${now()}] liquidate failed: ${e.shortMessage ?? e.message ?? e}`); }
    }
  }
}

// EIP-712 keeper-signed price (for the one-tx gasless path + signed liquidation).
let priceDomain = null;
const PRICE_TYPES = { Price: [{ name: "marketId", type: "bytes32" }, { name: "price", type: "uint256" }, { name: "timestamp", type: "uint256" }] };
async function signPrice(oracle, marketId, price, timestamp) {
  if (!priceDomain) {
    const net = await provider.getNetwork();
    priceDomain = { name: "XKubPriceOracle", version: "1", chainId: net.chainId, verifyingContract: await oracle.getAddress() };
  }
  return keeper.signTypedData(priceDomain, PRICE_TYPES, { marketId, price, timestamp });
}

async function initPricesToReal(oracle, maxDeviationBps) {
  const prices = await fetchPrices();
  latestPrices = prices;
  for (let iter = 0; iter < 25; iter++) {
    let done = true;
    for (const sym of MARKETS) {
      const id = ethers.encodeBytes32String(sym);
      const [last] = await oracle.peekPrice(id);
      const cex = toWei(prices[sym]);
      const diffBps = last > 0n ? ((cex > last ? cex - last : last - cex) * 10000n) / last : 10000n;
      if (diffBps <= 30n) continue;
      done = false;
      try { await (await oracle.setPrices([id], [step(last, cex, maxDeviationBps)], TX())).wait(); } catch { /* retry next iter */ }
    }
    if (done) break;
  }
  console.log(`[${now()}] oracle prices initialised: ` + MARKETS.map((s) => `${s}=$${Number(prices[s]).toFixed(s === "KUB" ? 4 : 0)}`).join(" "));
}

// ── gasless relayer (HTTP) ─────────────────────────────────────────────────────
function startRelayer(router, oracle, maxDeviationBps) {
  const submitted = new Set();
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    if (req.method === "GET" && req.url?.startsWith("/prices")) {
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(latestPrices ?? {}));
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
        submitted.add(key);
        try {
          const prices = latestPrices ?? await fetchPrices();
          latestPrices = prices;
          const sym = ethers.decodeBytes32String(o.marketId);
          const value = toWei(prices[sym]);
          const ts = Math.floor(Date.now() / 1000) - 3;
          const priceSig = await signPrice(oracle, o.marketId, value, ts);
          const tx = await router.executeSignedOrderWithPrice(o, sig, value, ts, priceSig, TX());
          const rcpt = await tx.wait(1, 40_000);
          if (!rcpt || rcpt.status !== 1) { submitted.delete(key); throw new Error(`execution reverted on-chain (${tx.hash})`); }
          console.log(`[${now()}] relayed ${o.isIncrease ? "open" : "close"} ${sym} for ${o.owner} #${o.nonce} @ $${Number(ethers.formatEther(value)).toFixed(sym === "KUB" ? 4 : 0)} (${tx.hash})`);
          res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, txHash: tx.hash }));
        } catch (err) { submitted.delete(key); throw err; }
      } catch (e) {
        const reason = e.reason ?? e.info?.error?.message ?? e.shortMessage ?? e.message ?? String(e);
        console.error(`[${now()}] relay failed: ${reason}`);
        res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: reason }));
      }
    });
  });
  server.listen(RELAYER_PORT, () => console.log(`Gasless relayer on http://0.0.0.0:${RELAYER_PORT}/order`));
}

// ── main ───────────────────────────────────────────────────────────────────────
async function refreshGasPrice() {
  try { const fd = await provider.getFeeData(); if (fd.gasPrice) GAS_PRICE = fd.gasPrice; } catch { /* keep last */ }
}

async function main() {
  const dep = loadDeployment();
  const oracle = new ethers.Contract(dep.addresses.XKubPriceOracle, abis.oracle, keeper);
  const router = new ethers.Contract(dep.addresses.XKubPerpRouter, abis.router, keeper);
  const market = new ethers.Contract(dep.addresses.XKubPerpMarket, abis.market, keeper);

  console.log(`XKub keeper (standalone) — ${keeper.address} on ${NETWORK}, every ${INTERVAL_MS}ms`);
  await refreshGasPrice();
  if (!(await oracle.isKeeper(keeper.address))) throw new Error("not an oracle keeper — oracle.setKeeper() first");
  if (!(await router.isKeeper(keeper.address))) throw new Error("not a router keeper — router.setKeeper() first");
  const maxDeviationBps = ((await oracle.maxDeviationBps()) * 9n) / 10n;

  const refreshTicker = async () => { try { latestPrices = await fetchPrices(); } catch { /* blip */ } };
  await refreshTicker();
  setInterval(refreshTicker, 5000);
  setInterval(refreshGasPrice, 30_000);

  startRelayer(router, oracle, maxDeviationBps); // bind port early

  try { await initPricesToReal(oracle, maxDeviationBps); }
  catch (e) { console.error(`[${now()}] initPrices skipped: ${e.shortMessage ?? e.message ?? e}`); }

  for (;;) {
    try { await maybePushPrices(oracle, router, market, maxDeviationBps); } catch (e) { console.error(`[${now()}] price round failed: ${e.message ?? e}`); }
    try { await executePending(router); } catch (e) { console.error(`[${now()}] execute round failed: ${e.message ?? e}`); }
    try { await executeTriggers(router, oracle, market); } catch (e) { console.error(`[${now()}] trigger round failed: ${e.message ?? e}`); }
    try { await liquidateUnderwater(oracle, market); } catch (e) { console.error(`[${now()}] liquidation round failed: ${e.message ?? e}`); }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
