"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { Toaster } from "react-hot-toast";
import dynamic from "next/dynamic";
import { chain } from "@/config/contracts";
import { PRIVY_ENABLED } from "@/lib/privy";
import { useState, type ReactNode } from "react";

// Privy cannot render during static prerender — load it client-side only.
const PrivyStack = dynamic(() => import("./PrivyStack"), { ssr: false });

const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [injected()],
  transports: { [chain.id]: http() },
});

export default function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  if (PRIVY_ENABLED) {
    return <PrivyStack>{children}</PrivyStack>;
  }

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {children}
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: "#171e2c",
              color: "#e6ebf5",
              border: "1px solid #232c3f",
              fontSize: "13px",
            },
          }}
        />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
