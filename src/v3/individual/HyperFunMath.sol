// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HyperFunMath
/// @notice External library — calc bodies live here, not in HyperFunToken.
///         Reduces Token bytecode by ~300 bytes.
library HyperFunMath {

    uint256 private constant BPS = 10_000;
    uint256 private constant PRECISION = 1e18;

    /// @notice AMM quote: USDC in → tokens out (with price impact).
    ///         Pure — all state must be passed in by caller.
    function calculateTokensOutPure(
        uint256 usdcIn,
        uint256 nav,
        uint256 effVirtualBase,
        uint256 effVirtualTokens,
        uint256 maxPremiumBps,
        uint256 currentBuyPrice   // getBuyPrice() result
    ) external pure returns (
        uint256 tokensOut,
        uint256 newPrice,
        uint256 priceImpactBps
    ) {
        uint256 virtualBaseUsdc = (effVirtualBase * nav) / PRECISION;
        uint256 usdcIn18 = usdcIn * 1e12;
        tokensOut = (effVirtualTokens * usdcIn18) / (virtualBaseUsdc + usdcIn18);

        uint256 newVirtualBaseUsdc = virtualBaseUsdc + usdcIn18;
        uint256 newVirtualTokens  = effVirtualTokens - tokensOut;

        if (newVirtualTokens > 0) {
            newPrice = (newVirtualBaseUsdc * PRECISION) / newVirtualTokens;
            uint256 maxPrice = (nav * (BPS + maxPremiumBps)) / BPS;
            if (newPrice > maxPrice) newPrice = maxPrice;
        } else {
            newPrice = (nav * (BPS + maxPremiumBps)) / BPS;
        }

        if (currentBuyPrice > 0 && newPrice > currentBuyPrice) {
            priceImpactBps = ((newPrice - currentBuyPrice) * BPS) / currentBuyPrice;
        }
    }

    /// @notice TWAP NAV smoothing: exponential decay toward instantNav.
    ///         All state read by caller and passed in as pure parameters.
    function calcSmoothedNAV(
        uint256 instantNav,
        uint256 storedTwapNav,
        uint256 storedTwapNavTime,
        uint256 halfLife,          // twapMaxChangePerMin, 0 → defaults to 600
        uint256 blockTimestamp
    ) external pure returns (uint256) {
        if (storedTwapNav == 0 || storedTwapNavTime == 0) return instantNav;
        if (instantNav >= storedTwapNav) return instantNav;

        uint256 elapsed = blockTimestamp - storedTwapNavTime;
        if (elapsed == 0) return storedTwapNav;

        uint256 hl = halfLife > 0 ? halfLife : 600;
        uint256 gap = storedTwapNav - instantNav;
        uint256 periods = elapsed / hl;
        uint256 remaining = elapsed % hl;

        if (periods > 0) {
            gap = periods >= 10 ? gap >> 10 : gap >> periods;
        }
        if (remaining > 0 && gap > 0) {
            uint256 partialReduction = (gap * remaining) / (hl * 2);
            gap = gap > partialReduction ? gap - partialReduction : 0;
        }
        return instantNav + gap;
    }

    /// @notice Raw NAV: total assets / supply (no virtual addition).
    ///         Moved here from Token to save Token bytecode.
    function getRawNAV(uint256 totalAssets, uint256 supply) external pure returns (uint256) {
        if (supply == 0) return PRECISION;
        return (totalAssets * PRECISION) / supply;
    }

    /// @notice Sell price capped by available liquidity (EVM + L1 Spot).
    ///         Moved here from Token to save Token bytecode.
    function getSellPriceCapped(
        uint256 buyPrice,
        uint256 availableLiquidity6,  // getAvailableLiquidity() result (6 decimals)
        uint256 supply                 // totalSupply() (18 decimals)
    ) external pure returns (uint256) {
        if (supply == 0) return buyPrice;
        uint256 maxPrice = (availableLiquidity6 * 1e12 * PRECISION) / supply;
        return buyPrice < maxPrice ? buyPrice : maxPrice;
    }

    /// @notice AMM quote: tokens in → USDC out (with price impact).
    ///         Uses instant NAV (not smoothed) — matches sell() execution.
    function calculateUsdcOutPure(
        uint256 tokensIn,
        uint256 nav,
        uint256 effVirtualBase,
        uint256 effVirtualTokens,
        uint256 maxDiscountBps
    ) external pure returns (
        uint256 usdcOut,
        uint256 newPrice,
        uint256 priceImpactBps
    ) {
        uint256 virtualBaseUsdc = (effVirtualBase * nav) / PRECISION;
        uint256 usdcOut18 = (virtualBaseUsdc * tokensIn) / (effVirtualTokens + tokensIn);
        usdcOut = usdcOut18 / 1e12;

        uint256 newVirtualBaseUsdc = virtualBaseUsdc - usdcOut18;
        uint256 newVirtualTokens  = effVirtualTokens + tokensIn;

        newPrice = (newVirtualBaseUsdc * PRECISION) / newVirtualTokens;
        uint256 minPrice = (nav * (BPS - maxDiscountBps)) / BPS;
        if (newPrice < minPrice) newPrice = minPrice;

        uint256 oldPrice = effVirtualTokens > 0
            ? (effVirtualBase * nav) / effVirtualTokens
            : 0;
        if (oldPrice > 0 && newPrice < oldPrice) {
            priceImpactBps = ((oldPrice - newPrice) * BPS) / oldPrice;
        }
    }
}
