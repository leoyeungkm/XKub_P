// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
            Mock Diamon DEX for KUB Testnet
//////////////////////////////////////////////////////////////
  Implements the same interface as Diamon (Uniswap V2 fork):
  - MockDiamonPair     — constant-product AMM pair
  - MockDiamonFactory  — creates / looks up pairs
  - MockDiamonRouter   — swapExactTokensForTokens + getAmountsOut

  Deploy order:
    1. factory = new MockDiamonFactory()
    2. router  = new MockDiamonRouter(factory.address, KKUB.address)
    3. factory.createPair(KKUB, KUSDT) — creates the pair
    4. Mint tokens to pair, call pair.sync() to set reserves
       e.g. 1000 KKUB + 100_000 KUSDT → rate 1 KKUB = 100 KUSDT
*/

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

// ─── Pair ─────────────────────────────────────────────────────────────────────

contract MockDiamonPair {
    address public token0;
    address public token1;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32  private blockTimestampLast;

    address public factory;

    event Sync(uint112 reserve0, uint112 reserve1);

    constructor(address _factory, address _token0, address _token1) {
        factory = _factory;
        // Sort tokens (same as Uniswap V2)
        (token0, token1) = _token0 < _token1 ? (_token0, _token1) : (_token1, _token0);
    }

    function getReserves()
        external view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast)
    {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = blockTimestampLast;
    }

    /// @notice Update reserves to match current token balances (call after seeding liquidity)
    function sync() external {
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        reserve0 = uint112(b0 < type(uint112).max ? b0 : type(uint112).max);
        reserve1 = uint112(b1 < type(uint112).max ? b1 : type(uint112).max);
        blockTimestampLast = uint32(block.timestamp);
        emit Sync(reserve0, reserve1);
    }

    /// @notice Called by router during a swap to update reserves
    function update(uint256 newReserve0, uint256 newReserve1) external {
        require(msg.sender == factory || MockDiamonFactory(factory).isRouter(msg.sender), "!router");
        reserve0 = uint112(newReserve0 < type(uint112).max ? newReserve0 : type(uint112).max);
        reserve1 = uint112(newReserve1 < type(uint112).max ? newReserve1 : type(uint112).max);
        blockTimestampLast = uint32(block.timestamp);
        emit Sync(reserve0, reserve1);
    }

    /// @notice Direct swap called by router (V2 style)
    function swap(uint256 amount0Out, uint256 amount1Out, address to) external {
        require(msg.sender == factory || MockDiamonFactory(factory).isRouter(msg.sender), "!router");
        if (amount0Out > 0) IERC20(token0).transfer(to, amount0Out);
        if (amount1Out > 0) IERC20(token1).transfer(to, amount1Out);
        // Update reserves after swap
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        reserve0 = uint112(b0 < type(uint112).max ? b0 : type(uint112).max);
        reserve1 = uint112(b1 < type(uint112).max ? b1 : type(uint112).max);
        emit Sync(reserve0, reserve1);
    }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

contract MockDiamonFactory {
    mapping(address => mapping(address => address)) private _pairs;
    address[] public allPairs;
    mapping(address => bool) public isRouter;

    address public owner;

    event PairCreated(address indexed token0, address indexed token1, address pair);

    constructor() { owner = msg.sender; }

    function getPair(address tokenA, address tokenB) external view returns (address) {
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return _pairs[t0][t1];
    }

    function allPairsLength() external view returns (uint256) { return allPairs.length; }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "identical");
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(_pairs[t0][t1] == address(0), "pair exists");
        MockDiamonPair p = new MockDiamonPair(address(this), t0, t1);
        pair = address(p);
        _pairs[t0][t1] = pair;
        allPairs.push(pair);
        emit PairCreated(t0, t1, pair);
    }

    function setRouter(address router, bool approved) external {
        require(msg.sender == owner, "!owner");
        isRouter[router] = approved;
    }
}

// ─── Router ───────────────────────────────────────────────────────────────────

contract MockDiamonRouter {
    address public factory;
    address public WETH; // KKUB

    constructor(address _factory, address _kkub) {
        factory = _factory;
        WETH    = _kkub;
        // Caller must invoke MockDiamonFactory.setRouter(routerAddress, true) after deploy
    }

    // ─── View helpers ──────────────────────────────────────────────────────

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        public pure returns (uint256)
    {
        require(amountIn > 0 && reserveIn > 0 && reserveOut > 0, "insufficient");
        // Standard V2 constant-product with 0.3% fee
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator       = amountInWithFee * reserveOut;
        uint256 denominator     = reserveIn * 1000 + amountInWithFee;
        return numerator / denominator;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external view returns (uint256[] memory amounts)
    {
        require(path.length >= 2, "!path");
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i = 0; i < path.length - 1; i++) {
            address pair = MockDiamonFactory(factory).getPair(path[i], path[i + 1]);
            require(pair != address(0), "no pair");
            (uint112 r0, uint112 r1, ) = MockDiamonPair(pair).getReserves();
            address t0 = MockDiamonPair(pair).token0();
            (uint256 rIn, uint256 rOut) = (path[i] == t0) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
            amounts[i + 1] = getAmountOut(amounts[i], rIn, rOut);
        }
    }

    // ─── Swap ──────────────────────────────────────────────────────────────

    /// @notice swapExactTokensForTokens — same signature as Uniswap V2 / Diamon
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(block.timestamp <= deadline, "expired");
        require(path.length >= 2, "!path");

        // Calculate amounts
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i = 0; i < path.length - 1; i++) {
            address pair = MockDiamonFactory(factory).getPair(path[i], path[i + 1]);
            require(pair != address(0), "no pair");
            (uint112 r0, uint112 r1, ) = MockDiamonPair(pair).getReserves();
            address t0 = MockDiamonPair(pair).token0();
            (uint256 rIn, uint256 rOut) = (path[i] == t0) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
            amounts[i + 1] = getAmountOut(amounts[i], rIn, rOut);
        }

        require(amounts[amounts.length - 1] >= amountOutMin, "slippage");

        // Pull tokenIn from msg.sender into first pair
        address firstPair = MockDiamonFactory(factory).getPair(path[0], path[1]);
        IERC20(path[0]).transferFrom(msg.sender, firstPair, amounts[0]);

        // Execute hops
        for (uint256 i = 0; i < path.length - 1; i++) {
            address pair = MockDiamonFactory(factory).getPair(path[i], path[i + 1]);
            address t0   = MockDiamonPair(pair).token0();
            bool zeroForOne = (path[i] == t0);

            address recipient = (i < path.length - 2)
                ? MockDiamonFactory(factory).getPair(path[i + 1], path[i + 2])
                : to;

            uint256 amount0Out = zeroForOne ? 0 : amounts[i + 1];
            uint256 amount1Out = zeroForOne ? amounts[i + 1] : 0;
            MockDiamonPair(pair).swap(amount0Out, amount1Out, recipient);
        }
    }
}
