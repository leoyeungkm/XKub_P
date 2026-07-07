// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
        XKub Perp: shared interfaces (avoids circular imports)
//////////////////////////////////////////////////////////////*/

interface IXKubPriceOracle {
    function getPrice(bytes32 marketId, uint256 maxAge) external view returns (uint256);
    function peekPrice(bytes32 marketId) external view returns (uint256 price, uint256 updatedAt);
}

interface IXKubPerpPool {
    /// @return Pool value in USD 1e18 (KUSDT balance minus aggregate trader PnL)
    function poolValueUsd() external view returns (uint256);
    /// @notice Pay trader profit out of the pool. Only callable by the market.
    function payOutUsd(address to, uint256 amountUsd) external;
}

interface IXKubPerpMarket {
    /// @return Aggregate unrealized trader PnL across all markets, USD 1e18, signed.
    ///         Positive = traders in profit (pool owes), negative = traders in loss.
    function getGlobalPnlUsd() external view returns (int256);
    /// @return Total open interest (long + short, all markets), USD 1e18
    function totalOpenInterestUsd() external view returns (uint256);
}
