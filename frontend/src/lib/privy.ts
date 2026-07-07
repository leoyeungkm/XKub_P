// Privy is optional: set NEXT_PUBLIC_PRIVY_APP_ID (frontend/.env.local) to
// enable email/social login with silent-signing embedded wallets. Without it
// the app falls back to plain injected-wallet (MetaMask/OKX) mode.
export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
export const PRIVY_ENABLED = PRIVY_APP_ID.length > 0;
