"use client";

import { useState } from "react";
import Header from "@/components/Header";
import MarketBar from "@/components/MarketBar";
import Chart from "@/components/Chart";
import TradePanel from "@/components/TradePanel";
import OneClickPanel from "@/components/OneClickPanel";
import PositionsTable from "@/components/PositionsTable";
import RequestsTable from "@/components/RequestsTable";
import EarnPanel from "@/components/EarnPanel";
import { MARKETS } from "@/config/contracts";

export default function Home() {
  const [market, setMarket] = useState(MARKETS[0].symbol);

  return (
    <>
      <Header />
      <MarketBar current={market} onChange={setMarket} />
      <main className="mx-auto grid max-w-[1500px] grid-cols-1 gap-3.5 p-5 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-3.5">
          <Chart symbol={market} />
          <PositionsTable />
          <RequestsTable />
        </div>
        <div className="flex flex-col gap-3.5">
          <TradePanel symbol={market} />
          <OneClickPanel />
          <EarnPanel />
        </div>
      </main>
    </>
  );
}
