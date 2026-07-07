"use client";

import { useState } from "react";
import MarketBar from "@/components/MarketBar";
import Chart from "@/components/Chart";
import TradePanel from "@/components/TradePanel";
import OneClickPanel from "@/components/OneClickPanel";
import ActivityPanel from "@/components/ActivityPanel";
import EarnPanel from "@/components/EarnPanel";
import { MARKETS } from "@/config/contracts";

export default function Home() {
  const [market, setMarket] = useState(MARKETS[0].symbol);

  return (
    <>
      <MarketBar current={market} onChange={setMarket} />
      <main className="grid grid-cols-1 gap-2.5 p-2.5 xl:grid-cols-[1fr_340px]">
        <div className="flex min-w-0 flex-col gap-2.5">
          <Chart symbol={market} />
          <ActivityPanel />
        </div>
        <div className="flex flex-col gap-2.5">
          <TradePanel symbol={market} />
          <OneClickPanel />
          <EarnPanel />
        </div>
      </main>
    </>
  );
}
