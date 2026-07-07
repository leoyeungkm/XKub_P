// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IXKubPerp.sol";

interface IXKubReferral {
    function getRebate(address trader) external view returns (address referrer, uint256 rebateBps);
    function accrue(address referrer, address trader, uint256 usd) external;
}

/*//////////////////////////////////////////////////////////////
            XKub Perp: Market / Position Engine
//////////////////////////////////////////////////////////////

  MODEL (GMX-v1 style, KUSDT-settled synthetic perps)
  ---------------------------------------------------
  - Markets are bytes32 symbols (BTC, ETH, KUB...) priced by
    XKubPriceOracle. Nothing is ever swapped — pure PnL settlement
    in KUSDT against the XKubPerpPool.
  - Isolated margin. One position per (owner, market, side).
  - Collateral (KUSDT) is held by THIS contract; fees and trader
    losses flow to the pool; trader profits are paid by the pool.

  BORROW FEE (funding)
  --------------------
  Each side of each market accrues an hourly borrow fee:
      ratePerHour = borrowRateFactorBps * sideOI / poolValue
  The heavier side pays more — this implicitly punishes skew.
  Tracked as a cumulative index; positions settle lazily on touch.

  RISK PARAMETERS
  ---------------
  - maxLeverageX per market, OI cap per side per market
  - profit capped at maxProfitBps of collateral (pool protection)
  - liquidation when equity <= maintenanceMargin, keeper rewarded

  UNITS
  -----
  All internal accounting is USD 1e18 (1 KUSDT = 1 USD).
  sizeTokens is the synthetic asset amount, 1e18.
*/

contract XKubPerpMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct MarketConfig {
        bool    listed;
        uint256 maxLeverageX;        // e.g. 10 = 10x
        uint256 maxOiUsd;            // per-side OI cap, USD 1e18
        uint256 borrowRateFactorBps; // hourly rate at 100% pool utilization
    }

    struct SideState {
        uint256 sizeUsd;        // total open interest, USD 1e18
        uint256 sizeTokens;     // total synthetic asset units, 1e18
        uint256 cumBorrowX18;   // cumulative borrow fee index (fraction of size)
    }

    struct MarketState {
        SideState longs;
        SideState shorts;
        uint256 lastAccrual;
    }

    struct Position {
        uint256 sizeUsd;         // USD 1e18
        uint256 sizeTokens;      // asset units 1e18
        uint256 collateralUsd;   // USD 1e18
        uint256 entryBorrowX18;  // borrow index snapshot
    }

    IERC20  public immutable kusdt;
    uint256 public immutable quoteDecimals;
    uint256 private immutable scaler; // 10^(18 - quoteDecimals)

    IXKubPriceOracle public immutable oracle;
    IXKubPerpPool    public immutable pool;

    address public admin;
    bool    public paused;

    // Two-step execution: when direct trading is off (default), positions can
    // only be opened/closed through the router (keeper-executed, front-run safe).
    address public router;
    bool    public directTradingEnabled;

    // Optional referral module. When set, a fraction of each position fee is
    // rebated to the trader's referrer, drawn from the pool AFTER the fee has
    // been sent there — so core settlement accounting is unchanged.
    address public referral;

    bytes32[] public marketIds;
    mapping(bytes32 => MarketConfig) public marketConfig;
    mapping(bytes32 => MarketState)  internal marketState;

    // keccak256(owner, marketId, isLong) => Position
    mapping(bytes32 => Position) public positions;

    // Open-position enumeration (for the liquidation bot)
    struct PositionMeta {
        address owner;
        bytes32 marketId;
        bool    isLong;
    }
    bytes32[] public openPositionKeys;
    mapping(bytes32 => PositionMeta) public positionMeta;
    mapping(bytes32 => uint256) internal keyIndexPlusOne; // 0 = not tracked

    // Global risk params
    uint256 public positionFeeBps      = 3;      // 0.03% of size, open & close
    uint256 public maintenanceMarginBps = 100;   // 1% of size
    uint256 public liquidationFeeUsd   = 5e18;   // keeper reward
    uint256 public maxProfitBps        = 90000;  // 900% of collateral
    uint256 public minCollateralUsd    = 10e18;  // 10 KUSDT
    uint256 public maxPriceAge         = 300;    // seconds

    // VIP fee tiers: a trader's tier gives a discount on the position fee.
    // Tier 0 = default (0% discount). Admin assigns tiers and per-tier discounts.
    mapping(address => uint8)  public feeTier;
    mapping(uint8 => uint256)  public tierDiscountBps;   // e.g. tier 3 → 3000 = 30% off the fee

    // Protocol revenue: a share of every position fee is routed to the treasury
    // (drawn from the pool after the fee lands there, like referral rebates).
    address public treasury;
    uint256 public protocolFeeShareBps;                  // 0 = all fees stay with LPs
    uint256 public constant MAX_PROTOCOL_SHARE_BPS = 5000; // ≤50% of the position fee

    event MarketListed(bytes32 indexed marketId, uint256 maxLeverageX, uint256 maxOiUsd, uint256 borrowRateFactorBps);
    event MarketConfigured(bytes32 indexed marketId, uint256 maxLeverageX, uint256 maxOiUsd, uint256 borrowRateFactorBps);
    event PositionIncreased(address indexed owner, bytes32 indexed marketId, bool isLong,
        uint256 collateralDeltaUsd, uint256 sizeDeltaUsd, uint256 price, uint256 feeUsd);
    event PositionDecreased(address indexed owner, bytes32 indexed marketId, bool isLong,
        uint256 sizeDeltaUsd, uint256 price, int256 pnlUsd, uint256 payoutUsd, uint256 feeUsd);
    event PositionLiquidated(address indexed owner, bytes32 indexed marketId, bool isLong,
        address indexed liquidator, uint256 price, uint256 keeperRewardUsd, uint256 traderRefundUsd, uint256 toPoolUsd);
    event BorrowAccrued(bytes32 indexed marketId, uint256 cumLongX18, uint256 cumShortX18);
    event PausedSet(bool paused);
    event GlobalParamsUpdated();
    event AdminChanged(address indexed oldAdmin, address indexed newAdmin);
    event RouterSet(address indexed router);
    event DirectTradingSet(bool enabled);
    event ReferralSet(address indexed referral);
    event FeeTierSet(address indexed trader, uint8 tier);
    event TierDiscountSet(uint8 indexed tier, uint256 discountBps);
    event TreasurySet(address indexed treasury);
    event ProtocolFeeShareSet(uint256 bps);
    event ProtocolFeePaid(address indexed treasury, uint256 usd);

    modifier onlyAdmin() {
        require(msg.sender == admin, "!admin");
        _;
    }

    modifier onlyRouter() {
        require(msg.sender == router, "!router");
        _;
    }

    constructor(
        address _kusdt,
        uint256 _quoteDecimals,
        address _oracle,
        address _pool,
        address _admin
    ) {
        require(_kusdt != address(0) && _oracle != address(0) && _pool != address(0), "!addr");
        require(_quoteDecimals == 18 || _quoteDecimals == 6, "dec 18|6");
        kusdt         = IERC20(_kusdt);
        quoteDecimals = _quoteDecimals;
        scaler        = 10 ** (18 - _quoteDecimals);
        oracle        = IXKubPriceOracle(_oracle);
        pool          = IXKubPerpPool(_pool);
        admin         = _admin == address(0) ? msg.sender : _admin;
    }

    // ─── Trading: Open / Increase ──────────────────────────────────────────────

    /// @notice Direct entry — only when directTradingEnabled (testnet convenience).
    ///         Production flow goes through the router (front-run protection).
    function increasePosition(
        bytes32 marketId,
        bool isLong,
        uint256 collateralTokens,
        uint256 sizeDeltaUsd
    ) external nonReentrant {
        require(directTradingEnabled, "use router");
        _increasePosition(msg.sender, msg.sender, marketId, isLong, collateralTokens, sizeDeltaUsd);
    }

    /// @notice Router entry — collateral is pulled from the router's escrow.
    function increasePositionFor(
        address owner,
        bytes32 marketId,
        bool isLong,
        uint256 collateralTokens,
        uint256 sizeDeltaUsd
    ) external nonReentrant onlyRouter {
        _increasePosition(owner, msg.sender, marketId, isLong, collateralTokens, sizeDeltaUsd);
    }

    /// @dev Open a new position, increase an existing one, or add collateral
    ///      (sizeDeltaUsd = 0 → pure collateral top-up).
    /// @param collateralTokens KUSDT to add as collateral (native decimals)
    /// @param sizeDeltaUsd     notional to add, USD 1e18
    function _increasePosition(
        address owner,
        address payer,
        bytes32 marketId,
        bool isLong,
        uint256 collateralTokens,
        uint256 sizeDeltaUsd
    ) internal {
        require(!paused, "paused");
        MarketConfig memory cfg = marketConfig[marketId];
        require(cfg.listed, "!market");

        _accrueBorrow(marketId);

        bytes32 key = _positionKey(owner, marketId, isLong);
        Position storage p = positions[key];
        require(p.sizeUsd > 0 || sizeDeltaUsd > 0, "empty open");

        if (collateralTokens > 0) {
            kusdt.safeTransferFrom(payer, address(this), collateralTokens);
            p.collateralUsd += collateralTokens * scaler;
        }

        // Settle accrued borrow fee before changing size
        uint256 feeUsd = _settleBorrowFee(p, marketId, isLong);

        uint256 price;
        if (sizeDeltaUsd > 0) {
            price = oracle.getPrice(marketId, maxPriceAge);
            uint256 openFeeUsd = (sizeDeltaUsd * effectiveFeeBps(owner)) / 10000;
            require(p.collateralUsd > openFeeUsd, "fee > collateral");
            p.collateralUsd -= openFeeUsd;
            feeUsd += openFeeUsd;

            uint256 tokensDelta = (sizeDeltaUsd * 1e18) / price;
            require(tokensDelta > 0, "size too small");
            p.sizeUsd    += sizeDeltaUsd;
            p.sizeTokens += tokensDelta;

            SideState storage side = _side(marketId, isLong);
            side.sizeUsd    += sizeDeltaUsd;
            side.sizeTokens += tokensDelta;
            require(side.sizeUsd <= cfg.maxOiUsd, "OI cap");

            // Initial margin is gross of the open fee, so an exact-max-leverage
            // open is accepted. Collateral top-ups (sizeDeltaUsd = 0) skip the
            // check — they only ever improve position health.
            require(p.sizeUsd <= (p.collateralUsd + openFeeUsd) * cfg.maxLeverageX, "leverage too high");
        }

        require(p.collateralUsd >= minCollateralUsd, "collateral < min");

        if (keyIndexPlusOne[key] == 0) {
            openPositionKeys.push(key);
            keyIndexPlusOne[key] = openPositionKeys.length;
            positionMeta[key] = PositionMeta(owner, marketId, isLong);
        }

        _sendToPool(feeUsd);
        if (sizeDeltaUsd > 0) _distributeFees(owner, (sizeDeltaUsd * effectiveFeeBps(owner)) / 10000);
        emit PositionIncreased(owner, marketId, isLong, collateralTokens * scaler, sizeDeltaUsd, price, feeUsd);
    }

    // ─── Trading: Decrease / Close ─────────────────────────────────────────────

    /// @notice Direct entry — only when directTradingEnabled.
    function decreasePosition(
        bytes32 marketId,
        bool isLong,
        uint256 sizeDeltaUsd
    ) external nonReentrant {
        require(directTradingEnabled, "use router");
        _decreasePosition(msg.sender, marketId, isLong, sizeDeltaUsd);
    }

    /// @notice Router entry — payout still goes to the position owner.
    function decreasePositionFor(
        address owner,
        bytes32 marketId,
        bool isLong,
        uint256 sizeDeltaUsd
    ) external nonReentrant onlyRouter {
        _decreasePosition(owner, marketId, isLong, sizeDeltaUsd);
    }

    /// @dev Close all or part of a position. Collateral is released
    ///      proportionally; PnL realized on the closed portion.
    function _decreasePosition(
        address owner,
        bytes32 marketId,
        bool isLong,
        uint256 sizeDeltaUsd
    ) internal {
        bytes32 key = _positionKey(owner, marketId, isLong);
        Position storage p = positions[key];
        require(p.sizeUsd > 0, "!position");
        require(sizeDeltaUsd > 0 && sizeDeltaUsd <= p.sizeUsd, "bad size");

        _accrueBorrow(marketId);
        uint256 borrowFeeUsd = _settleBorrowFee(p, marketId, isLong);

        uint256 price = oracle.getPrice(marketId, maxPriceAge);
        uint256 tokensDelta     = (p.sizeTokens * sizeDeltaUsd) / p.sizeUsd;
        uint256 collateralShare = (p.collateralUsd * sizeDeltaUsd) / p.sizeUsd;
        if (sizeDeltaUsd == p.sizeUsd) {
            tokensDelta     = p.sizeTokens;     // avoid rounding dust
            collateralShare = p.collateralUsd;
        }

        int256 pnlUsd = _pnl(isLong, sizeDeltaUsd, tokensDelta, price);
        if (pnlUsd > 0) {
            uint256 maxProfit = (collateralShare * maxProfitBps) / 10000;
            if (uint256(pnlUsd) > maxProfit) pnlUsd = int256(maxProfit);
        }

        uint256 closeFeeUsd = (sizeDeltaUsd * effectiveFeeBps(owner)) / 10000;

        // Split payout between trader / pool
        int256 grossUsd = int256(collateralShare) + pnlUsd - int256(closeFeeUsd);
        uint256 payoutUsd        = grossUsd > 0 ? uint256(grossUsd) : 0;
        uint256 fromPoolUsd      = payoutUsd > collateralShare ? payoutUsd - collateralShare : 0;
        uint256 fromCollateralUsd = payoutUsd - fromPoolUsd;
        uint256 toPoolUsd        = collateralShare - fromCollateralUsd;

        // Update position + globals
        p.sizeUsd       -= sizeDeltaUsd;
        p.sizeTokens    -= tokensDelta;
        p.collateralUsd -= collateralShare;
        SideState storage side = _side(marketId, isLong);
        side.sizeUsd    -= sizeDeltaUsd;
        side.sizeTokens -= tokensDelta;

        if (p.sizeUsd == 0) {
            delete positions[key];
            _untrackKey(key);
        } else {
            require(p.collateralUsd >= minCollateralUsd, "collateral < min");
        }

        _sendToPool(toPoolUsd + borrowFeeUsd);
        if (fromCollateralUsd > 0) kusdt.safeTransfer(owner, fromCollateralUsd / scaler);
        if (fromPoolUsd > 0) pool.payOutUsd(owner, fromPoolUsd);
        _distributeFees(owner, closeFeeUsd);

        emit PositionDecreased(owner, marketId, isLong, sizeDeltaUsd, price, pnlUsd, payoutUsd, closeFeeUsd + borrowFeeUsd);
    }

    // ─── Liquidation ───────────────────────────────────────────────────────────

    /// @notice True if the position can be liquidated at the current price
    function isLiquidatable(address owner, bytes32 marketId, bool isLong) public view returns (bool) {
        Position memory p = positions[_positionKey(owner, marketId, isLong)];
        if (p.sizeUsd == 0) return false;
        (uint256 price,) = oracle.peekPrice(marketId);
        if (price == 0) return false;

        // Include pending borrow fee
        uint256 pendingFee = _pendingBorrowFee(p, marketId, isLong);
        int256 equity = int256(p.collateralUsd) - int256(pendingFee) + _pnl(isLong, p.sizeUsd, p.sizeTokens, price);
        return equity <= int256((p.sizeUsd * maintenanceMarginBps) / 10000);
    }

    /// @notice Liquidate an underwater position. Keeper gets liquidationFeeUsd,
    ///         any remaining equity is refunded to the trader, rest to the pool.
    function liquidate(address owner, bytes32 marketId, bool isLong) external nonReentrant {
        bytes32 key = _positionKey(owner, marketId, isLong);
        Position storage p = positions[key];
        require(p.sizeUsd > 0, "!position");

        _accrueBorrow(marketId);
        uint256 borrowFeeUsd = _settleBorrowFee(p, marketId, isLong);

        uint256 price = oracle.getPrice(marketId, maxPriceAge);
        int256 pnlUsd = _pnl(isLong, p.sizeUsd, p.sizeTokens, price);
        int256 equity = int256(p.collateralUsd) + pnlUsd;
        require(equity <= int256((p.sizeUsd * maintenanceMarginBps) / 10000), "not liquidatable");

        uint256 collateralUsd = p.collateralUsd;
        uint256 keeperUsd = liquidationFeeUsd > collateralUsd ? collateralUsd : liquidationFeeUsd;
        uint256 remainingUsd = equity > 0 ? uint256(equity) : 0;
        if (remainingUsd > collateralUsd) remainingUsd = collateralUsd;
        uint256 traderRefundUsd = remainingUsd > keeperUsd ? remainingUsd - keeperUsd : 0;
        if (traderRefundUsd > collateralUsd - keeperUsd) traderRefundUsd = collateralUsd - keeperUsd;
        uint256 toPoolUsd = collateralUsd - keeperUsd - traderRefundUsd;

        SideState storage side = _side(marketId, isLong);
        side.sizeUsd    -= p.sizeUsd;
        side.sizeTokens -= p.sizeTokens;
        delete positions[key];
        _untrackKey(key);

        _sendToPool(toPoolUsd + borrowFeeUsd);
        if (keeperUsd > 0) kusdt.safeTransfer(msg.sender, keeperUsd / scaler);
        if (traderRefundUsd > 0) kusdt.safeTransfer(owner, traderRefundUsd / scaler);

        emit PositionLiquidated(owner, marketId, isLong, msg.sender, price, keeperUsd, traderRefundUsd, toPoolUsd);
    }

    // ─── Borrow Fee Accrual ────────────────────────────────────────────────────

    /// @notice Accrue the borrow index for a market (anyone may poke)
    function accrueBorrow(bytes32 marketId) external {
        _accrueBorrow(marketId);
    }

    function _accrueBorrow(bytes32 marketId) internal {
        MarketState storage m = marketState[marketId];
        uint256 elapsed = block.timestamp - m.lastAccrual;
        if (elapsed == 0) return;
        if (m.lastAccrual == 0) { m.lastAccrual = block.timestamp; return; }
        m.lastAccrual = block.timestamp;

        uint256 poolValue = pool.poolValueUsd();
        if (poolValue == 0) return;
        uint256 factor = marketConfig[marketId].borrowRateFactorBps;

        if (m.longs.sizeUsd > 0) {
            uint256 ratePerHourX18 = (factor * 1e14 * m.longs.sizeUsd) / poolValue;
            m.longs.cumBorrowX18 += (ratePerHourX18 * elapsed) / 3600;
        }
        if (m.shorts.sizeUsd > 0) {
            uint256 ratePerHourX18 = (factor * 1e14 * m.shorts.sizeUsd) / poolValue;
            m.shorts.cumBorrowX18 += (ratePerHourX18 * elapsed) / 3600;
        }
        emit BorrowAccrued(marketId, m.longs.cumBorrowX18, m.shorts.cumBorrowX18);
    }

    /// @dev Deduct accrued borrow fee from position collateral. Returns fee (USD 1e18).
    ///      Caller is responsible for forwarding it to the pool via _sendToPool.
    function _settleBorrowFee(Position storage p, bytes32 marketId, bool isLong) internal returns (uint256 feeUsd) {
        if (p.sizeUsd == 0) {
            p.entryBorrowX18 = _side(marketId, isLong).cumBorrowX18;
            return 0;
        }
        uint256 cum = _side(marketId, isLong).cumBorrowX18;
        feeUsd = (p.sizeUsd * (cum - p.entryBorrowX18)) / 1e18;
        if (feeUsd > p.collateralUsd) feeUsd = p.collateralUsd;
        p.collateralUsd -= feeUsd;
        p.entryBorrowX18 = cum;
    }

    function _pendingBorrowFee(Position memory p, bytes32 marketId, bool isLong) internal view returns (uint256) {
        MarketState storage m = marketState[marketId];
        SideState storage side = isLong ? m.longs : m.shorts;
        uint256 cum = side.cumBorrowX18;
        // Project unaccrued time
        if (m.lastAccrual != 0 && block.timestamp > m.lastAccrual && side.sizeUsd > 0) {
            uint256 poolValue = pool.poolValueUsd();
            if (poolValue > 0) {
                uint256 ratePerHourX18 = (marketConfig[marketId].borrowRateFactorBps * 1e14 * side.sizeUsd) / poolValue;
                cum += (ratePerHourX18 * (block.timestamp - m.lastAccrual)) / 3600;
            }
        }
        uint256 fee = (p.sizeUsd * (cum - p.entryBorrowX18)) / 1e18;
        return fee > p.collateralUsd ? p.collateralUsd : fee;
    }

    // ─── Pool Integration (IXKubPerpMarket) ────────────────────────────────────

    /// @notice Aggregate unrealized trader PnL across all markets, signed USD 1e18
    function getGlobalPnlUsd() external view returns (int256 total) {
        uint256 n = marketIds.length;
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = marketIds[i];
            (uint256 price,) = oracle.peekPrice(id);
            if (price == 0) continue;
            MarketState storage m = marketState[id];
            if (m.longs.sizeUsd > 0 || m.longs.sizeTokens > 0) {
                total += _pnl(true, m.longs.sizeUsd, m.longs.sizeTokens, price);
            }
            if (m.shorts.sizeUsd > 0 || m.shorts.sizeTokens > 0) {
                total += _pnl(false, m.shorts.sizeUsd, m.shorts.sizeTokens, price);
            }
        }
    }

    /// @notice Total open interest across all markets and both sides, USD 1e18
    function totalOpenInterestUsd() external view returns (uint256 total) {
        uint256 n = marketIds.length;
        for (uint256 i = 0; i < n; i++) {
            MarketState storage m = marketState[marketIds[i]];
            total += m.longs.sizeUsd + m.shorts.sizeUsd;
        }
    }

    // ─── Views ─────────────────────────────────────────────────────────────────

    function getPosition(address owner, bytes32 marketId, bool isLong)
        external view returns (Position memory)
    {
        return positions[_positionKey(owner, marketId, isLong)];
    }

    /// @notice Unrealized PnL of a position at current oracle price (ignores fees)
    function getPositionPnl(address owner, bytes32 marketId, bool isLong) external view returns (int256) {
        Position memory p = positions[_positionKey(owner, marketId, isLong)];
        if (p.sizeUsd == 0) return 0;
        (uint256 price,) = oracle.peekPrice(marketId);
        if (price == 0) return 0;
        return _pnl(isLong, p.sizeUsd, p.sizeTokens, price);
    }

    function getMarketIds() external view returns (bytes32[] memory) {
        return marketIds;
    }

    function openPositionCount() external view returns (uint256) {
        return openPositionKeys.length;
    }

    /// @notice Paginated open-position listing for the liquidation bot
    function getOpenPositions(uint256 offset, uint256 limit) external view returns (
        bytes32[] memory keys,
        PositionMeta[] memory metas,
        bool[] memory liquidatable
    ) {
        uint256 n = openPositionKeys.length;
        if (offset >= n) return (new bytes32[](0), new PositionMeta[](0), new bool[](0));
        uint256 end = offset + limit > n ? n : offset + limit;
        uint256 len = end - offset;
        keys         = new bytes32[](len);
        metas        = new PositionMeta[](len);
        liquidatable = new bool[](len);
        for (uint256 i = 0; i < len; i++) {
            bytes32 key = openPositionKeys[offset + i];
            PositionMeta memory m = positionMeta[key];
            keys[i]         = key;
            metas[i]        = m;
            liquidatable[i] = isLiquidatable(m.owner, m.marketId, m.isLong);
        }
    }

    function getMarketState(bytes32 marketId) external view returns (
        uint256 longSizeUsd, uint256 shortSizeUsd,
        uint256 cumBorrowLongX18, uint256 cumBorrowShortX18, uint256 lastAccrual
    ) {
        MarketState storage m = marketState[marketId];
        return (m.longs.sizeUsd, m.shorts.sizeUsd, m.longs.cumBorrowX18, m.shorts.cumBorrowX18, m.lastAccrual);
    }

    // ─── Internal Helpers ──────────────────────────────────────────────────────

    function _positionKey(address owner, bytes32 marketId, bool isLong) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(owner, marketId, isLong));
    }

    /// @dev Swap-and-pop removal from the open-position enumeration
    function _untrackKey(bytes32 key) internal {
        uint256 idxPlusOne = keyIndexPlusOne[key];
        if (idxPlusOne == 0) return;
        uint256 idx = idxPlusOne - 1;
        uint256 lastIdx = openPositionKeys.length - 1;
        if (idx != lastIdx) {
            bytes32 lastKey = openPositionKeys[lastIdx];
            openPositionKeys[idx] = lastKey;
            keyIndexPlusOne[lastKey] = idx + 1;
        }
        openPositionKeys.pop();
        delete keyIndexPlusOne[key];
        delete positionMeta[key];
    }

    function _side(bytes32 marketId, bool isLong) internal view returns (SideState storage) {
        MarketState storage m = marketState[marketId];
        return isLong ? m.longs : m.shorts;
    }

    /// @dev Signed PnL: long profits when price > entry, short the inverse.
    ///      sizeTokens * price recovers current notional; entry notional = sizeUsd.
    function _pnl(bool isLong, uint256 sizeUsd, uint256 sizeTokens, uint256 price) internal pure returns (int256) {
        int256 currentNotional = int256((sizeTokens * price) / 1e18);
        return isLong
            ? currentNotional - int256(sizeUsd)
            : int256(sizeUsd) - currentNotional;
    }

    function _sendToPool(uint256 amountUsd) internal {
        uint256 tokens = amountUsd / scaler;
        if (tokens > 0) kusdt.safeTransfer(address(pool), tokens);
    }

    /// @notice The position-fee rate a trader actually pays, after their VIP
    ///         tier discount. Basis points of size.
    function effectiveFeeBps(address trader) public view returns (uint256) {
        uint256 discount = tierDiscountBps[feeTier[trader]];
        if (discount >= 10000) return 0;
        return (positionFeeBps * (10000 - discount)) / 10000;
    }

    /// @dev Split a position fee (already sitting in the pool) between the
    ///      protocol treasury and the trader's referrer; whatever is left
    ///      stays with the LPs. Both cuts are drawn back out via the pool's
    ///      payout hook, so pool value simply nets the fee minus the cuts.
    ///      Never reverts the trade on fee-routing issues.
    function _distributeFees(address trader, uint256 feeUsd) internal {
        if (feeUsd == 0) return;

        // Protocol revenue cut
        if (treasury != address(0) && protocolFeeShareBps > 0) {
            uint256 protoUsd = (feeUsd * protocolFeeShareBps) / 10000;
            if (protoUsd / scaler > 0) {
                pool.payOutUsd(treasury, protoUsd);
                emit ProtocolFeePaid(treasury, protoUsd);
            }
        }

        // Referral rebate
        address ref = referral;
        if (ref != address(0)) {
            (address referrer, uint256 rebateBps) = IXKubReferral(ref).getRebate(trader);
            if (referrer != address(0) && rebateBps > 0) {
                uint256 rebateUsd = (feeUsd * rebateBps) / 10000;
                if (rebateUsd / scaler > 0) {
                    pool.payOutUsd(ref, rebateUsd);
                    IXKubReferral(ref).accrue(referrer, trader, rebateUsd);
                }
            }
        }
    }

    // ─── Admin ─────────────────────────────────────────────────────────────────

    function listMarket(
        bytes32 marketId,
        uint256 maxLeverageX,
        uint256 maxOiUsd,
        uint256 borrowRateFactorBps
    ) external onlyAdmin {
        require(!marketConfig[marketId].listed, "listed");
        require(maxLeverageX >= 1 && maxLeverageX <= 100, "lev 1-100");
        require(borrowRateFactorBps <= 1000, "factor <= 10%/h");
        marketConfig[marketId] = MarketConfig(true, maxLeverageX, maxOiUsd, borrowRateFactorBps);
        marketState[marketId].lastAccrual = block.timestamp;
        marketIds.push(marketId);
        emit MarketListed(marketId, maxLeverageX, maxOiUsd, borrowRateFactorBps);
    }

    function configureMarket(
        bytes32 marketId,
        uint256 maxLeverageX,
        uint256 maxOiUsd,
        uint256 borrowRateFactorBps
    ) external onlyAdmin {
        require(marketConfig[marketId].listed, "!market");
        require(maxLeverageX >= 1 && maxLeverageX <= 100, "lev 1-100");
        require(borrowRateFactorBps <= 1000, "factor <= 10%/h");
        _accrueBorrow(marketId); // settle at old rate first
        marketConfig[marketId] = MarketConfig(true, maxLeverageX, maxOiUsd, borrowRateFactorBps);
        emit MarketConfigured(marketId, maxLeverageX, maxOiUsd, borrowRateFactorBps);
    }

    function setGlobalParams(
        uint256 _positionFeeBps,
        uint256 _maintenanceMarginBps,
        uint256 _liquidationFeeUsd,
        uint256 _maxProfitBps,
        uint256 _minCollateralUsd,
        uint256 _maxPriceAge
    ) external onlyAdmin {
        require(_positionFeeBps <= 100, "fee <= 1%");
        require(_maintenanceMarginBps >= 10 && _maintenanceMarginBps <= 500, "mm 0.1-5%");
        require(_maxProfitBps >= 10000, "maxProfit >= 100%");
        require(_maxPriceAge >= 10 && _maxPriceAge <= 3600, "age 10s-1h");
        positionFeeBps       = _positionFeeBps;
        maintenanceMarginBps = _maintenanceMarginBps;
        liquidationFeeUsd    = _liquidationFeeUsd;
        maxProfitBps         = _maxProfitBps;
        minCollateralUsd     = _minCollateralUsd;
        maxPriceAge          = _maxPriceAge;
        emit GlobalParamsUpdated();
    }

    function setPaused(bool _paused) external onlyAdmin {
        paused = _paused;
        emit PausedSet(_paused);
    }

    function setRouter(address _router) external onlyAdmin {
        require(_router != address(0), "!router");
        router = _router;
        emit RouterSet(_router);
    }

    /// @notice Wire (or unset) the referral module. address(0) disables rebates.
    function setReferral(address _referral) external onlyAdmin {
        referral = _referral;
        emit ReferralSet(_referral);
    }

    // ─── VIP tiers & protocol revenue ──────────────────────────────────────────

    /// @notice Assign a trader's VIP fee tier (0 = default, no discount).
    function setFeeTier(address trader, uint8 tier) external onlyAdmin {
        feeTier[trader] = tier;
        emit FeeTierSet(trader, tier);
    }

    /// @notice Batch-assign VIP tiers (e.g. from an off-chain volume snapshot).
    function setFeeTiers(address[] calldata traders, uint8 tier) external onlyAdmin {
        for (uint256 i = 0; i < traders.length; i++) {
            feeTier[traders[i]] = tier;
            emit FeeTierSet(traders[i], tier);
        }
    }

    /// @notice Set the fee discount for a tier, in bps of the position fee
    ///         (3000 = 30% off). Capped below 100%.
    function setTierDiscount(uint8 tier, uint256 discountBps) external onlyAdmin {
        require(discountBps < 10000, "discount < 100%");
        tierDiscountBps[tier] = discountBps;
        emit TierDiscountSet(tier, discountBps);
    }

    function setTreasury(address _treasury) external onlyAdmin {
        treasury = _treasury;
        emit TreasurySet(_treasury);
    }

    /// @notice Share of each position fee routed to the treasury (bps). The
    ///         rest stays with LPs. Capped at MAX_PROTOCOL_SHARE_BPS.
    function setProtocolFeeShareBps(uint256 bps) external onlyAdmin {
        require(bps <= MAX_PROTOCOL_SHARE_BPS, "> max");
        protocolFeeShareBps = bps;
        emit ProtocolFeeShareSet(bps);
    }

    /// @notice Testnet convenience only — leave OFF in production so all
    ///         orders go through the keeper-executed router.
    function setDirectTradingEnabled(bool enabled) external onlyAdmin {
        directTradingEnabled = enabled;
        emit DirectTradingSet(enabled);
    }

    function setAdmin(address _admin) external onlyAdmin {
        require(_admin != address(0), "!admin");
        emit AdminChanged(admin, _admin);
        admin = _admin;
    }
}
