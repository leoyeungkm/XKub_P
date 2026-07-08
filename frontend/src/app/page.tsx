"use client";

import { useState } from "react";
import MarketBar from "@/components/MarketBar";
import Chart from "@/components/Chart";
import TradePanel from "@/components/TradePanel";
import ActivityPanel from "@/components/ActivityPanel";
import { MARKETS } from "@/config/contracts";

export default function Home() {
  const [market, setMarket] = useState(MARKETS[0].symbol);

  return (
    <>
      <MarketBar current={market} onChange={setMarket} />
      {/* Mobile: chart → order form → positions (single instances, CSS-ordered).
          Desktop (xl): chart top-left, positions bottom-left, order panel right. */}
      <main className="flex flex-col gap-2 p-2 xl:grid xl:grid-cols-[1fr_340px] xl:items-start">
        <div className="order-1 h-[46vh] min-h-[300px] min-w-0 xl:order-none xl:col-start-1 xl:row-start-1 xl:h-[62vh]">
          <Chart symbol={market} />
        </div>
        <div className="order-2 xl:order-none xl:col-start-2 xl:row-start-1 xl:row-span-2">
          <TradePanel symbol={market} />
        </div>
        <div className="order-3 min-w-0 xl:order-none xl:col-start-1 xl:row-start-2">
          <ActivityPanel />
        </div>
      </main>
    </>
  );
}
