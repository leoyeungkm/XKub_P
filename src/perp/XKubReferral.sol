// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/*//////////////////////////////////////////////////////////////
                XKub Perp: Referral Registry + Rebates
//////////////////////////////////////////////////////////////

  MODEL
  -----
  - Anyone registers a bytes32 code they own (one code per address).
  - A trader binds to a code once (updatable until their first rebate).
  - On every position fee, the market credits the referrer a rebate:
      rebate = positionFee * rebateBps(code)   (default or per-code tier)
    The rebate KUSDT is forwarded here by the pool; the market then
    calls accrue() to book it. Referrers claim() their balance.

  WHY THIS SHAPE (Level-Finance-style bugs avoided)
  -------------------------------------------------
  - No tier multipliers or level math that could inflate a claim.
  - claimable[referrer] is only ever increased by the market (onlyMarket),
    and always equals KUSDT actually delivered to this contract.
  - claim() is nonReentrant and zeroes before transfer (CEI); a claim can
    never exceed what was accrued, so there is no double-claim / drain.
  - Self-referral is rejected. Single level only (no recursive payouts).

  UNITS
  -----
  Rebates are accrued in USD 1e18 and paid in KUSDT native units.
*/

contract XKubReferral is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20  public immutable kusdt;
    uint256 private immutable scaler; // 10^(18 - quoteDecimals)

    address public admin;
    address public market; // set once; the only address allowed to accrue

    // Rebate as a fraction of the position fee. 2000 = 20% of the fee.
    uint256 public defaultRebateBps = 1000; // 10%
    uint256 public constant MAX_REBATE_BPS = 5000; // 50% of the fee, hard cap

    // Fee discount a referred trader gets (bps of the position fee). The friend
    // saves; the market applies this in effectiveFeeBps.
    uint256 public referredDiscountBps = 1000; // 10% off for referred traders

    mapping(bytes32 => address) public codeOwner;      // code → referrer
    mapping(address => bytes32) public ownerCode;      // referrer → their code
    mapping(bytes32 => uint256) public codeRebateBps;  // per-code override (0 = use default)
    mapping(address => bytes32) public referredBy;     // trader → code they trade under
    mapping(address => bool)    public bound;          // trader binding locked after first rebate

    mapping(address => uint256) public claimableUsd;   // referrer → unclaimed rebate (USD 1e18)
    uint256 public totalRebatedUsd;

    event CodeRegistered(bytes32 indexed code, address indexed owner);
    event Referred(address indexed trader, bytes32 indexed code, address indexed referrer);
    event RebateAccrued(address indexed referrer, address indexed trader, uint256 usd);
    event RebateClaimed(address indexed referrer, uint256 kusdt);
    event DefaultRebateUpdated(uint256 bps);
    event ReferredDiscountUpdated(uint256 bps);
    event CodeRebateUpdated(bytes32 indexed code, uint256 bps);
    event MarketSet(address indexed market);
    event AdminChanged(address indexed oldAdmin, address indexed newAdmin);

    modifier onlyAdmin() {
        require(msg.sender == admin, "!admin");
        _;
    }

    modifier onlyMarket() {
        require(msg.sender == market, "!market");
        _;
    }

    constructor(address _kusdt, uint256 _quoteDecimals, address _admin) {
        require(_kusdt != address(0), "!kusdt");
        require(_quoteDecimals == 18 || _quoteDecimals == 6, "dec 18|6");
        kusdt  = IERC20(_kusdt);
        scaler = 10 ** (18 - _quoteDecimals);
        admin  = _admin == address(0) ? msg.sender : _admin;
    }

    // ─── Codes & binding ───────────────────────────────────────────────────────

    /// @notice Claim an unused code. One code per address.
    function registerCode(bytes32 code) external {
        require(code != bytes32(0), "!code");
        require(codeOwner[code] == address(0), "code taken");
        require(ownerCode[msg.sender] == bytes32(0), "have code");
        codeOwner[code] = msg.sender;
        ownerCode[msg.sender] = code;
        emit CodeRegistered(code, msg.sender);
    }

    /// @notice Bind yourself to a referral code. Allowed until your first
    ///         rebate is accrued (prevents rewriting history after the fact).
    function setReferrer(bytes32 code) external {
        require(!bound[msg.sender], "locked");
        address ref = codeOwner[code];
        require(ref != address(0), "unknown code");
        require(ref != msg.sender, "self referral");
        referredBy[msg.sender] = code;
        emit Referred(msg.sender, code, ref);
    }

    // ─── Market hook ───────────────────────────────────────────────────────────

    /// @notice Rebate bps and referrer for a trader (0 addr if none). View for
    ///         the market to size the rebate before forwarding the KUSDT.
    function getRebate(address trader) external view returns (address referrer, uint256 rebateBps) {
        bytes32 code = referredBy[trader];
        if (code == bytes32(0)) return (address(0), 0);
        referrer = codeOwner[code];
        if (referrer == address(0) || referrer == trader) return (address(0), 0);
        uint256 bps = codeRebateBps[code];
        rebateBps = bps == 0 ? defaultRebateBps : bps;
    }

    /// @notice Fee discount (bps) a referred trader gets — 0 if not referred.
    function discountOf(address trader) external view returns (uint256) {
        bytes32 code = referredBy[trader];
        if (code == bytes32(0)) return 0;
        address ref = codeOwner[code];
        if (ref == address(0) || ref == trader) return 0;
        return referredDiscountBps;
    }

    /// @notice Book a rebate the pool has just delivered to this contract.
    ///         Only the market may call. `usd` must equal the KUSDT amount
    ///         (in USD 1e18) transferred here for this rebate.
    function accrue(address referrer, address trader, uint256 usd) external onlyMarket {
        require(referrer != address(0) && usd > 0, "bad accrue");
        bound[trader] = true; // lock the trader's binding after first rebate
        claimableUsd[referrer] += usd;
        totalRebatedUsd += usd;
        emit RebateAccrued(referrer, trader, usd);
    }

    // ─── Claim ─────────────────────────────────────────────────────────────────

    /// @notice Withdraw accrued rebates in KUSDT.
    function claim() external nonReentrant returns (uint256 kusdtAmount) {
        uint256 usd = claimableUsd[msg.sender];
        require(usd > 0, "nothing");
        kusdtAmount = usd / scaler;
        require(kusdtAmount > 0, "dust");
        // Zero before transfer (CEI). Leftover sub-unit dust stays booked.
        claimableUsd[msg.sender] = usd - kusdtAmount * scaler;
        kusdt.safeTransfer(msg.sender, kusdtAmount);
        emit RebateClaimed(msg.sender, kusdtAmount);
    }

    // ─── Admin ─────────────────────────────────────────────────────────────────

    function setMarket(address _market) external onlyAdmin {
        require(_market != address(0), "!market");
        require(market == address(0), "market set");
        market = _market;
        emit MarketSet(_market);
    }

    function setDefaultRebateBps(uint256 bps) external onlyAdmin {
        require(bps <= MAX_REBATE_BPS, "> max");
        defaultRebateBps = bps;
        emit DefaultRebateUpdated(bps);
    }

    function setReferredDiscountBps(uint256 bps) external onlyAdmin {
        require(bps <= MAX_REBATE_BPS, "> max");
        referredDiscountBps = bps;
        emit ReferredDiscountUpdated(bps);
    }

    /// @notice Per-code rebate tier (e.g. higher rate for a partner). 0 resets to default.
    function setCodeRebateBps(bytes32 code, uint256 bps) external onlyAdmin {
        require(codeOwner[code] != address(0), "unknown code");
        require(bps <= MAX_REBATE_BPS, "> max");
        codeRebateBps[code] = bps;
        emit CodeRebateUpdated(code, bps);
    }

    function setAdmin(address _admin) external onlyAdmin {
        require(_admin != address(0), "!admin");
        emit AdminChanged(admin, _admin);
        admin = _admin;
    }
}
