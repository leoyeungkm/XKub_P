// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IXKubPerp.sol";

interface IXKubReferral {
    function getRebate(address trader) external view returns (address referrer, uint256 rebateBps);
    function accrue(address referrer, address trader, uint256 usd) external;
    function discountOf(address trader) external view returns (uint256 discountBps);
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
    uint256 public maxProfitBps        = 30000;  // 300% of collateral (limits straddle drain)
    uint256 public minCollateralUsd    = 10e18;  // 10 KUSDT
    uint256 public maxPriceAge         = 300;    // seconds

    // Anti-scalp: closing within rapidCloseWindow of the last increase pays an
    // extra LP fee (protects LPs from oracle-lag round-trips). Goes 100% to the
    // pool — not split with protocol/referral.
    uint256 public rapidCloseFeeBps    = 1;      // 0.01% of closed size
    uint256 public rapidCloseWindow    = 30;     // seconds
    mapping(bytes32 => uint64) public lastIncreaseAt; // positionKey → last open/increase time

    // VIP fee tiers: a trader's tier gives a discount on the position fee.
    // Tier 0 = default (0% discount). Tiers auto-upgrade with traded volume
    // (volumeThreshold); admin can also bump a trader manually (feeTier) — the
    // effective tier is the higher of the two.
    mapping(address => uint8)  public feeTier;            // manual override tier
    mapping(uint8 => uint256)  public tierDiscountBps;    // tier → % off the fee (bps)
    mapping(uint8 => uint256)  public volumeThreshold;    // tier → 14-day volume (USD 1e18) to earn it
    mapping(address => uint256) public userVolumeUsd;     // lifetime traded notional (display)
    mapping(address => mapping(uint256 => uint256)) public dailyVolumeUsd; // trader → dayIndex → volume
    uint8 public constant MAX_TIER = 10;
    uint256 public constant VOLUME_WINDOW_DAYS = 14;      // rolling window for tier volume

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
    event VolumeThresholdSet(uint8 indexed tier, uint256 volumeUsd);
    event TreasurySet(address indexed treasury);
    event ProtocolFeeShareSet(uint256 bps);
    event ProtocolFeePaid(address indexed treasury, uint256 usd);
    event RapidCloseParamsSet(uint256 feeBps, uint256 windowSeconds);

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

        // One direction per account per market. Holding both sides would let a
        // trader exploit the asymmetry between the 900% profit cap and the 100%
        // liquidation floor (a hedged straddle that drains the LP pool on a big
        // move). Close the opposite side first.
        if (sizeDeltaUsd > 0) {
            require(positions[_positionKey(owner, marketId, !isLong)].sizeUsd == 0, "opposite side open");
        }

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
            lastIncreaseAt[key] = uint64(block.timestamp); // start the rapid-close clock
            userVolumeUsd[owner] += sizeDeltaUsd;                          // lifetime (display)
            dailyVolumeUsd[owner][block.timestamp / 1 days] += sizeDeltaUsd; // for 14-day VIP tiers
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
        _decreasePosition(msg.sender, marketId, isLong, sizeDeltaUsd, msg.sender);
    }

    /// @notice Router entry — payout goes to the position owner's wallet.
    function decreasePositionFor(
        address owner,
        bytes32 marketId,
        bool isLong,
        uint256 sizeDeltaUsd
    ) external nonReentrant onlyRouter {
        _decreasePosition(owner, marketId, isLong, sizeDeltaUsd, owner);
    }

    /// @notice Router entry that sends the payout to `payoutTo` (the router)
    ///         instead of the owner's wallet — used for 1-click closes so funds
    ///         return to the owner's trading balance. Returns KUSDT paid out.
    function decreasePositionForTo(
        address owner,
        bytes32 marketId,
        bool isLong,
        uint256 sizeDeltaUsd,
        address payoutTo
    ) external nonReentrant onlyRouter returns (uint256 payoutTokens) {
        return _decreasePosition(owner, marketId, isLong, sizeDeltaUsd, payoutTo);
    }

    /// @dev Close all or part of a position. Collateral is released
    ///      proportionally; PnL realized on the closed portion. Payout (KUSDT)
    ///      goes to `payoutTo`; returns the token amount paid.
    function _decreasePosition(
        address owner,
        bytes32 marketId,
        bool isLong,
        uint256 sizeDeltaUsd,
        address payoutTo
    ) internal returns (uint256 payoutTokens) {
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

        // Extra LP fee for closing within the rapid-close window (100% to pool)
        uint256 rapidLpFeeUsd = 0;
        uint64 openedAt = lastIncreaseAt[key];
        if (openedAt != 0 && block.timestamp - openedAt < rapidCloseWindow) {
            rapidLpFeeUsd = (sizeDeltaUsd * rapidCloseFeeBps) / 10000;
        }

        // Split payout between trader / pool
        int256 grossUsd = int256(collateralShare) + pnlUsd - int256(closeFeeUsd) - int256(rapidLpFeeUsd);
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
        if (fromCollateralUsd > 0) {
            uint256 t = fromCollateralUsd / scaler;
            kusdt.safeTransfer(payoutTo, t);
            payoutTokens += t;
        }
        if (fromPoolUsd > 0) {
            pool.payOutUsd(payoutTo, fromPoolUsd);
            payoutTokens += fromPoolUsd / scaler;
        }
        _distributeFees(owner, closeFeeUsd);

        emit PositionDecreased(owner, marketId, isLong, sizeDeltaUsd, price, pnlUsd, payoutUsd, closeFeeUsd + borrowFeeUsd + rapidLpFeeUsd);
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

        uint256 sizeSnapshot = p.sizeUsd;
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

        // Charge the same position fee a close would, so liquidating isn't a
        // fee-free exit. Drawn from the pool's take (capped by it), then split
        // to protocol/referral like any other fee — closes the fee asymmetry
        // that a straddle's losing side could otherwise dodge.
        uint256 liqFeeUsd = (sizeSnapshot * positionFeeBps) / 10000;
        if (liqFeeUsd > toPoolUsd) liqFeeUsd = toPoolUsd;
        _distributeFees(owner, liqFeeUsd);

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

    /// @notice A trader's trailing 14-day traded volume (USD 1e18).
    function weightedVolumeUsd(address trader) public view returns (uint256 total) {
        uint256 today = block.timestamp / 1 days;
        for (uint256 i = 0; i < VOLUME_WINDOW_DAYS && i <= today; i++) {
            total += dailyVolumeUsd[trader][today - i];
        }
    }

    /// @notice Highest VIP tier a trader has earned by 14-day volume.
    function earnedTier(address trader) public view returns (uint8) {
        uint256 vol = weightedVolumeUsd(trader);
        uint8 best = 0;
        for (uint8 t = 1; t <= MAX_TIER; t++) {
            uint256 thr = volumeThreshold[t];
            if (thr != 0 && vol >= thr) best = t;
        }
        return best;
    }

    /// @notice Effective VIP tier: the higher of the volume-earned tier and any
    ///         manual admin override.
    function effectiveTier(address trader) public view returns (uint8) {
        uint8 earned = earnedTier(trader);
        uint8 manual = feeTier[trader];
        return earned > manual ? earned : manual;
    }

    /// @notice The position-fee rate a trader actually pays, after their VIP
    ///         tier discount and any referral discount. Basis points of size.
    function effectiveFeeBps(address trader) public view returns (uint256) {
        uint256 discount = tierDiscountBps[effectiveTier(trader)];
        if (referral != address(0)) {
            try IXKubReferral(referral).discountOf(trader) returns (uint256 refDisc) {
                discount += refDisc;
            } catch {}
        }
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

    /// @notice Cumulative traded volume (USD 1e18) required to auto-earn a tier.
    function setVolumeThreshold(uint8 tier, uint256 volumeUsd) external onlyAdmin {
        require(tier >= 1 && tier <= MAX_TIER, "bad tier");
        volumeThreshold[tier] = volumeUsd;
        emit VolumeThresholdSet(tier, volumeUsd);
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

    /// @notice Configure the rapid-close LP fee (extra fee for closing soon
    ///         after opening). feeBps ≤ 1% and window ≤ 10 minutes.
    function setRapidCloseParams(uint256 feeBps, uint256 windowSeconds) external onlyAdmin {
        require(feeBps <= 100, "fee <= 1%");
        require(windowSeconds <= 600, "window <= 10m");
        rapidCloseFeeBps = feeBps;
        rapidCloseWindow = windowSeconds;
        emit RapidCloseParamsSet(feeBps, windowSeconds);
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
