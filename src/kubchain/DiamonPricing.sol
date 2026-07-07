// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
                    DIAMON (Uniswap V2 fork) on KUB Chain
//////////////////////////////////////////////////////////////

  Confirmed on-chain (bkcscan):
    - Diamon is a standard Uniswap V2 fork (DiamonRouter / DiamonLibrary,
      swapExactETHForTokens / swapTokensForExactETH / getAmountsOut, etc.)
    - Router (mainnet): 0xAb30a29168D792c5e6a54E4bcF1Aec926a3b20FA

  HOW TO FILL THE REMAINING ADDRESSES (one-time, 2 minutes):
    1. FACTORY: open the Router on bkcscan -> "Read Contract" -> call
       factory()  ->  paste result into DIAMON_FACTORY in your deploy script.
       (Also call WETH() to get the canonical KKUB address the router uses.)
    2. KKUB / KUSDT: standard wrapped/stable on KUB. Verify via the
       Diamon swap UI or bkcscan token list, then fill in your deploy script.

  NOTE ON DECIMALS:
    - KUSDT on KUB Chain is a KAP-20 token.
    - Verify decimals on bkcscan: likely 18 dec (KAP-20 standard), NOT 6 like Ethereum USDT.
    - The code below is decimal-agnostic (normalizes via each token's decimals()).
    - The XKubToken vault stores quoteDecimals — set correctly on deploy.
*/

interface IDiamonFactory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function allPairsLength() external view returns (uint256);
}

interface IDiamonPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function totalSupply() external view returns (uint256);
}

interface IDiamonRouter {
    function factory() external view returns (address);
    function WETH() external view returns (address); // canonical KKUB used by router
    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external view returns (uint256[] memory amounts);
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        external pure returns (uint256 amountOut);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface IERC20Meta {
    function balanceOf(address) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @title DiamonPricing
/// @notice Reads Diamon (Uniswap V2 fork) pools to value a spot portfolio in a quote token (KUSDT).
///         Replaces Hyperliquid precompile oracle used in HyperFunTrading.
///         No external oracle — AMM reserves ARE the price.
library DiamonPricing {

    uint256 internal constant WAD = 1e18;

    /// @notice Spot price of `token` denominated in `quote`, scaled to 1e18.
    /// @dev Reads reserves of the token/quote pair directly. Reverts if no pair exists.
    ///      price = reserveQuote / reserveToken, decimal-normalized to 1e18.
    function getSpotPrice(
        address factory,
        address token,
        address quote
    ) internal view returns (uint256 priceWad) {
        if (token == quote) return WAD;

        address pair = IDiamonFactory(factory).getPair(token, quote);
        require(pair != address(0), "DiamonPricing: no pair");

        (uint112 r0, uint112 r1, ) = IDiamonPair(pair).getReserves();
        require(r0 > 0 && r1 > 0, "DiamonPricing: empty pool");

        address t0 = IDiamonPair(pair).token0();
        (uint256 reserveToken, uint256 reserveQuote) =
            (token == t0) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));

        uint8 decToken = IERC20Meta(token).decimals();
        uint8 decQuote = IERC20Meta(quote).decimals();

        // price = (reserveQuote / 10^decQuote) / (reserveToken / 10^decToken) * 1e18
        // rearranged to keep precision:
        priceWad = (reserveQuote * WAD * (10 ** decToken)) / (reserveToken * (10 ** decQuote));
    }

    /// @notice Value `amount` of `token` in `quote` units (quote's native decimals).
    function valueInQuote(
        address factory,
        address token,
        uint256 amount,
        address quote
    ) internal view returns (uint256 quoteAmount) {
        if (amount == 0) return 0;
        if (token == quote) return amount;

        uint256 priceWad = getSpotPrice(factory, token, quote);
        uint8 decToken = IERC20Meta(token).decimals();
        uint8 decQuote = IERC20Meta(quote).decimals();

        // quoteAmount = amount(token) * price * 10^decQuote / 10^decToken / 1e18
        quoteAmount = (amount * priceWad * (10 ** decQuote)) / ((10 ** decToken) * WAD);
    }

    /// @notice Execution-aware quote (includes fee + slippage) via the router.
    ///         Use this (not getSpotPrice) for realistic fill estimates —
    ///         Diamon pools may be thin and slippage is real.
    function getAmountOutRouter(
        address router,
        uint256 amountIn,
        address tokenIn,
        address tokenOut
    ) internal view returns (uint256 amountOut) {
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        uint256[] memory amts = IDiamonRouter(router).getAmountsOut(amountIn, path);
        amountOut = amts[amts.length - 1];
    }

    /// @notice Compare spot (mid) price vs router (execution) price → slippage in bps.
    ///         Guardrail: refuse a swap if slippage is too high.
    function slippageBps(
        address router,
        address factory,
        uint256 amountIn,
        address tokenIn,
        address tokenOut
    ) internal view returns (uint256 bps) {
        uint256 mid    = valueInQuote(factory, tokenIn, amountIn, tokenOut); // ideal, no fee/impact
        uint256 actual = getAmountOutRouter(router, amountIn, tokenIn, tokenOut);
        if (mid == 0 || actual >= mid) return 0;
        bps = ((mid - actual) * 10_000) / mid;
    }
}
