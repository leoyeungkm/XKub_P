import type { Metadata } from "next";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import Providers from "@/components/Providers";
import Header from "@/components/Header";
import OnboardingModal from "@/components/OnboardingModal";
import FaucetModal from "@/components/FaucetModal";
import RefCapture from "@/components/RefCapture";
import { LanguageProvider } from "@/lib/i18n";

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

// Render at device width (not zoomed-out desktop) and disable auto-zoom on input
// focus; cover the notch/safe areas on phones.
export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover" as const,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${plexMono.variable}`} suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if((localStorage.getItem('xkub.theme')||'dark')==='light')document.documentElement.classList.add('light')}catch(e){}`,
          }}
        />
        <Providers>
          <LanguageProvider>
            <Header />
            {children}
            <OnboardingModal />
            <FaucetModal />
            <RefCapture />
            {/* clears the fixed mobile bottom nav (its 3rem height + safe-area inset) */}
            <div className="h-[calc(3rem_+_env(safe-area-inset-bottom))] md:hidden" />
          </LanguageProvider>
        </Providers>
      </body>
    </html>
  );
}
