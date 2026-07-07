# XKub

DeFi protocol suite for **KUB Chain (Bitkub Chain)** — the centrepiece is **XKub Perp**,
a GMX-style perpetual futures protocol with an LP pool as counterparty, two-step
anti-front-run execution, and one-click trading.

> ⚠️ Testnet-stage software. Not audited. Do not use with real funds.

## XKub Perp

Synthetic perps settled in KUSDT. LPs deposit into a pool (XPLP shares) and act as
the counterparty to all trades; traders take isolated-margin long/short positions
against a keeper-posted oracle price.

### Architecture (`src/perp/`)

| Contract | Role |
|---|---|
| `XKubPriceOracle` | Keeper-whitelisted price feed; per-update deviation cap (5%), staleness check, admin force-set |
| `XKubPerpPool` | KUSDT LP pool (XPLP shares); OI reserve guard; 15-min withdraw cooldown (follows XPLP transfers) |
| `XKubPerpMarket` | Isolated margin positions; hourly borrow fee by side utilisation; profit cap (900%); liquidation with keeper reward |
| `XKubPerpRouter` | **Two-step execution**: users queue requests (collateral escrowed + native execution fee), keepers fill at the next fresh price; out-of-bound / expired / reverting requests auto-cancel with refund |

**Two-step execution** closes the classic keeper-oracle exploit: nobody can trade
against a price they know is about to change, because users never pick their own fill.

**One-click trading (agent keys, Hyperliquid-style)** — owners deposit KUSDT into a
router-held balance and authorise a browser-generated agent key via `setAgent`. The
agent submits/cancels orders with zero wallet popups but *cannot withdraw*: positions
belong to the owner, close payouts go to the owner's wallet, and `withdrawCollateral`
is owner-only.

### Keeper bot (`scripts/perp-keeper-bot.ts`)

One loop, three duties every 15s:

1. **Prices** — BTC/ETH from Binance spot, KUB from Bitkub (v3 API, `KUB_THB ÷ USDT_THB`),
   walked into the oracle within its deviation cap
2. **Execution** — fills pending router requests
3. **Liquidation** — scans open positions, liquidates flagged ones

### Frontend (`frontend/`)

Next.js 16 + wagmi/viem + Tailwind v4, dark trading UI: market tabs, TradingView chart,
long/short with leverage + slippage bounds, positions/pending tables, XPLP earn panel,
1-Click trading panel.

Optional **Privy** integration (email/Google/wallet login with silent-signing embedded
wallets): set `NEXT_PUBLIC_PRIVY_APP_ID` in `frontend/.env.local` (see
`.env.local.example`). Without it the app runs in plain injected-wallet mode
(MetaMask / OKX).

## Quick start (local)

```bash
npm install
npm --prefix frontend install --legacy-peer-deps

# 1. chain
npx hardhat node

# 2. deploy + smoke test (writes frontend/src/config/deployment.json)
npx hardhat run scripts/deploy-perp-testnet.ts --network localhost

# 3. keeper bot (prices, execution, liquidation)
npx hardhat run scripts/perp-keeper-bot.ts --network localhost

# 4. frontend → http://localhost:5173
npm run frontend
```

Tests (34):

```bash
npm test
```

## KUB testnet

```bash
cp .env.example .env   # fill KUB_PRIVATE_KEY
npm run deploy:perp:testnet
npm run keeper:perp:testnet
```

The deploy script reuses the mock KUSDT at
`0xB16F025234661aFE6Ab43EEEE8e5a688122C3D0c` (open mint, testnet only) and writes the
frontend config automatically.

## Repo layout

```
src/perp/         perp protocol contracts
src/kubchain/     XKub token factory / trading / vault contracts (HypersFun port)
scripts/          deploy scripts + keeper bot
test/             hardhat tests
frontend/         Next.js app
frontend-static/  legacy static frontend (kept for reference)
deployments/      deployment records per network
```

## Mainnet checklist (open)

- Event-driven keeper (CEX websocket + deviation-threshold posting + RPC event subscription)
- Gas onboarding for embedded wallets (deposit watcher + gas drip)
- Vault integration (`getL1AccountValue` hook), limit orders, insurance fund
- Real KUSDT address + decimals, treasury, audit
