/* XKub Perp — minimal trading frontend (ethers v6 UMD) */
"use strict";

const CFG = window.XKUB_CONFIG;
const E18 = 10n ** 18n;

// ─── minimal ABIs ────────────────────────────────────────────────────────────
const ORACLE_ABI = [
  "function peekPrice(bytes32) view returns (uint256 price, uint256 updatedAt)",
];
const MARKET_ABI = [
  "function getPosition(address,bytes32,bool) view returns (tuple(uint256 sizeUsd, uint256 sizeTokens, uint256 collateralUsd, uint256 entryBorrowX18))",
  "function getPositionPnl(address,bytes32,bool) view returns (int256)",
  "function positionFeeBps() view returns (uint256)",
  "function maintenanceMarginBps() view returns (uint256)",
  "function getMarketState(bytes32) view returns (uint256 longSizeUsd, uint256 shortSizeUsd, uint256 cumBorrowLongX18, uint256 cumBorrowShortX18, uint256 lastAccrual)",
];
const ROUTER_ABI = [
  "function createIncreaseRequest(bytes32,bool,uint256,uint256,uint256) payable returns (uint256)",
  "function createDecreaseRequest(bytes32,bool,uint256,uint256) payable returns (uint256)",
  "function cancelRequest(uint256)",
  "function minExecutionFee() view returns (uint256)",
  "function requestsCount() view returns (uint256)",
  "function requests(uint256) view returns (address owner, bytes32 marketId, bool isLong, bool isIncrease, uint256 collateralTokens, uint256 sizeDeltaUsd, uint256 acceptablePrice, uint256 executionFee, uint64 createdAt, uint8 status)",
];
const POOL_ABI = [
  "function deposit(uint256) returns (uint256)",
  "function withdraw(uint256) returns (uint256)",
  "function poolValueUsd() view returns (uint256)",
  "function sharePriceUsd() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)", // mock KUSDT only
];

const TV_SYMBOLS = { BTC: "BINANCE:BTCUSDT", ETH: "BINANCE:ETHUSDT", KUB: "BITKUB:KUBTHB" };

// ─── state ───────────────────────────────────────────────────────────────────
let readProvider, provider, signer, account = null;
let oracle, market, router, pool, kusdt;         // read-bound
let oracleW, marketW, routerW, poolW, kusdtW;    // signer-bound (after connect)
let currentMarket = CFG.markets[0].symbol;
let isLong = true;
let minExecFee = 0n;
let lastPrices = {};

const $ = (id) => document.getElementById(id);
const b32 = (s) => ethers.encodeBytes32String(s);
const scaler = 10n ** BigInt(18 - CFG.kusdtDecimals);
const usdToToken = (usd1e18) => usd1e18 / scaler;

const fmtUsd = (x, dp = 2) =>
  Number(ethers.formatEther(x)).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtPrice = (x) => {
  const n = Number(ethers.formatEther(x));
  return n >= 100 ? n.toLocaleString(undefined, { maximumFractionDigits: 1 })
       : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
};

function toast(msg, cls = "") {
  const el = document.createElement("div");
  el.className = `toast ${cls}`;
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

// ─── setup ───────────────────────────────────────────────────────────────────
function bindRead() {
  readProvider = new ethers.JsonRpcProvider(CFG.rpcUrl);
  oracle = new ethers.Contract(CFG.addresses.XKubPriceOracle, ORACLE_ABI, readProvider);
  market = new ethers.Contract(CFG.addresses.XKubPerpMarket, MARKET_ABI, readProvider);
  router = new ethers.Contract(CFG.addresses.XKubPerpRouter, ROUTER_ABI, readProvider);
  pool   = new ethers.Contract(CFG.addresses.XKubPerpPool, POOL_ABI, readProvider);
  kusdt  = new ethers.Contract(CFG.addresses.KUSDT, ERC20_ABI, readProvider);
}

async function connect() {
  if (!window.ethereum) { toast("No wallet found — install MetaMask", "err"); return; }
  provider = new ethers.BrowserProvider(window.ethereum);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CFG.chainId) {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + CFG.chainId.toString(16) }],
      });
    } catch (e) {
      if (e.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: "0x" + CFG.chainId.toString(16),
            chainName: CFG.chainName,
            rpcUrls: [CFG.rpcUrl],
            nativeCurrency: { name: "KUB", symbol: "KUB", decimals: 18 },
            blockExplorerUrls: CFG.explorer ? [CFG.explorer] : [],
          }],
        });
      } else { toast("Wrong network", "err"); return; }
    }
    provider = new ethers.BrowserProvider(window.ethereum);
  }
  signer = await provider.getSigner();
  account = await signer.getAddress();
  marketW = market.connect(signer);
  routerW = router.connect(signer);
  poolW   = pool.connect(signer);
  kusdtW  = kusdt.connect(signer);
  $("connectBtn").textContent = account.slice(0, 6) + "…" + account.slice(-4);
  $("connectBtn").classList.add("connected");
  refresh();
}

async function ensureAllowance(spender, amountTokens) {
  const allowance = await kusdt.allowance(account, spender);
  if (allowance < amountTokens) {
    toast("Approving KUSDT…");
    const tx = await kusdtW.approve(spender, ethers.MaxUint256);
    await tx.wait();
  }
}

// ─── UI: markets ─────────────────────────────────────────────────────────────
function renderTabs() {
  const wrap = $("marketTabs");
  wrap.innerHTML = "";
  for (const m of CFG.markets) {
    const btn = document.createElement("button");
    btn.className = "mkt-tab" + (m.symbol === currentMarket ? " active" : "");
    btn.textContent = `${m.symbol}-PERP`;
    btn.onclick = () => { currentMarket = m.symbol; onMarketChange(); };
    wrap.appendChild(btn);
  }
}

function onMarketChange() {
  renderTabs();
  const cfg = CFG.markets.find((m) => m.symbol === currentMarket);
  const slider = $("levSlider");
  slider.max = cfg.maxLeverageX;
  if (Number(slider.value) > cfg.maxLeverageX) slider.value = cfg.maxLeverageX;
  $("levMax").textContent = cfg.maxLeverageX + "x";
  $("chartWrap").innerHTML =
    `<iframe src="https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(TV_SYMBOLS[currentMarket])}` +
    `&interval=15&theme=dark&style=1&hidesidetoolbar=1&hidetoptoolbar=0&saveimage=0" allowtransparency="true"></iframe>`;
  updateTradeSummary();
  refresh();
}

// ─── UI: trade panel ─────────────────────────────────────────────────────────
function setSide(long) {
  isLong = long;
  $("tabLong").classList.toggle("active", long);
  $("tabShort").classList.toggle("active", !long);
  const btn = $("submitBtn");
  btn.className = long ? "long" : "short";
  updateTradeSummary();
}

function tradeInputs() {
  const collateral = Number($("collateralInput").value || "0");
  const lev = Number($("levSlider").value);
  return { collateral, lev, sizeUsd: collateral * lev };
}

function updateTradeSummary() {
  const { collateral, lev, sizeUsd } = tradeInputs();
  const price = lastPrices[currentMarket];
  $("levLabel").textContent = lev + "x";
  $("submitBtn").textContent = `${isLong ? "Long" : "Short"} ${currentMarket}`;
  $("sumSize").textContent = sizeUsd ? `${sizeUsd.toLocaleString()} USD` : "—";
  $("sumEntry").textContent = price ? `$${fmtPrice(price)}` : "—";
  $("sumFee").textContent = sizeUsd ? `${(sizeUsd * 0.001).toFixed(2)} KUSDT` : "—";
  $("sumExecFee").textContent = minExecFee ? `${ethers.formatEther(minExecFee)} KUB` : "—";
  if (price && collateral > 0 && lev > 0) {
    // liq when loss ≈ collateral - maintenance(1% of size): Δp/p = (1/lev - 0.01)
    const move = 1 / lev - 0.01;
    const p = Number(ethers.formatEther(price));
    const liq = isLong ? p * (1 - move) : p * (1 + move);
    $("sumLiq").textContent = `$${liq.toLocaleString(undefined, { maximumFractionDigits: liq >= 100 ? 1 : 4 })}`;
  } else {
    $("sumLiq").textContent = "—";
  }
}

async function submitOrder() {
  if (!account) { toast("Connect wallet first", "err"); return; }
  const { collateral, sizeUsd } = tradeInputs();
  if (!(collateral > 0)) { toast("Enter collateral", "err"); return; }

  const collateralUsd = ethers.parseEther(String(collateral));
  const collateralTokens = usdToToken(collateralUsd);
  const sizeUsd18 = ethers.parseEther(String(sizeUsd));
  const slippageBps = BigInt($("slippageSel").value);
  const price = lastPrices[currentMarket] ?? 0n;
  let acceptable = 0n;
  if (slippageBps > 0n && price > 0n) {
    acceptable = isLong
      ? price + (price * slippageBps) / 10000n
      : price - (price * slippageBps) / 10000n;
  }

  try {
    await ensureAllowance(CFG.addresses.XKubPerpRouter, collateralTokens);
    toast("Submitting order…");
    const tx = await routerW.createIncreaseRequest(
      b32(currentMarket), isLong, collateralTokens, sizeUsd18, acceptable,
      { value: minExecFee });
    await tx.wait();
    toast(`Order queued — keeper will execute at next fresh price`, "ok");
    $("collateralInput").value = "";
    refresh();
  } catch (e) {
    toast(errMsg(e), "err");
  }
}

async function closePosition(sym, long, sizeUsd) {
  const slippageBps = 100n; // 1% bound on closes
  const price = lastPrices[sym] ?? 0n;
  let acceptable = 0n;
  if (price > 0n) {
    acceptable = long
      ? price - (price * slippageBps) / 10000n
      : price + (price * slippageBps) / 10000n;
  }
  try {
    toast("Submitting close…");
    const tx = await routerW.createDecreaseRequest(b32(sym), long, sizeUsd, acceptable, { value: minExecFee });
    await tx.wait();
    toast("Close queued", "ok");
    refresh();
  } catch (e) { toast(errMsg(e), "err"); }
}

// ─── UI: refresh loops ───────────────────────────────────────────────────────
async function refreshPrices() {
  for (const m of CFG.markets) {
    try {
      const [price] = await oracle.peekPrice(b32(m.symbol));
      lastPrices[m.symbol] = price;
    } catch { /* ignore */ }
  }
  const p = lastPrices[currentMarket];
  $("mktPrice").textContent = p ? `$${fmtPrice(p)}` : "—";
  try {
    const ms = await market.getMarketState(b32(currentMarket));
    $("mktMeta").innerHTML =
      `Long OI: ${fmtUsd(ms.longSizeUsd, 0)} · Short OI: ${fmtUsd(ms.shortSizeUsd, 0)}`;
  } catch { /* ignore */ }
  updateTradeSummary();
}

async function refreshPositions() {
  const body = $("positionsBody");
  if (!account) { body.innerHTML = ""; $("positionsEmpty").style.display = ""; return; }
  const rows = [];
  for (const m of CFG.markets) {
    for (const long of [true, false]) {
      const p = await market.getPosition(account, b32(m.symbol), long);
      if (p.sizeUsd === 0n) continue;
      const pnl = await market.getPositionPnl(account, b32(m.symbol), long);
      const entry = (p.sizeUsd * E18) / p.sizeTokens;
      const mark = lastPrices[m.symbol] ?? 0n;
      const pnlCls = pnl >= 0n ? "pos" : "neg";
      rows.push(`<tr>
        <td>${m.symbol}-PERP</td>
        <td class="${long ? "pos" : "neg"}">${long ? "Long" : "Short"}</td>
        <td>${fmtUsd(p.sizeUsd, 0)} USD</td>
        <td>${fmtUsd(p.collateralUsd)} </td>
        <td>$${fmtPrice(entry)}</td>
        <td>$${mark ? fmtPrice(mark) : "—"}</td>
        <td class="${pnlCls}">${pnl >= 0n ? "+" : ""}${fmtUsd(pnl)}</td>
        <td><button class="tbl-btn" onclick="window._close('${m.symbol}',${long},'${p.sizeUsd}')">Close</button></td>
      </tr>`);
    }
  }
  body.innerHTML = rows.join("");
  $("positionsEmpty").style.display = rows.length ? "none" : "";
}

async function refreshRequests() {
  const body = $("requestsBody");
  if (!account) { body.innerHTML = ""; $("requestsEmpty").style.display = ""; return; }
  const count = await router.requestsCount();
  const rows = [];
  const start = count > 30n ? count - 30n : 0n;
  for (let i = count - 1n; i >= start && i >= 0n; i--) {
    const r = await router.requests(i);
    if (r.owner.toLowerCase() !== account.toLowerCase()) continue;
    if (r.status !== 0n) continue; // pending only
    const sym = ethers.decodeBytes32String(r.marketId);
    rows.push(`<tr>
      <td>${i}</td>
      <td>${r.isIncrease ? "Open" : "Close"}</td>
      <td>${sym}-PERP</td>
      <td class="${r.isLong ? "pos" : "neg"}">${r.isLong ? "Long" : "Short"}</td>
      <td>${fmtUsd(r.sizeDeltaUsd, 0)} USD</td>
      <td>Pending</td>
      <td><button class="tbl-btn" onclick="window._cancel('${i}')">Cancel</button></td>
    </tr>`);
    if (i === 0n) break;
  }
  body.innerHTML = rows.join("");
  $("requestsEmpty").style.display = rows.length ? "none" : "";
}

async function refreshEarn() {
  try {
    const [pv, sp] = await Promise.all([pool.poolValueUsd(), pool.sharePriceUsd()]);
    $("poolValue").textContent = `${fmtUsd(pv, 0)} USD`;
    $("plpPrice").textContent = `$${Number(ethers.formatEther(sp)).toFixed(4)}`;
    if (account) {
      const bal = await pool.balanceOf(account);
      $("myPlp").textContent = fmtUsd(bal);
      $("myPlpValue").textContent = `${fmtUsd((bal * sp) / E18)} USD`;
      const kbal = await kusdt.balanceOf(account);
      $("maxBtn").textContent = `Balance: ${fmtUsd(kbal * scaler)}`;
      $("maxBtn").dataset.bal = ethers.formatEther(kbal * scaler);
    }
  } catch { /* ignore */ }
}

async function refresh() {
  await refreshPrices();
  await Promise.all([refreshPositions(), refreshRequests(), refreshEarn()]);
}

// ─── LP actions ──────────────────────────────────────────────────────────────
async function lpDeposit() {
  if (!account) { toast("Connect wallet first", "err"); return; }
  const amt = Number($("lpAmount").value || "0");
  if (!(amt > 0)) { toast("Enter amount", "err"); return; }
  const tokens = usdToToken(ethers.parseEther(String(amt)));
  try {
    await ensureAllowance(CFG.addresses.XKubPerpPool, tokens);
    const tx = await poolW.deposit(tokens);
    await tx.wait();
    toast("Deposited", "ok");
    refresh();
  } catch (e) { toast(errMsg(e), "err"); }
}

async function lpWithdraw() {
  if (!account) { toast("Connect wallet first", "err"); return; }
  const amt = Number($("lpAmount").value || "0");
  if (!(amt > 0)) { toast("Enter XPLP amount", "err"); return; }
  try {
    const tx = await poolW.withdraw(ethers.parseEther(String(amt)));
    await tx.wait();
    toast("Withdrawn", "ok");
    refresh();
  } catch (e) { toast(errMsg(e), "err"); }
}

async function faucet() {
  if (!account) { toast("Connect wallet first", "err"); return; }
  try {
    const tx = await kusdtW.mint(account, usdToToken(ethers.parseEther("10000")));
    await tx.wait();
    toast("Minted 10,000 test KUSDT", "ok");
    refresh();
  } catch (e) { toast("Mint failed — mainnet KUSDT has no faucet", "err"); }
}

function errMsg(e) {
  const m = e?.reason ?? e?.shortMessage ?? e?.message ?? String(e);
  return m.length > 140 ? m.slice(0, 140) + "…" : m;
}

// ─── wire up ─────────────────────────────────────────────────────────────────
window._close = (sym, long, size) => closePosition(sym, long, BigInt(size));
window._cancel = async (id) => {
  try {
    const tx = await routerW.cancelRequest(BigInt(id));
    await tx.wait();
    toast("Cancelled + refunded", "ok");
    refresh();
  } catch (e) { toast(errMsg(e), "err"); }
};

$("connectBtn").onclick = connect;
$("faucetBtn").onclick = faucet;
$("tabLong").onclick = () => setSide(true);
$("tabShort").onclick = () => setSide(false);
$("levSlider").oninput = updateTradeSummary;
$("collateralInput").oninput = updateTradeSummary;
$("slippageSel").onchange = updateTradeSummary;
$("submitBtn").onclick = submitOrder;
$("lpDepositBtn").onclick = lpDeposit;
$("lpWithdrawBtn").onclick = lpWithdraw;
$("maxBtn").onclick = () => {
  const bal = $("maxBtn").dataset.bal;
  if (bal) { $("collateralInput").value = Math.floor(Number(bal) * 100) / 100; updateTradeSummary(); }
};

$("netTag").textContent = `${CFG.chainName} · chain ${CFG.chainId}`;
bindRead();
renderTabs();
onMarketChange();
router.minExecutionFee().then((f) => { minExecFee = f; updateTradeSummary(); });
setInterval(refreshPrices, 5000);
setInterval(() => { if (account) { refreshPositions(); refreshRequests(); refreshEarn(); } }, 8000);
