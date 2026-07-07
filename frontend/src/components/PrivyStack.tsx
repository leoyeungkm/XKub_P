"use client";

// Client-only (imported with next/dynamic ssr:false) — PrivyProvider cannot
// run during static prerender.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider, createConfig } from "@privy-io/wagmi";
import { http } from "wagmi";
import { Toaster } from "react-hot-toast";
import { chain } from "@/config/contracts";
import { PRIVY_APP_ID } from "@/lib/privy";
import { useState, type ReactNode } from "react";

// Privy's wagmi config: same chain, but the connector set is managed by Privy
// (embedded wallets + any external wallet the user logs in with).
const privyWagmiConfig = createConfig({
  chains: [chain],
  transports: { [chain.id]: http(undefined, { batch: true }) },
  batch: { multicall: true }, // aggregate contract reads via Multicall3
});

export default function PrivyStack({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        defaultChain: chain,
        supportedChains: [chain],
        // 'google' requires enabling Google OAuth in the Privy dashboard first;
        // leave it out until configured to avoid a "not allowed" error.
        loginMethods: ["email", "wallet"],
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
          // Silent signing: no Privy confirmation modal per transaction —
          // this is what makes embedded-wallet trading one-click.
          showWalletUIs: false,
        },
        appearance: {
          theme: "dark",
          accentColor: "#4f7cff",
          walletList: ["okx_wallet", "metamask", "detected_wallets", "wallet_connect"],
        },
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={privyWagmiConfig}>
          {children}
          <Toaster
            position="bottom-right"
            toastOptions={{
              style: {
                background: "var(--panel2)",
                color: "var(--fg)",
                border: "1px solid var(--line)",
                fontSize: "13px",
              },
            }}
          />
        </WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
