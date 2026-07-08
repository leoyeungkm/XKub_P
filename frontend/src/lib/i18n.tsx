"use client";

// Lightweight i18n (EN / 繁中). Wrap the app in <LanguageProvider>, read strings
// with useT(): const t = useT(); t("trade.buyLong"). Missing keys fall back to
// English, then the key itself, so partial coverage is safe.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Lang = "en" | "zh";
const STORE = "xkub.lang";

const en: Record<string, string> = {
  // nav / common
  "nav.trade": "Trade",
  "nav.portfolio": "Portfolio",
  "nav.earn": "Earn",
  "nav.referral": "Referral",
  "common.deposit": "Deposit",
  "common.disable": "Disable",
  // trade panel
  "trade.buyLong": "Buy / Long",
  "trade.sellShort": "Sell / Short",
  "trade.available": "Available",
  "trade.cost": "Cost",
  "trade.orderSize": "Order Size",
  "trade.max": "Max",
  "trade.orderValue": "Order value",
  "trade.collateral": "Cost (collateral)",
  "trade.estLiq": "Est. liq. price",
  "trade.maxSlippage": "Max slippage",
  "trade.long": "Long",
  "trade.short": "Short",
  "trade.orderSizeUnit": "Order Size unit",
  "trade.submitting": "Submitting…",
  "trade.closeOpposite": "Close the opposite position first",
  "trade.amount": "Amount",
  "trade.tpsl": "TP / SL",
  "trade.none": "None",
  "trade.keeperNote": "Filled by a keeper at the next fresh oracle price for front-run protection. Cancel an unfilled order after 60s.",
  "info.title": "Instrument Info",
  "info.openFee": "Open fee",
  "info.borrowFee": "LP / holding fee (per h)",
  "info.maintenance": "Maintenance margin rate",
  "info.rapidClose": "Rapid-close LP fee",
  "info.execFee": "Execution fee",
  // account
  "acct.title": "Account · Isolated",
  "acct.trading": "Trading balance",
  "acct.wallet": "Wallet",
  "acct.uPnl": "Unrealized PnL",
  "acct.usedMargin": "Used margin",
  "acct.value": "Account value",
  // one-click
  "oc.enabledNote": "1-Click enabled — gas is covered by the platform, no KUB needed. Deposit to your Trading balance to trade.",
  "oc.depositArrow": "Deposit →",
  // activity tabs
  "tab.positions": "Positions",
  "tab.orders": "Open Orders",
  "tab.history": "History",
  "pos.closeMarket": "Market Close",
  "pos.closing": "Closing…",
  "pos.confirming": "Confirming…",
  "pos.closeAll": "Close All",
  "pos.setTpSl": "Set TP/SL",
  // toasts (no "gasless" jargon)
  "toast.orderSubmitted": "Order submitted — fills at the next price",
  "toast.orderQueued": "Order queued — fills at the next price",
  "toast.closeSubmitted": "Close submitted — fills at the next price",
  "toast.closeQueued": "Close queued",
  "toast.relayerRetry": "Network busy — retrying…",
  "toast.relayerDown": "Temporarily unavailable — please try again",
  "toast.enableOneClick": "Set up your trading account first",
  "toast.insufficientTrading": "Insufficient Trading balance — deposit first",
  "toast.connectFirst": "Connect wallet first",
  "toast.enterCollateral": "Enter collateral",
  "toast.closed": "Position closed",
};

const zh: Record<string, string> = {
  "nav.trade": "交易",
  "nav.portfolio": "資產",
  "nav.earn": "賺取",
  "nav.referral": "邀請",
  "common.deposit": "入金",
  "common.disable": "停用",
  "trade.buyLong": "買入 / 做多",
  "trade.sellShort": "賣出 / 做空",
  "trade.available": "可用",
  "trade.cost": "保證金",
  "trade.orderSize": "倉位大小",
  "trade.max": "最大",
  "trade.orderValue": "倉位價值",
  "trade.collateral": "保證金成本",
  "trade.estLiq": "預估強平價",
  "trade.maxSlippage": "最大滑點",
  "trade.long": "做多",
  "trade.short": "做空",
  "trade.orderSizeUnit": "倉位單位",
  "trade.submitting": "提交中…",
  "trade.closeOpposite": "請先平掉反向倉位",
  "trade.amount": "數量",
  "trade.tpsl": "止盈 / 止損",
  "trade.none": "無",
  "trade.keeperNote": "由 keeper 以下一個新報價成交(防搶先跑單)。未成交嘅委託 60 秒後可取消。",
  "info.title": "合約資訊",
  "info.openFee": "開倉費",
  "info.borrowFee": "LP / 持倉費(每小時)",
  "info.maintenance": "維持保證金率",
  "info.rapidClose": "急速平倉 LP 費",
  "info.execFee": "執行費",
  "acct.title": "帳戶 · 逐倉",
  "acct.trading": "交易餘額",
  "acct.wallet": "錢包",
  "acct.uPnl": "未實現盈虧",
  "acct.usedMargin": "已用保證金",
  "acct.value": "帳戶淨值",
  "oc.enabledNote": "一鍵交易已啟用 — 交易 gas 由平台代付,你唔使入 KUB。入金到交易餘額即可交易。",
  "oc.depositArrow": "入金 →",
  "tab.positions": "持有倉位",
  "tab.orders": "當前委託",
  "tab.history": "交易歷史",
  "pos.closeMarket": "市價平倉",
  "pos.closing": "平倉中…",
  "pos.confirming": "確認中…",
  "pos.closeAll": "關閉全部",
  "pos.setTpSl": "設定 TP/SL",
  "toast.orderSubmitted": "已提交委託 — 下一個報價成交",
  "toast.orderQueued": "已排隊委託 — 下一個報價成交",
  "toast.closeSubmitted": "已提交平倉 — 下一個報價成交",
  "toast.closeQueued": "已排隊平倉",
  "toast.relayerRetry": "網絡繁忙 — 重試中…",
  "toast.relayerDown": "暫時未能處理 — 請稍後再試",
  "toast.enableOneClick": "請先完成帳戶設定",
  "toast.insufficientTrading": "交易餘額不足 — 請先入金",
  "toast.connectFirst": "請先連接錢包",
  "toast.enterCollateral": "請輸入保證金",
  "toast.closed": "倉位已平",
};

const dict: Record<Lang, Record<string, string>> = { en, zh };

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (k: string) => string };
const I18nCtx = createContext<Ctx>({ lang: "zh", setLang: () => {}, t: (k) => k });

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("zh");
  useEffect(() => {
    const s = localStorage.getItem(STORE);
    if (s === "en" || s === "zh") setLangState(s);
  }, []);
  const setLang = (l: Lang) => { setLangState(l); try { localStorage.setItem(STORE, l); } catch { /* ignore */ } };
  const t = (k: string) => dict[lang][k] ?? en[k] ?? k;
  return <I18nCtx.Provider value={{ lang, setLang, t }}>{children}</I18nCtx.Provider>;
}

export const useI18n = () => useContext(I18nCtx);
export const useT = () => useContext(I18nCtx).t;

export function LangToggle() {
  const { lang, setLang } = useI18n();
  return (
    <button
      onClick={() => setLang(lang === "en" ? "zh" : "en")}
      className="rounded-md border border-line bg-panel2 px-2.5 py-2 text-[12px] font-medium text-muted transition-colors hover:text-fg"
      title="Language / 語言"
    >
      {lang === "en" ? "中" : "EN"}
    </button>
  );
}
