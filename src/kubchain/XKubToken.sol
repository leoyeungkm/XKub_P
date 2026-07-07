// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../v3/individual/HyperFunMath.sol";
import "../v3/individual/HyperFunTokenLib.sol";

/*//////////////////////////////////////////////////////////////
              XKubToken — Core Vault for KUB Chain
//////////////////////////////////////////////////////////////

  FORKED FROM: HyperFunToken.sol (HypersFun on HyperEVM)

  KEY CHANGES FROM HyperFunToken
  --------------------------------
  1. USDC (6 dec) → KUSDT (KAP-20, address + decimals set in initialize)
  2. All Hyperliquid CoreWriter / L1 / precompile code removed
  3. initializeL1 / depositToL1 / executeL1Action / approveBuilderFee → removed
  4. emergencyWithdrawL1SpotToEVM → removed
  5. getL1SpotBalance() → always returns 0 (stub for interface compatibility)
  6. getTotalAssets() → delegates to XKubTrading → SpotNavVault → Diamon reserves
  7. getAvailableLiquidity() → only EVM KUSDT balance (no L1 spot)
  8. approveForTrading() → new: lets trading module approve router for vault tokens
  9. PENDING SELL REMOVED — sell() auto-liquidates held tokens → KUSDT in same tx
     via XKubTrading.liquidateForRedemption(). Immediate settlement, no waiting.

  WHAT IS UNCHANGED
  -----------------
  - buy() / deposit() — same AMM logic
  - NAV (HyperFunMath + HyperFunTokenLib + graduation tiers) — pure EVM, identical
  - TWAP NAV (getSmoothedNAV) — unchanged
  - Performance fee (minted to leader on profit) — unchanged
  - Exit fee tiers (time-based, stays in vault) — unchanged
  - Referral system — unchanged
  - UUPS upgrade (only factory owner) — unchanged

  DECIMAL NOTE
  ------------
  quoteDecimals = 18  →  KUSDT is standard KAP-20 (most likely)
  quoteDecimals = 6   →  KUSDT is bridged Ethereum USDT
  VERIFY on bkcscan before deploying. Wrong value breaks NAV math.
  _toWad() / _fromWad() handle all conversions internally.
*/

interface IXKubTrading {
    function getTotalAssets() external view returns (uint256);
    function autoRebalance() external;
    /// @notice Auto-swap held tokens → KUSDT to cover redemption shortfall
    function liquidateForRedemption(uint256 shortfallNative) external returns (uint256 covered);
}

interface IXKubFactory {
    function owner() external view returns (address);
    function treasury() external view returns (address);
    function getGlobalSettings() external view returns (
        uint256 tradingFeeBps, uint256 maxPremiumBps, uint256 maxDiscountBps,
        uint256 minDepositUsdc, uint256 rebalanceLowBps, uint256 rebalanceHighBps,
        uint256 reserveRatioBps, uint256 minReserveRatioBps
    );
    function getGlobalSettingsExt() external view returns (
        uint256 maxBuyBps, uint256 navVirtualAssets, uint256 navVirtualShares, bool exitFeeEnabled
    );
    struct ExitFeeTier { uint256 daysHeld; uint256 feeBps; }
    function getGlobalExitFeeTiers() external view returns (ExitFeeTier[] memory);
    function getVaultExitFeeTiers(address vault) external view returns (ExitFeeTier[] memory);
    function globalBcVirtualMinimumBps() external view returns (uint256);
    function globalMaxBcRatioBps() external view returns (uint256);
    function getGlobalNavVirtualDynamic() external view returns (uint256, uint256, uint256);
    function getGlobalNavVirtualParams() external view returns (uint256, uint256, uint256, uint256, uint256);
    struct GraduationTier {
        uint256 threshold; uint256 bcVirtual;
        uint256 navMinMulBps; uint256 navMaxMulBps; uint256 squaredRatioBps;
    }
    function getGraduationTiers() external view returns (GraduationTier[] memory);
    function getGraduationTierCount() external view returns (uint256);
    function getGraduationTier(uint256 index) external view returns (
        uint256, uint256, uint256, uint256, uint256
    );
    function isGraduationTieredMode() external view returns (bool);
    function checkFeeDiscount(address wallet) external view returns (bool);
    function checkFeeDiscountBps(address wallet) external view returns (uint256);
    function launchGate() external view returns (address);
    function seedBuyRouter() external view returns (address);
    function referralRegistry() external view returns (address);
    function globalMaxSellPremiumBps() external view returns (uint256);
}

interface IHFReferral {
    function distributeFee(address user, uint256 fee6) external;
    function tryBind(address user, address referrer) external;
}

interface ILaunchGate {
    function canBuy(address vault, address buyer) external view returns (bool);
}

// ─── Custom Errors ────────────────────────────────────────────────────────────
error NotFactoryOwner();
error NotAdmin();
error NotLeader();
error NotTradingModule();
error ContractPaused();
error ZeroTokens();
error InsufficientBalance();
error BelowMinimum();
error SlippageExceeded();
error LiquidityRestricted();
error MaxExceeded();
error GatedLaunch();
error TransferFailed();

/// @title XKubToken — Core Vault with Bonding Curve AMM on KUB Chain
/// @notice x*y=k AMM identical to HyperFunToken; backed by KUB Chain spot tokens via Diamon.
///         Sells always settle immediately — no pending sell queue.
contract XKubToken is
    Initializable, UUPSUpgradeable, OwnableUpgradeable,
    ReentrancyGuardUpgradeable, ERC20Upgradeable
{
    // ============ Constants ============
    uint256 public constant BPS       = 10000;
    uint256 public constant PRECISION = 1e18;
    uint256 public constant MAX_FEE   = 3000; // 30%

    // ============ Structs ============
    struct DepositRecord {
        uint256 depositAmount;
        uint256 depositSharePrice;
    }
    struct EntryRecord {
        uint256 weightedEntryNav;
        uint256 totalTokens;
    }
    struct UserPurchaseInfo {
        uint256 totalTokens;
        uint256 weightedTimestamp;
        uint256 lastPurchaseTime;
    }

    // ============ State Variables ============

    // KUB Chain token config (set in initialize)
    address public kusdt;           // Quote token — KUSDT on KUB Chain
    uint8   public quoteDecimals;   // 18 (KAP-20) or 6 (bridged). VERIFY on bkcscan!

    // Vault identity
    address public leader;
    uint256 public feeBps;
    address public admin;

    // Modules
    address public tradingModule;             // XKubTrading.sol
    address internal _legacyOutcomeTrading;   // deprecated storage slot

    // Bonding curve state
    uint256 public virtualBase;
    uint256 public virtualTokens;
    uint256 public initialAssets;

    // Accounting
    uint256 public totalDeposits;
    uint256 public totalVolume;
    mapping(address => DepositRecord) public depositRecords;

    uint256 public protocolFee;
    bool    public paused;

    // NOTE: pendingSells removed — auto-liquidation replaces the pending sell mechanism.
    //       totalPSUsdc = 0 always (kept as storage slot for potential upgrade compatibility).
    uint256 public totalPSUsdc; // always 0 on KUB

    mapping(address => UserPurchaseInfo) public userPurchaseInfo;

    address public factory;
    string  public metadataURI;

    mapping(address => EntryRecord) public entryRecords;

    // TWAP NAV (V40)
    uint256 public twapNav;
    uint256 public twapNavTime;
    uint256 public twapMaxChangePerMin;

    // Deprecated slot (V70 sell ceiling now from Factory)
    uint256 public _deprecatedMaxSellPremiumBps;

    // ============ Events ============
    event Deposited(address indexed user, uint256 quoteAmount, uint256 shares);
    event TokenBought(address indexed user, uint256 quoteIn, uint256 tokensOut, uint256 price);
    event TokenSold(address indexed user, uint256 tokensIn, uint256 quoteOut, uint256 price);
    event AdminChanged(address indexed oldAdmin, address indexed newAdmin);
    event TradingModuleChanged(address indexed oldModule, address indexed newModule);
    event ExitFeeCharged(address indexed user, uint256 feeAmount, uint256 feeBps, uint256 daysHeld);
    event MetadataUpdated(string newUri);
    event PerformanceFeeMinted(address indexed user, address indexed leader, uint256 feeTokens, uint256 nav);
    event AutoLiquidated(uint256 shortfall, uint256 covered); // emitted when auto-swap covers a sell

    // ============ Modifiers ============
    modifier onlyAdmin()         { if (msg.sender != admin)          revert NotAdmin();          _; }
    modifier onlyLeader()        { if (msg.sender != leader)         revert NotLeader();         _; }
    modifier onlyTradingModule() { if (msg.sender != tradingModule)  revert NotTradingModule();  _; }
    modifier whenNotPaused()     { if (paused)                       revert ContractPaused();    _; }
    modifier onlyFactoryOwner()  {
        if (factory == address(0) ||
            (msg.sender != factory && msg.sender != IXKubFactory(factory).owner()))
            revert NotFactoryOwner();
        _;
    }

    // ============ Settings Helpers ============

    function _getSettings() internal view returns (
        uint256 tradingFeeBps, uint256 maxPremiumBps, uint256 maxDiscountBps,
        uint256 minDepositUsdc, uint256 rebalanceLowBps, uint256 rebalanceHighBps,
        uint256 reserveRatioBps, uint256 minReserveRatioBps
    ) { return IXKubFactory(factory).getGlobalSettings(); }

    function _getSettingsExt() internal view returns (
        uint256 maxBuyBps, uint256 navVirtualAssets, uint256 navVirtualShares, bool exitFeeEnabled
    ) { return IXKubFactory(factory).getGlobalSettingsExt(); }

    // ============ Decimal Scaling ============

    /// @dev Quote native decimals → 1e18 (internal precision)
    function _toWad(uint256 amount) internal view returns (uint256) {
        if (quoteDecimals >= 18) return amount;
        return amount * (10 ** (18 - quoteDecimals));
    }

    /// @dev 1e18 → quote native decimals
    function _fromWad(uint256 amount) internal view returns (uint256) {
        if (quoteDecimals >= 18) return amount;
        return amount / (10 ** (18 - quoteDecimals));
    }

    // ============ Initializer ============

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    /// @param _kusdt          KUSDT address on KUB Chain (verify on bkcscan)
    /// @param _quoteDecimals  18 for KAP-20, 6 for bridged. MUST match actual token.
    function initialize(
        address _leader,
        string  calldata _name,
        string  calldata _symbol,
        uint256 _feeBps,
        address, // _treasury — read from Factory
        address _admin,
        address _tradingModule,
        address _factory,
        uint256 _virtualBase,
        uint256 _virtualTokens,
        uint256 _initialAssets,
        address _kusdt,
        uint8   _quoteDecimals
    ) public initializer {
        require(_leader != address(0), "!leader");
        require(_feeBps <= MAX_FEE, "fee too high");
        require(_admin != address(0), "!admin");
        require(_factory != address(0), "!factory");
        require(_kusdt != address(0), "!kusdt");
        require(_quoteDecimals == 6 || _quoteDecimals == 18, "quoteDecimals: 6 or 18");
        if (_virtualBase == 0 || _virtualTokens == 0 || _initialAssets == 0) revert BelowMinimum();

        __Ownable_init(_admin);
        factory = _factory;
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        __ERC20_init(_name, _symbol);

        leader        = _leader;
        admin         = _admin;
        feeBps        = _feeBps;
        tradingModule = _tradingModule;
        protocolFee   = 100;
        kusdt         = _kusdt;
        quoteDecimals = _quoteDecimals;
        virtualBase   = _virtualBase;
        virtualTokens = _virtualTokens;
        initialAssets = _initialAssets;
        // No L1 initialization — KUB Chain is fully EVM.
    }

    function _authorizeUpgrade(address) internal override {
        if (factory == address(0) || msg.sender != IXKubFactory(factory).owner())
            revert NotFactoryOwner();
    }

    // ============ approveForTrading ============

    /// @notice Grant router approval to pull vault tokens for a Diamon swap.
    ///         Only XKubTrading can call this — preserves slippage guard on all swaps.
    function approveForTrading(address token, address spender, uint256 amount)
        external onlyTradingModule
    {
        IERC20(token).approve(spender, amount);
    }

    // ============ Exit Fee ============

    function calculateExitFee(address user)
        public view returns (uint256 exitFeeBpsResult, uint256 daysHeldResult)
    {
        (, , , bool exitFeeEnabled) = _getSettingsExt();
        IXKubFactory.ExitFeeTier[] memory tiers =
            IXKubFactory(factory).getVaultExitFeeTiers(address(this));
        if (!exitFeeEnabled || tiers.length == 0) return (0, 0);
        UserPurchaseInfo memory info = userPurchaseInfo[user];
        if (info.weightedTimestamp == 0) return (tiers[0].feeBps, 0);
        daysHeldResult   = (block.timestamp - info.weightedTimestamp) / 1 days;
        exitFeeBpsResult = tiers[0].feeBps;
        for (uint256 i = tiers.length; i > 0; i--) {
            if (daysHeldResult >= tiers[i - 1].daysHeld) {
                exitFeeBpsResult = tiers[i - 1].feeBps;
                break;
            }
        }
    }

    function _updatePurchaseInfo(address user, uint256 tokensOut) internal {
        UserPurchaseInfo storage info = userPurchaseInfo[user];
        if (info.totalTokens == 0) {
            info.totalTokens       = tokensOut;
            info.weightedTimestamp = block.timestamp;
        } else {
            uint256 old = info.totalTokens;
            uint256 tot = old + tokensOut;
            info.weightedTimestamp = (old * info.weightedTimestamp + tokensOut * block.timestamp) / tot;
            info.totalTokens       = tot;
        }
        info.lastPurchaseTime = block.timestamp;
    }

    function _updatePurchaseInfoAfterSell(address user, uint256 sold) internal {
        UserPurchaseInfo storage info = userPurchaseInfo[user];
        if (sold >= info.totalTokens) info.totalTokens = 0;
        else info.totalTokens -= sold;
    }

    // ============ Entry Record (Performance Fee) ============

    function _updateEntryRecord(address user, uint256 newTokens, uint256 nav) internal {
        EntryRecord storage r = entryRecords[user];
        if (r.totalTokens == 0) {
            r.weightedEntryNav = nav;
            r.totalTokens      = newTokens;
        } else {
            r.weightedEntryNav = (r.totalTokens * r.weightedEntryNav + newTokens * nav)
                                 / (r.totalTokens + newTokens);
            r.totalTokens += newTokens;
        }
    }

    function _calculatePerformanceFee(address user, uint256 tokens, uint256 nav)
        internal view returns (uint256 feeTokens)
    {
        EntryRecord storage r = entryRecords[user];
        if (r.weightedEntryNav == 0 || nav <= r.weightedEntryNav) return 0;
        uint256 profitPerToken = nav - r.weightedEntryNav;
        uint256 totalProfit18  = (tokens * profitPerToken) / PRECISION;
        uint256 fee18          = (totalProfit18 * feeBps) / BPS;
        feeTokens              = (fee18 * PRECISION) / nav;
    }

    function _reduceEntryRecord(address user, uint256 sold) internal {
        EntryRecord storage r = entryRecords[user];
        if (sold >= r.totalTokens) { r.weightedEntryNav = 0; r.totalTokens = 0; }
        else r.totalTokens -= sold;
    }

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (from != address(0) && to != address(0) && from != to) {
            EntryRecord storage f = entryRecords[from];
            EntryRecord storage t = entryRecords[to];
            uint256 fromNav = f.weightedEntryNav;
            if (t.totalTokens == 0) {
                t.weightedEntryNav = fromNav;
                t.totalTokens      = amount;
            } else {
                t.weightedEntryNav = (t.totalTokens * t.weightedEntryNav + amount * fromNav)
                                     / (t.totalTokens + amount);
                t.totalTokens += amount;
            }
            if (amount >= f.totalTokens) { f.weightedEntryNav = 0; f.totalTokens = 0; }
            else f.totalTokens -= amount;
        }
    }

    // ============ NAV / Bonding Curve ============

    /// @notice Total assets in 1e18. Reads SpotNavVault via XKubTrading.
    function getTotalAssets() public view returns (uint256) {
        uint256 rawQuote = (tradingModule != address(0))
            ? IXKubTrading(tradingModule).getTotalAssets()
            : IERC20(kusdt).balanceOf(address(this));
        return _toWad(rawQuote);
    }

    function getL1AccountValue() public pure returns (uint256) { return 0; }
    function getL1SpotBalance()  public pure returns (uint256) { return 0; }

    /// @notice Available KUSDT for immediate redemption (EVM balance only)
    function getAvailableLiquidity() public view returns (uint256) {
        return IERC20(kusdt).balanceOf(address(this));
    }

    function getNAV() public view returns (uint256) {
        uint256 supply = totalSupply();
        uint256 total  = getTotalAssets();
        uint256 navVirt = HyperFunTokenLib.calcTieredNavVirtual(total, supply, factory);
        uint256 supplyWithVirt = supply + navVirt;
        if (supplyWithVirt == 0) return PRECISION;
        return ((total + navVirt) * PRECISION) / supplyWithVirt;
    }

    function getRawNAV() public view returns (uint256) {
        return HyperFunMath.getRawNAV(getTotalAssets(), totalSupply());
    }

    function getSmoothedNAV() public view returns (uint256) {
        return HyperFunMath.calcSmoothedNAV(
            getNAV(), twapNav, twapNavTime, twapMaxChangePerMin, block.timestamp
        );
    }

    function _updateTwapNav() internal {
        twapNav     = getSmoothedNAV();
        twapNavTime = block.timestamp;
    }

    function initTwapNav() external onlyAdmin {
        twapNav     = getNAV();
        twapNavTime = block.timestamp;
    }

    function setTwapHalfLife(uint256 halfLifeSeconds) external onlyAdmin {
        if (halfLifeSeconds < 60 || halfLifeSeconds > 3600) revert MaxExceeded();
        twapMaxChangePerMin = halfLifeSeconds;
        twapNav             = getNAV();
        twapNavTime         = block.timestamp;
    }

    function getEffectiveVirtualTokens() public view returns (uint256) {
        uint256 assets = getTotalAssets();
        uint256 tier   = HyperFunTokenLib.calcTieredBcVirtual(assets, factory, virtualBase);
        if (virtualBase == 0) return tier;
        uint256 sqW = HyperFunTokenLib.calcSquaredRatioWeight(assets, factory);
        if (sqW == BPS) return (tier * virtualTokens) / virtualBase;
        if (sqW == 0)   return tier;
        return ((tier * virtualTokens / virtualBase) * sqW + tier * (BPS - sqW)) / BPS;
    }

    function getEffectiveVirtualBase() public view returns (uint256) {
        uint256 assets = getTotalAssets();
        uint256 tier   = HyperFunTokenLib.calcTieredBcVirtual(assets, factory, virtualBase);
        if (virtualTokens == 0) return tier;
        return (tier * virtualBase) / virtualTokens;
    }

    function getMaxBuyUsdc() public view returns (uint256) {
        (, , , uint256 minDepositUsdc, , , , ) = _getSettings();
        (uint256 maxBuyBps, , , ) = _getSettingsExt();
        uint256 assets = getTotalAssets();
        if (assets == 0) return minDepositUsdc;
        uint256 maxNative = _fromWad((assets * maxBuyBps) / BPS);
        return maxNative > minDepositUsdc ? maxNative : minDepositUsdc;
    }

    function getMaxBuyTokens() public view returns (uint256) {
        return (getEffectiveVirtualTokens() * 9000) / BPS;
    }

    function getBuyPrice() public view returns (uint256) {
        (, uint256 maxPremBps, uint256 maxDiscBps, , , , , ) = _getSettings();
        uint256 nav   = getSmoothedNAV();
        uint256 effVB = getEffectiveVirtualBase();
        uint256 effVT = getEffectiveVirtualTokens();
        uint256 price = (nav * (effVB * BPS / effVT)) / BPS;
        uint256 maxP  = (nav * (BPS + maxPremBps)) / BPS;
        uint256 minP  = (nav * (BPS - maxDiscBps)) / BPS;
        if (price > maxP) price = maxP;
        if (price < minP) price = minP;
        return price;
    }

    function getSellPrice()       public view returns (uint256) { return getBuyPrice(); }
    function getSellPriceCapped() public view returns (uint256) {
        return HyperFunMath.getSellPriceCapped(getBuyPrice(), getAvailableLiquidity(), totalSupply());
    }

    function calculateTokensOut(uint256 quoteIn)
        public view returns (uint256 tokensOut, uint256 newPrice, uint256 priceImpactBps)
    {
        (, uint256 maxPremBps, , , , , , ) = _getSettings();
        return HyperFunMath.calculateTokensOutPure(
            quoteIn, getSmoothedNAV(), getEffectiveVirtualBase(),
            getEffectiveVirtualTokens(), maxPremBps, getBuyPrice()
        );
    }

    function calculateUsdcOut(uint256 tokensIn)
        public view returns (uint256 usdcOut, uint256 newPrice, uint256 priceImpactBps)
    {
        (, , uint256 maxDiscBps, , , , , ) = _getSettings();
        uint256 nav = getNAV();
        (usdcOut, newPrice, priceImpactBps) = HyperFunMath.calculateUsdcOutPure(
            tokensIn, nav, getEffectiveVirtualBase(), getEffectiveVirtualTokens(), maxDiscBps
        );
        uint256 premBps   = IXKubFactory(factory).globalMaxSellPremiumBps();
        if (premBps == 0) premBps = 200;
        uint256 ceiling18 = (tokensIn * nav * (BPS + premBps)) / (BPS * PRECISION);
        uint256 usdcOut18 = _toWad(usdcOut);
        if (usdcOut18 > ceiling18) {
            usdcOut  = _fromWad(ceiling18);
            uint256 maxPrice = (nav * (BPS + premBps)) / BPS;
            if (newPrice > maxPrice) newPrice = maxPrice;
        }
    }

    // ============ Buy ============

    function buy(uint256 quoteAmount, uint256 minTokensOut, address referrer)
        external whenNotPaused nonReentrant
    {
        address _gate = IXKubFactory(factory).launchGate();
        if (_gate != address(0)) {
            if (!ILaunchGate(_gate).canBuy(address(this), msg.sender)) revert GatedLaunch();
        }
        _buyInternal(msg.sender, quoteAmount, minTokensOut, referrer);
    }

    function seedBuy(address recipient, uint256 quoteAmount, uint256 minTokensOut)
        external whenNotPaused nonReentrant
    {
        require(msg.sender == factory, "!factory");
        _buyInternal(recipient, quoteAmount, minTokensOut, address(0));
    }

    function _payTradingFee(address user, uint256 feeNative) internal {
        if (feeNative == 0) return;
        address reg = IXKubFactory(factory).referralRegistry();
        if (reg != address(0)) {
            IERC20(kusdt).approve(reg, feeNative);
            IHFReferral(reg).distributeFee(user, feeNative);
        } else {
            IERC20(kusdt).transfer(IXKubFactory(factory).treasury(), feeNative);
        }
    }

    function _buyInternal(
        address recipient,
        uint256 quoteAmount,
        uint256 minTokensOut,
        address referrer
    ) internal {
        (uint256 tradingFeeBps, , , uint256 minDepositUsdc, , , , ) = _getSettings();
        if (quoteAmount < minDepositUsdc) revert BelowMinimum();

        uint256 nav   = getSmoothedNAV();
        uint256 effVB = getEffectiveVirtualBase();
        uint256 effVT = getEffectiveVirtualTokens();

        if (!IERC20(kusdt).transferFrom(msg.sender, address(this), quoteAmount)) revert TransferFailed();

        uint256 amount18     = _toWad(quoteAmount);
        uint256 discBps      = IXKubFactory(factory).checkFeeDiscountBps(recipient);
        uint256 effFeeBps    = tradingFeeBps * (10000 - discBps) / 10000;
        uint256 fee18        = (amount18 * effFeeBps) / BPS;
        uint256 netAmount18  = amount18 - fee18;

        uint256 vbUsdc   = (effVB * nav) / PRECISION;
        uint256 tokensOut = (effVT * netAmount18) / (vbUsdc + netAmount18);
        if (tokensOut == 0) revert ZeroTokens();
        if (minTokensOut > 0 && tokensOut < minTokensOut) revert SlippageExceeded();
        if (tokensOut > getMaxBuyTokens()) revert MaxExceeded();

        virtualBase   = ((vbUsdc + netAmount18) * PRECISION) / nav;
        virtualTokens = effVT - tokensOut;

        uint256 maxRatio = IXKubFactory(factory).globalMaxBcRatioBps();
        if (maxRatio > 0 && virtualTokens > 0) {
            if ((virtualBase * BPS) / virtualTokens > maxRatio)
                virtualTokens = (virtualBase * BPS) / maxRatio;
        }

        _mint(recipient, tokensOut);
        _updatePurchaseInfo(recipient, tokensOut);
        _updateEntryRecord(recipient, tokensOut, nav);

        totalDeposits += netAmount18;
        totalVolume   += amount18;

        uint256 oldAmt   = depositRecords[recipient].depositAmount;
        uint256 oldPrice = depositRecords[recipient].depositSharePrice;
        depositRecords[recipient].depositSharePrice = oldAmt == 0
            ? nav
            : (oldAmt * oldPrice + netAmount18 * nav) / (oldAmt + netAmount18);
        depositRecords[recipient].depositAmount += netAmount18;

        uint256 feeNative = _fromWad(fee18);
        if (referrer != address(0)) {
            address reg = IXKubFactory(factory).referralRegistry();
            if (reg != address(0)) IHFReferral(reg).tryBind(recipient, referrer);
        }
        _payTradingFee(recipient, feeNative);

        if (tradingModule != address(0)) IXKubTrading(tradingModule).autoRebalance();
        _updateTwapNav();

        emit TokenBought(recipient, quoteAmount, tokensOut, (netAmount18 * PRECISION) / tokensOut);
    }

    // ============ Sell (no pending sell — auto-liquidation) ============

    /// @notice Sell vault tokens for KUSDT. Always settles in the same tx.
    /// @dev    If vault KUSDT < needed, calls XKubTrading.liquidateForRedemption()
    ///         which proportionally swaps held tokens → KUSDT via Diamon.
    ///         If even after liquidation there's not enough KUSDT (all pools drained),
    ///         the tx reverts with LiquidityRestricted.
    function sell(uint256 tokens, uint256 minUsdcOut) external nonReentrant {
        if (tokens == 0) revert ZeroTokens();
        if (balanceOf(msg.sender) < tokens) revert InsufficientBalance();

        (uint256 tradingFeeBps, , , , , , , ) = _getSettings();
        uint256 effVB = getEffectiveVirtualBase();
        uint256 effVT = getEffectiveVirtualTokens();
        uint256 nav   = getNAV(); // instant NAV for sell (not smoothed — prevents exploit)

        uint256 perfFeeTokens = _calculatePerformanceFee(msg.sender, tokens, nav);

        uint256 vbUsdc       = (effVB * nav) / PRECISION;
        uint256 grossAmt18   = (vbUsdc * tokens) / (effVT + tokens);

        // V70: NAV ceiling
        {
            uint256 premBps = IXKubFactory(factory).globalMaxSellPremiumBps();
            if (premBps == 0) premBps = 200;
            uint256 ceiling18 = (tokens * nav * (BPS + premBps)) / (BPS * PRECISION);
            if (grossAmt18 > ceiling18) grossAmt18 = ceiling18;
        }

        (uint256 exitFeeBps, uint256 daysHeld) = calculateExitFee(msg.sender);
        uint256 exitFee18      = (grossAmt18 * exitFeeBps) / BPS;
        uint256 afterExitFee18 = grossAmt18 - exitFee18;
        uint256 discBps        = IXKubFactory(factory).checkFeeDiscountBps(msg.sender);
        uint256 effTradingFee  = tradingFeeBps * (10000 - discBps) / 10000;
        uint256 tradingFee18   = (afterExitFee18 * effTradingFee) / BPS;
        uint256 netAmt18       = afterExitFee18 - tradingFee18;

        uint256 netNative      = _fromWad(netAmt18);
        uint256 tradeFeeNative = _fromWad(tradingFee18);
        uint256 totalNeeded    = netNative + tradeFeeNative;

        if (minUsdcOut > 0 && netNative < minUsdcOut) revert SlippageExceeded();

        // Update bonding curve
        uint256 newVbUsdc = vbUsdc - afterExitFee18;
        virtualBase   = (newVbUsdc * PRECISION) / nav;
        virtualTokens = effVT + tokens;
        // Floor: price >= NAV
        if (virtualBase > 0 && virtualTokens > 0 && (virtualBase * BPS) / virtualTokens < BPS)
            virtualTokens = virtualBase;

        _burn(msg.sender, tokens);

        if (perfFeeTokens > 0) {
            _mint(leader, perfFeeTokens);
            emit PerformanceFeeMinted(msg.sender, leader, perfFeeTokens, nav);
        }

        _updatePurchaseInfoAfterSell(msg.sender, tokens);
        _reduceEntryRecord(msg.sender, tokens);

        if (exitFee18 > 0) emit ExitFeeCharged(msg.sender, _fromWad(exitFee18), exitFeeBps, daysHeld);

        totalVolume += grossAmt18;

        // ─── Liquidity check + auto-liquidation ───────────────────────────────
        uint256 kusdtBal = IERC20(kusdt).balanceOf(address(this));

        if (kusdtBal < totalNeeded && tradingModule != address(0)) {
            uint256 shortfall = totalNeeded - kusdtBal;
            uint256 covered   = IXKubTrading(tradingModule).liquidateForRedemption(shortfall);
            emit AutoLiquidated(shortfall, covered);
            kusdtBal = IERC20(kusdt).balanceOf(address(this));
        }

        if (kusdtBal < totalNeeded) revert LiquidityRestricted();
        // ─────────────────────────────────────────────────────────────────────

        _payTradingFee(msg.sender, tradeFeeNative);
        // Exit fee stays in vault (raises NAV for remaining holders)
        if (!IERC20(kusdt).transfer(msg.sender, netNative)) revert TransferFailed();

        _updateTwapNav();
        if (tradingModule != address(0)) IXKubTrading(tradingModule).autoRebalance();

        emit TokenSold(msg.sender, tokens, netNative, (grossAmt18 * PRECISION) / tokens);
    }

    // ============ Leader Deposit ============

    function deposit(uint256 quoteAmount) external whenNotPaused nonReentrant {
        (, , , uint256 minDepositUsdc, , , , ) = _getSettings();
        require(msg.sender == leader, "!leader");
        if (quoteAmount < minDepositUsdc) revert BelowMinimum();

        uint256 nav = getSmoothedNAV();
        if (!IERC20(kusdt).transferFrom(msg.sender, address(this), quoteAmount)) revert TransferFailed();

        uint256 amount18 = _toWad(quoteAmount);
        uint256 shares   = (amount18 * PRECISION) / nav;
        require(shares > 0, "0 shares");

        _updatePurchaseInfo(msg.sender, shares);
        _updateEntryRecord(msg.sender, shares, nav);
        totalDeposits += amount18;
        _mint(msg.sender, shares);

        if (tradingModule != address(0)) IXKubTrading(tradingModule).autoRebalance();
        emit Deposited(msg.sender, quoteAmount, shares);
    }

    // ============ Admin ============

    function setPaused(bool _paused) external onlyFactoryOwner { paused = _paused; }

    function setAdmin(address _admin) external onlyFactoryOwner {
        require(_admin != address(0), "!admin");
        address old = admin; admin = _admin;
        emit AdminChanged(old, _admin);
    }

    function setTradingModule(address _tradingModule) external onlyFactoryOwner {
        address old = tradingModule; tradingModule = _tradingModule;
        emit TradingModuleChanged(old, _tradingModule);
    }

    function triggerRebalance() external onlyTradingModule {
        if (tradingModule != address(0)) IXKubTrading(tradingModule).autoRebalance();
    }

    function setMetadataURI(string calldata _metadataURI) external {
        address sr = IXKubFactory(factory).seedBuyRouter();
        require(msg.sender == leader || (sr != address(0) && msg.sender == sr), "!leader");
        metadataURI = _metadataURI;
        emit MetadataUpdated(_metadataURI);
    }

    // ============ Emergency ============

    function emergencyWithdrawEVM(uint256 amountNative) external onlyFactoryOwner {
        if (!IERC20(kusdt).transfer(IXKubFactory(factory).treasury(), amountNative))
            revert TransferFailed();
    }

    /// @notice Recover any KAP-20 token accidentally sent to vault
    function emergencyRecoverToken(address token, uint256 amount) external onlyFactoryOwner {
        require(token != kusdt, "use emergencyWithdrawEVM");
        if (!IERC20(token).transfer(IXKubFactory(factory).treasury(), amount))
            revert TransferFailed();
    }
}
