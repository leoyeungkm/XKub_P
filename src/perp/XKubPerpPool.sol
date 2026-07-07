// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./IXKubPerp.sol";

/*//////////////////////////////////////////////////////////////
                XKub Perp: KUSDT Liquidity Pool (XPLP)
//////////////////////////////////////////////////////////////

  MODEL (GMX-v1 style)
  --------------------
  A single KUSDT pool is the counterparty to every trader position:
  - trader losses and all fees flow INTO the pool
  - trader profits are paid OUT of the pool
  - LPs deposit KUSDT and mint XPLP shares priced at pool value

  POOL VALUE
  ----------
  poolValueUsd = KUSDT balance (as USD 1e18)
               - aggregate unrealized trader PnL (signed, from the market)
  If traders are collectively in profit the pool is worth less; in loss,
  worth more. Same accounting as GLP.

  WITHDRAW GUARD
  --------------
  Withdrawals must leave enough KUSDT to cover reserveFactorBps of the
  total open interest, so open positions can always be paid.

  UNITS
  -----
  KUSDT may be 18 or 6 decimals — everything internal is USD 1e18,
  converted at the edges. 1 KUSDT is assumed = 1 USD.
*/

contract XKubPerpPool is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20  public immutable kusdt;
    uint256 public immutable quoteDecimals;
    uint256 private immutable scaler; // 10^(18 - quoteDecimals)

    // Burned to address(0) on the first deposit so total supply can never
    // return to a tiny number — neutralises the ERC4626 inflation/donation
    // attack (a first depositor of 1 wei + a large direct transfer).
    uint256 internal constant MINIMUM_LIQUIDITY = 1e6;

    address public admin;
    IXKubPerpMarket public market; // set once after market deployment

    // KUSDT that must remain in the pool: totalOI * reserveFactorBps / 1e4
    uint256 public reserveFactorBps = 5000;

    // Anti-sandwich: LPs cannot withdraw within cooldown of their last deposit.
    // Transfers propagate the timer so it can't be dodged via a fresh wallet.
    uint256 public withdrawCooldown = 900; // 15 min
    mapping(address => uint256) public lastDepositAt;

    event Deposited(address indexed lp, uint256 kusdtAmount, uint256 shares);
    event Withdrawn(address indexed lp, uint256 kusdtAmount, uint256 shares);
    event PaidOut(address indexed to, uint256 kusdtAmount);
    event MarketSet(address indexed market);
    event ReserveFactorUpdated(uint256 bps);
    event AdminChanged(address indexed oldAdmin, address indexed newAdmin);

    modifier onlyAdmin() {
        require(msg.sender == admin, "!admin");
        _;
    }

    modifier onlyMarket() {
        require(msg.sender == address(market), "!market");
        _;
    }

    constructor(address _kusdt, uint256 _quoteDecimals, address _admin)
        ERC20("XKub Perp LP", "XPLP")
    {
        require(_kusdt != address(0), "!kusdt");
        require(_quoteDecimals == 18 || _quoteDecimals == 6, "dec 18|6");
        kusdt         = IERC20(_kusdt);
        quoteDecimals = _quoteDecimals;
        scaler        = 10 ** (18 - _quoteDecimals);
        admin         = _admin == address(0) ? msg.sender : _admin;
    }

    // ─── LP Entry / Exit ───────────────────────────────────────────────────────

    /// @notice Deposit KUSDT, mint XPLP at current pool value
    function deposit(uint256 kusdtAmount) external nonReentrant returns (uint256 shares) {
        require(kusdtAmount > 0, "!amount");
        uint256 amountUsd = kusdtAmount * scaler;
        uint256 valueBefore = poolValueUsd();
        uint256 supply = totalSupply();

        if (supply == 0 || valueBefore == 0) {
            // First deposit: permanently lock MINIMUM_LIQUIDITY shares so the
            // supply floor blocks share-price inflation by later donations.
            require(amountUsd > MINIMUM_LIQUIDITY, "first deposit too small");
            shares = amountUsd - MINIMUM_LIQUIDITY;
            _mint(address(0xdEaD), MINIMUM_LIQUIDITY);
        } else {
            shares = (amountUsd * supply) / valueBefore;
        }
        require(shares > 0, "!shares");

        lastDepositAt[msg.sender] = block.timestamp;
        kusdt.safeTransferFrom(msg.sender, address(this), kusdtAmount);
        _mint(msg.sender, shares);
        emit Deposited(msg.sender, kusdtAmount, shares);
    }

    /// @notice Burn XPLP, withdraw proportional KUSDT (subject to reserve guard)
    function withdraw(uint256 shares) external nonReentrant returns (uint256 kusdtAmount) {
        require(shares > 0, "!shares");
        require(block.timestamp >= lastDepositAt[msg.sender] + withdrawCooldown, "cooldown");
        uint256 supply = totalSupply();
        uint256 amountUsd = (shares * poolValueUsd()) / supply;
        kusdtAmount = amountUsd / scaler;
        require(kusdtAmount > 0, "!amount");

        uint256 balance = kusdt.balanceOf(address(this));
        require(kusdtAmount <= balance, "insufficient liquidity");
        require(balance - kusdtAmount >= _reservedKusdt(), "reserved for OI");

        _burn(msg.sender, shares);
        kusdt.safeTransfer(msg.sender, kusdtAmount);
        emit Withdrawn(msg.sender, kusdtAmount, shares);
    }

    // ─── Market Hooks ──────────────────────────────────────────────────────────

    /// @notice Pay trader profit out of the pool. Only the market may call.
    function payOutUsd(address to, uint256 amountUsd) external onlyMarket {
        uint256 kusdtAmount = amountUsd / scaler;
        if (kusdtAmount == 0) return;
        require(kusdt.balanceOf(address(this)) >= kusdtAmount, "pool underfunded");
        kusdt.safeTransfer(to, kusdtAmount);
        emit PaidOut(to, kusdtAmount);
    }

    // ─── Valuation ─────────────────────────────────────────────────────────────

    /// @notice Pool value in USD 1e18: KUSDT balance minus signed trader PnL, floored at 0
    function poolValueUsd() public view returns (uint256) {
        int256 value = int256(kusdt.balanceOf(address(this)) * scaler);
        if (address(market) != address(0)) {
            value -= market.getGlobalPnlUsd();
        }
        return value <= 0 ? 0 : uint256(value);
    }

    /// @notice XPLP price in USD 1e18 (1e18 when pool is empty)
    function sharePriceUsd() external view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 1e18;
        return (poolValueUsd() * 1e18) / supply;
    }

    function _reservedKusdt() internal view returns (uint256) {
        if (address(market) == address(0)) return 0;
        uint256 reservedUsd = (market.totalOpenInterestUsd() * reserveFactorBps) / 10000;
        return reservedUsd / scaler;
    }

    // ─── Admin ─────────────────────────────────────────────────────────────────

    /// @notice One-time wiring of the market contract
    function setMarket(address _market) external onlyAdmin {
        require(_market != address(0), "!market");
        require(address(market) == address(0), "market set");
        market = IXKubPerpMarket(_market);
        emit MarketSet(_market);
    }

    function setReserveFactorBps(uint256 bps) external onlyAdmin {
        require(bps <= 10000, ">100%");
        reserveFactorBps = bps;
        emit ReserveFactorUpdated(bps);
    }

    function setWithdrawCooldown(uint256 seconds_) external onlyAdmin {
        require(seconds_ <= 7 days, "> 7d");
        withdrawCooldown = seconds_;
    }

    /// @dev Propagate the deposit timer on transfers so the cooldown cannot
    ///      be dodged by moving XPLP to a fresh wallet. The inherited timer is
    ///      balance-weighted, so a dust transfer barely moves the receiver's
    ///      clock — this blocks the griefing vector where anyone resets a
    ///      victim's cooldown by sending 1 wei of XPLP.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && value > 0) {
            uint256 fromTime = lastDepositAt[from];
            uint256 toTime = lastDepositAt[to];
            if (fromTime > toTime) {
                uint256 toBal = balanceOf(to);
                // weighted average of the two clocks by balance vs incoming value
                lastDepositAt[to] = (toTime * toBal + fromTime * value) / (toBal + value);
            }
        }
        super._update(from, to, value);
    }

    function setAdmin(address _admin) external onlyAdmin {
        require(_admin != address(0), "!admin");
        emit AdminChanged(admin, _admin);
        admin = _admin;
    }
}
