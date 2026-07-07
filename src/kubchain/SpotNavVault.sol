// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./DiamonPricing.sol";

/*//////////////////////////////////////////////////////////////
                HyperFun → KUB Chain: Spot NAV Module
//////////////////////////////////////////////////////////////

  WHAT THIS REPLACES
  ------------------
  HyperFunTrading.getTotalAssets() summed:
      L1 perp account value + L1 spot balance + EVM USDC balance
  reading Hyperliquid precompiles (0x0807 oracle, 0x0800 perp, etc).

  On KUB Chain there are no precompiles and no perp. The vault simply
  HOLDS a basket of spot KAP-20 tokens. NAV = sum of each holding
  valued in the quote token (KUSDT) via Diamon pools.

  This is strictly simpler — no external oracle needed.

  INTEGRATION
  -----------
  - `quote` = KUSDT (your accounting token). Verify decimals on bkcscan.
  - `trackedTokens` = whitelist of assets the vault may hold / trade.
  - getTotalAssets() returns NAV in `quote` native decimals.
  - Feed into XKubToken.getTotalAssets() which scales to 1e18 via quoteDecimals.

  DECIMAL NOTE
  ------------
  If KUSDT is 18 decimals: getTotalAssets() already returns 1e18 scale.
  If KUSDT is 6 decimals:  XKubToken will scale up by 10^(18-6) = 1e12.
*/

contract SpotNavVault {
    using DiamonPricing for address;

    address public immutable router;
    address public immutable dexFactory;
    address public immutable quote;     // KUSDT — accounting unit

    // Whitelist of tokens the vault may hold / trade. Index 0 = quote.
    address[] public trackedTokens;
    mapping(address => bool) public isTracked;

    // Slippage guard for swaps (e.g. 300 = 3%). Diamon pools can be thin.
    uint256 public maxSlippageBps = 300;

    address public admin;
    address public vault; // the XKubToken vault contract that holds the tokens

    event TokenTracked(address indexed token);
    event TokenUntracked(address indexed token);
    event MaxSlippageUpdated(uint256 bps);
    event AdminChanged(address indexed oldAdmin, address indexed newAdmin);

    modifier onlyAdmin() {
        require(msg.sender == admin, "!admin");
        _;
    }

    constructor(
        address _router,
        address _dexFactory,
        address _quote,
        address _vault,
        address _admin
    ) {
        require(_router != address(0) && _dexFactory != address(0), "!router/factory");
        require(_quote != address(0) && _vault != address(0), "!quote/vault");
        router     = _router;
        dexFactory = _dexFactory;
        quote      = _quote;
        vault      = _vault;
        admin      = _admin == address(0) ? msg.sender : _admin;

        // Quote is always tracked (index 0)
        trackedTokens.push(_quote);
        isTracked[_quote] = true;
    }

    // ─── Whitelist Management ──────────────────────────────────────────────────

    /// @notice Add a token to the vault's tradeable whitelist
    /// @dev A Diamon pair vs quote must exist, otherwise the token can't be valued
    function trackToken(address token) external onlyAdmin {
        require(token != address(0) && !isTracked[token], "bad/dup");
        require(
            IDiamonFactory(dexFactory).getPair(token, quote) != address(0),
            "no KUSDT pair on Diamon"
        );
        trackedTokens.push(token);
        isTracked[token] = true;
        emit TokenTracked(token);
    }

    /// @notice Remove a token from the whitelist (cannot remove quote token)
    function untrackToken(address token) external onlyAdmin {
        require(isTracked[token] && token != quote, "!tracked/quote");
        isTracked[token] = false;
        uint256 n = trackedTokens.length;
        for (uint256 i = 0; i < n; i++) {
            if (trackedTokens[i] == token) {
                trackedTokens[i] = trackedTokens[n - 1];
                trackedTokens.pop();
                break;
            }
        }
        emit TokenUntracked(token);
    }

    function setMaxSlippageBps(uint256 bps) external onlyAdmin {
        require(bps >= 10 && bps <= 2000, "10bps-20%");
        maxSlippageBps = bps;
        emit MaxSlippageUpdated(bps);
    }

    function setAdmin(address _admin) external onlyAdmin {
        require(_admin != address(0), "!admin");
        emit AdminChanged(admin, _admin);
        admin = _admin;
    }

    function trackedTokenCount() external view returns (uint256) {
        return trackedTokens.length;
    }

    function getTrackedTokens() external view returns (address[] memory) {
        return trackedTokens;
    }

    // ─── NAV ───────────────────────────────────────────────────────────────────

    /// @notice Total assets of the vault, valued in `quote` (KUSDT) native decimals.
    ///         Drop-in replacement for HyperFunTrading.getTotalAssets() on KUB.
    ///         Result is scaled to 1e18 internally by XKubToken.getTotalAssets().
    function getTotalAssets() public view returns (uint256 totalQuote) {
        uint256 n = trackedTokens.length;
        for (uint256 i = 0; i < n; i++) {
            address tk = trackedTokens[i];
            uint256 bal = IERC20Meta(tk).balanceOf(vault);
            if (bal == 0) continue;
            totalQuote += DiamonPricing.valueInQuote(dexFactory, tk, bal, quote);
        }
    }

    /// @notice Per-token breakdown (useful for UI / debugging)
    function getHoldings() external view returns (
        address[] memory tokens,
        uint256[] memory balances,
        uint256[] memory quoteValues
    ) {
        uint256 n = trackedTokens.length;
        tokens      = new address[](n);
        balances    = new uint256[](n);
        quoteValues = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            address tk = trackedTokens[i];
            uint256 bal = IERC20Meta(tk).balanceOf(vault);
            tokens[i]      = tk;
            balances[i]    = bal;
            quoteValues[i] = bal == 0 ? 0 : DiamonPricing.valueInQuote(dexFactory, tk, bal, quote);
        }
    }

    /// @notice NAV per share (1e18) given the fund token supply.
    ///         Mirrors HyperFunMath.getRawNAV(totalAssets, supply).
    /// @dev Assumes quote is 18 decimals. If quote < 18 dec, scale up before calling.
    function navPerShare(uint256 fundTokenSupply) external view returns (uint256) {
        if (fundTokenSupply == 0) return 1e18;
        return (getTotalAssets() * 1e18) / fundTokenSupply;
    }

    // ─── Pre-trade Slippage Guard ──────────────────────────────────────────────

    /// @notice Reverts if a proposed swap would exceed maxSlippageBps.
    ///         Called by XKubTrading before executing any swap.
    function requireWithinSlippage(
        uint256 amountIn,
        address tokenIn,
        address tokenOut
    ) external view {
        require(isTracked[tokenIn], "tokenIn not whitelisted");
        require(isTracked[tokenOut], "tokenOut not whitelisted");
        uint256 bps = DiamonPricing.slippageBps(router, dexFactory, amountIn, tokenIn, tokenOut);
        require(bps <= maxSlippageBps, "slippage too high");
    }

    /// @notice Preview swap slippage without reverting (for UI)
    function previewSlippage(
        uint256 amountIn,
        address tokenIn,
        address tokenOut
    ) external view returns (uint256 bps) {
        return DiamonPricing.slippageBps(router, dexFactory, amountIn, tokenIn, tokenOut);
    }

    /// @notice Preview output amount for a swap (uses router, includes fee + impact)
    function previewSwap(
        uint256 amountIn,
        address tokenIn,
        address tokenOut
    ) external view returns (uint256 amountOut) {
        return DiamonPricing.getAmountOutRouter(router, amountIn, tokenIn, tokenOut);
    }
}
