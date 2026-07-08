# XKub Perp — Bitkub Chain 原生永續合約 DEX
### KUB Chain Grant 申請 · 項目機制說明

---

## 一、摘要

**XKub Perp 是 Bitkub Chain 上第一個原生永續合約去中心化交易所**,採用 GMX 式合成永續機制(單一 KUSDT 流動性池作為所有交易者的對手方),配合 Hyperliquid 式的零彈窗、零 Gas 交易體驗。

**項目已完整上線 KUB 測試網並可公開試用**——不是白皮書,是可以即刻落單的產品:

- 前端:https://xkub.vercel.app
- 交易市場:BTC-PERP(40x)、ETH-PERP(25x)、KUB-PERP(10x)
- 全流程實測:註冊 → 領測試幣 → 入金 → 開倉 → 止盈止損 → 平倉,約 5 秒成交

---

## 二、核心機制

### 2.1 合成永續 + XPLP 流動性金庫(GMX v1 模式)

沒有訂單簿。所有交易者的對手方是一個 KUSDT 流動性池(**XPLP**,類同 GMX 的 GLP / Hyperliquid 的 HLP):

- LP 存入 KUSDT 鑄造 XPLP 份額,按淨值(NAV)計價
- 交易者的虧損與全部手續費(開/平倉費、持倉借貸費、清算費、急速平倉費)流入池中,推升 NAV
- 交易者的盈利由池支付;LP 賺取統計優勢與費用,承擔做市風險
- 池設 **儲備係數 50%**(提款須保留足額儲備覆蓋未平倉位)與 **15 分鐘提款冷靜期**(防三明治攻擊,計時按金額加權)

### 2.2 交易流程:零彈窗、零 Gas(平台代付)

用戶體驗是本項目最大差異點。傳統鏈上 perp 每個動作要彈 3–5 次錢包;XKub 只需**一次性設定**,之後全程無彈窗:

1. **一鍵開戶**(一筆交易):`setupAccount` 同時完成——授權代理密鑰(Agent Key)+ 存入交易保證金 + 生成推薦碼
2. **Agent Key**:瀏覽器本地生成的密鑰,合約層面**只能交易、不能提款**(Router 強制),遺失僅需重新授權
3. **下單**:Agent 以 EIP-712 離線簽署訂單 → 提交平台 Relayer → Relayer 代付 Gas 上鏈執行
4. **資金隔離**:交易只動用 Router 託管的「交易餘額」,永不觸碰用戶錢包資產;提款隨時可由用戶本人發起

### 2.3 執行時定價(Execution-time Pricing)——反搶跑設計

用戶訂單**不以下單時的價格成交**,而是由 Keeper 以**執行當刻的新鮮預言機價**成交:

- 單筆原子交易 `executeSignedOrderWithPrice(order, orderSig, price, ts, priceSig)`:同一筆交易內先驗證並應用 Keeper 簽名的即時價格,再執行訂單
- 消除「看到滯後價格再下單」的套利空間——**價格滯後本身無法被利用**,因為成交永遠用執行時的市價
- 實測端到端延遲約 5 秒(KUB L1 出塊 3 秒為物理下限)

### 2.4 預言機:多源中位數 + 按需報價(Pull Oracle)

Bitkub Chain 沒有 Chainlink / Pyth,我們自建了為此鏈度身訂造的預言機:

- **價格源**:BTC/ETH 取 **Binance、OKX、Bybit、Bitkub 四所中位數**(單一交易所被操縱或宕機不影響結算價);KUB 取 Bitkub(唯一現貨市場)經 USDT/THB 換算
- **按需報價,閒置零 Gas**:只在「有待執行訂單」時上鏈報價;持倉監控、止盈止損、清算判斷全部鏈下以即時 CEX 價進行,到達條件才推價執行
- **簽名價格(Pyth 式)**:Keeper 以 EIP-712 簽署即時價,任何人可提交上鏈;合約驗證簽名者白名單、時效(≤30 秒)、偏離上限(≤20%),防止 Keeper 密鑰洩漏時被灌極端價
- **常規報價偏離上限 5%**:單次更新不可跳價超過 5%,大幅波動須分步逼近,加大操縱成本

### 2.5 清算:鏈下監控 + 簽名價原子清算

- Keeper 以即時 CEX 價**鏈下**計算每個倉位的償付能力(免 Gas)
- 倉位瀕臨資不抵債時,呼叫 `liquidateWithSignedPrice`——**清算與新鮮簽名價捆綁在同一筆交易**,即使價格跳空也能以最新市價及時清算,將壞帳減至最小
- 清算函數為 **permissionless**(驗證簽名價而非呼叫者),未來可開放第三方清算人網絡水平擴容

### 2.6 費用結構、VIP 等級與推薦系統

| 項目 | 參數 |
|---|---|
| 開/平倉費 | 0.03%(名義倉位) |
| 持倉費 | 按小時,隨池使用率浮動 |
| 急速平倉費 | 開倉 30 秒內平倉加收 0.01%(全數歸 LP,反刷量) |
| 費用分成 | 70% 歸 XPLP 池 / 30% 歸協議金庫 |

**VIP 等級**(14 天滾動加權交易量,鏈上逐日桶計算):

| 等級 | 14 天交易量 | 手續費折扣 |
|---|---|---|
| VIP 1 | ≥ $50,000 | 10% |
| VIP 2 | ≥ $250,000 | 25% |
| VIP 3 | ≥ $1,000,000 | 50% |

**推薦系統**(全鏈上):註冊推薦碼 → 分享連結(`?ref=CODE` 自動綁定)→ 被推薦人享 10% 手續費折扣,推薦人賺取其手續費 10% 返佣,可隨時鏈上領取。

### 2.7 風險控制參數

| 控制 | 設定 |
|---|---|
| 槓桿上限 | BTC 40x / ETH 25x / KUB 10x |
| 未平倉上限(OI Cap) | BTC $500k / ETH $300k / KUB $100k(可調,設 0 即軟暫停) |
| 單邊持倉 | 同帳戶同市場禁止同時多空(反自成交) |
| 盈利上限 | 單倉最高 300% 保證金(限制跨帳戶對鎖攻擊) |
| 最低保證金 | $10;維持保證金率 1% |
| 首存通脹攻擊防護 | 池鑄造死份額(MINIMUM_LIQUIDITY) |
| 重入防護 | 全部資金路徑 ReentrancyGuard(對照 GMX 2025 年 $42M 重入事故類別) |

---

## 三、系統架構

```
 用戶瀏覽器 ──HTTPS──▶ 前端(Next.js / Vercel)
     │                      │
     │ EIP-712 簽名訂單      │ /api/rpc 代理(雙 RPC 容錯)
     ▼                      ▼
 Keeper + Relayer(Render 常駐)          KUB Chain 測試網
   ├─ W1 報價錢包(oracle keeper)   ──▶  XKubPriceOracle
   ├─ W2 交易中繼池(router keeper)──▶  XKubPerpRouter ──▶ XKubPerpMarket
   ├─ W4 清算錢包(無需授權)       ──▶  XKubPerpMarket      │
   └─ W3 測試幣水龍頭              ──▶  XKubPerpPool(XPLP)◀┘
                                          XKubReferral
```

**角色錢包分離**:報價、交易中繼、清算、水龍頭各用獨立錢包與獨立 nonce 通道——互不阻塞,單一密鑰洩漏影響範圍受限;交易中繼支援多錢包輪替(吞吐 ×N、單筆卡鏈不阻塞後續)。

**針對 KUB Chain 特性的工程適配**(踩坑後沉澱的實戰經驗):
- KUB 無 EIP-1559 → 全部交易強制 Legacy(Type-0)格式,否則節點靜默丟棄
- 公共 RPC 的瀏覽器 CORS 不穩定 → 同源代理 + 雙 RPC 容錯
- 錢包自動加鏈/切鏈(`wallet_addEthereumChain`),新用戶零配置

---

## 四、已上線功能清單(測試網實測)

- ✅ 三市場永續交易,約 5 秒成交,全程零 Gas 零彈窗
- ✅ 止盈/止損(鏈上觸發單,Keeper 到價自動執行)
- ✅ 簽名價清算(跳空行情下即時清算)
- ✅ XPLP 流動性金庫(存取、NAV、冷靜期、儲備)
- ✅ VIP 費率等級 + 全鏈上推薦返佣系統
- ✅ 一鍵開戶 + 內建測試幣水龍頭(email 用戶零門檻上手)
- ✅ 自繪 K 線圖表(Bitkub 數據、USD 計價、疊加進場價/TP/SL/掛單線)
- ✅ 完整中英雙語介面
- ✅ 交易歷史逐筆連結 KubScan 可驗證

## 五、合約地址(KUB 測試網,chainId 25925)

| 合約 | 地址 |
|---|---|
| XKubPerpRouter | `0x0620cAe574afA4AAFaB7B110eaCBf1E024DBD036` |
| XKubPerpMarket | `0xC4AAe01ff758dD4fb9DC05a23Bc081deDBcC7a2e` |
| XKubPriceOracle | `0xe9ae932D4b14B3B59f63F035b8E114815374fD15` |
| XKubPerpPool(XPLP) | `0xb677BB936DB2bA58abCef806c9BAc531c585A67B` |
| XKubReferral | `0xceb43c3055F99c85aA65B3B51C0DaA8fC0cb0a86` |
| 測試 KUSDT | `0xB16F025234661aFE6Ab43EEEE8e5a688122C3D0c` |

合約測試:**74 項全數通過**(倉位引擎、代理授權、推薦、費率、觸發單、Gasless、簽名價)。

---

## 六、為何屬於 Bitkub Chain 生態

1. **填補空白**:KUB Chain 目前沒有原生永續合約 DEX;衍生品是公鏈交易量與費用收入的最大品類
2. **KUB 資產賦能**:KUB-PERP 為 KUB 代幣提供首個鏈上槓桿市場;圖表與 KUB 定價直接採用 Bitkub Exchange 數據
3. **KUSDT 使用場景**:保證金、LP 金庫、手續費全部以 KUSDT 計價結算,為鏈上穩定幣創造真實需求
4. **降低門檻**:email 登入(Privy 嵌入式錢包)+ 平台代付 Gas + 內建水龍頭——非加密原生用戶也能在一分鐘內完成第一筆交易
5. **工程沉澱回饋生態**:針對 KUB Chain 的 Legacy 交易、RPC、錢包適配經驗全部開源,降低後來開發者的踩坑成本

---

## 七、路線圖與 Grant 資金用途

| 階段 | 內容 |
|---|---|
| **短期(1–2 月)** | 智能合約第三方審計(mainnet 前置條件);管理後台(參數治理 + 運維監控);合約加入緊急暫停開關;Admin 多簽化 |
| **中期(2–4 月)** | KUB 主網上線;真實 KUSDT 流動性引導(LP 激勵計劃);更多交易對;第三方清算人網絡 |
| **長期** | KUB L2 部署(3 秒 → 秒級以下報價);限價單/高級訂單類型;移動端優化 |

Grant 資金主要用於:**安全審計、主網流動性引導、與全職開發投入**。

---

## 八、連結

- 產品(測試網):https://xkub.vercel.app
- 源碼:https://github.com/leoyeungkm/Xkub
- Keeper 狀態:https://xkub-keeper.onrender.com/prices
- 區塊瀏覽器:https://testnet.kubscan.com
