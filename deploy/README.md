# Deploying XKub Perp — public testnet demo

Three pieces: **frontend** (Vercel), **keeper + relayer** (a always-on VPS), and
the **contracts** (already on KUB testnet, chainId 25925). The tricky bit is that
the relayer must be reachable over **HTTPS** from the Vercel frontend.

```
 user browser ──HTTPS──▶ Vercel (Next.js frontend + /api/rpc proxy)
        │                        │
        │ gasless order          │ contract reads (proxied to KUB RPC)
        ▼                        ▼
 HTTPS relayer.yourdomain ──▶ VPS: Caddy ▶ keeper/relayer :8799 ──▶ KUB testnet
```

## 1. Keeper + relayer on a VPS (do this first — you need its URL)

Any small Linux VPS ($5/mo: Hetzner / DigitalOcean / Vultr).

```bash
# on the VPS
git clone https://github.com/leoyeungkm/Xkub.git && cd Xkub
npm ci
printf 'KUB_PRIVATE_KEY=0xYOUR_KEEPER_KEY\nRELAYER_URL=https://relayer.yourdomain.com/order\n' > .env
npm i -g pm2
pm2 start deploy/ecosystem.config.js && pm2 save && pm2 startup   # survives reboots
```

Give it a public HTTPS URL (Caddy = one line + auto-cert):

```bash
# DNS: A record  relayer.yourdomain.com -> VPS_IP
# edit deploy/Caddyfile with your domain, then:
sudo apt install -y caddy   # or: https://caddyserver.com/docs/install
sudo caddy start --config deploy/Caddyfile
# verify:
curl https://relayer.yourdomain.com/prices    # -> {"BTC":...,"ETH":...,"KUB":...}
```

Keep the keeper account funded with testnet KUB (it pays gas for every relayed
order + price post) and the XPLP pool seeded with test KUSDT.

## 2. Point the frontend at the public relayer

Edit `frontend/src/config/deployment.json`:

```json
"relayerUrl": "https://relayer.yourdomain.com/order"
```

(`/prices` is derived from this automatically.) Commit + push.

## 3. Frontend on Vercel

- Import the GitHub repo, set **Root Directory = `frontend`** (framework auto-detects Next.js).
- Env var: `NEXT_PUBLIC_PRIVY_APP_ID` = your Privy app id (add the Vercel domain to the Privy dashboard's allowed origins).
- Deploy. The `/api/rpc` route runs server-side on Vercel and forwards to the KUB
  RPC, so browser reads never hit the chain RPC's CORS directly.

## Checklist before sharing the link
- [ ] `https://relayer.yourdomain.com/prices` returns live prices (HTTPS, valid cert)
- [ ] Keeper account has testnet KUB; XPLP pool has test KUSDT
- [ ] Privy dashboard allows the Vercel domain
- [ ] Faucet works (Header → mint 10k test KUSDT); tell users to also grab testnet
      KUB from the Bitkub testnet faucet for setup/deposit gas
- [ ] Open → see position → TP/SL → close, end-to-end on the live URL

## Notes
- **HTTPS is mandatory** for the relayer — an `http://` relayer is blocked as
  mixed content by the HTTPS frontend.
- KUB has **no EIP-1559** and the RPC's browser CORS is flaky — both already
  handled (legacy txs + the `/api/rpc` proxy). Same on mainnet later.
- For mainnet you'd additionally need: a contract audit, real KUSDT liquidity,
  and split keeper/treasury/deployer keys.
