import type { Metadata } from "next";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import Providers from "@/components/Providers";
import Header from "@/components/Header";
import OnboardingModal from "@/components/OnboardingModal";
import RefCapture from "@/components/RefCapture";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

// All numeric data (prices, sizes, PnL) is set in mono with tabular figures —
// the defining texture of a trading terminal.
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "XKub Perp — Trade",
  description: "Perpetual futures on Bitkub Chain",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${plexMono.variable}`}>
      <body className="min-h-screen antialiased">
        <Providers>
          <Header />
          {children}
          <OnboardingModal />
          <RefCapture />
        </Providers>
      </body>
    </html>
  );
}
