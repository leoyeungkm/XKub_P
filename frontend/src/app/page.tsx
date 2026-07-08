"use client";

import { useState } from "react";
import MarketBar from "@/components/MarketBar";
import Chart from "@/components/Chart";
import TradePanel from "@/components/TradePanel";
import ActivityPanel from "@/components/ActivityPanel";
import ResizableColumn from "@/components/ResizableColumn";
import { MARKETS } from "@/config/contracts";

export default function Home() {
  const [market, setMarket] = useState(MARKETS[0].symbol);

  return (
    <>
      <MarketBar current={market} onChange={setMarket} />
      <main className="grid grid-cols-1 gap-2 p-2 xl:grid-cols-[1fr_320px]">
        <ResizableColumn
          chart={(h) => <Chart symbol={market} height={h} />}
          activity={<ActivityPanel />}
        />
        <div className="flex flex-col gap-2">
          <TradePanel symbol={market} />
        </div>
      </main>
    </>
  );
}
