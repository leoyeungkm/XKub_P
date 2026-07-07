// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "./DiamonPricing.sol";

/*//////////////////////////////////////////////////////////////
              XKubTrading — Diamon DEX Trading Module
//////////////////////////////////////////////////////////////

  REPLACES: HyperFunTrading.sol (Hyperliquid CoreWriter / L1 perp)

  WHAT CHANGED
  ------------
  - All CoreWriter / L1 precompile calls removed.
  - Trading    = Diamon Router swapExactTokensForTokens (Uniswap V2 fork).
  - NAV        = SpotNavVault.getTotalAssets() via Diamon reserve reads.
  - No L1/EVM split — all assets are EVM KAP-20 tokens.
  - No pending sells — liquidateForRedemption() auto-swaps held tokens → KUSDT
    in the same tx as the user's sell(). Immediate settlement, no waiting.
  - API wallet auth retained (off-chain bots can call executeSwap).
  - Builder DEX / perp margin functions fully removed.

  REDEMPTION FLOW (no pending sell)
  ----------------------------------
  1. User calls XKubToken.sell()
  2. If vault KUSDT < needed → XKubToken calls liquidateForRedemption(shortfall)
  3. This contract iterates tracked tokens, swaps each → KUSDT via Diamon
     until shortfall covered (uses maxRedemptionSlippageBps, default 5%)
  4. XKubToken completes transfer to user in same tx

  NORMAL SWAP FLOW (leader)
  --------------------------
  1. Leader calls executeSwap(tokenIn, tokenOut, amountIn, minOut)
  2. Slippage checked via SpotNavVault.requireWithinSlippage() (default 3%)
  3. vault.approveForTrading(tokenIn, router, amountIn) → router approved
  4. router.swapExactTokensForTokens() — tokenOut lands in vault
*/

// IDiamonRouter is imported from DiamonPricing.sol (includes swapExactTokensForTokens)

interface ISpotNavVault {
    function getTotalAssets() external view returns (uint256);
    function isTracked(address token) external view returns (bool);
    function requireWithinSlippage(uint256 amountIn, address tokenIn, address tokenOut) external view;
    function previewSwap(uint256 amountIn, address tokenIn, address tokenOut) external view returns (uint256);
    function previewSlippage(uint256 amountIn, address tokenIn, address tokenOut) external view returns (uint256);
    function getTrackedTokens() external view returns (address[] memory);
}

interface IXKubFactory {
    function owner() external view returns (address);
}

interface IXKubToken {
    function leader() external view returns (address);
    function admin() external view returns (address);
    function totalSupply() external view returns (uint256);
    /// @notice Vault approves `spender` to spend `token` — only callable by trading module
    function approveForTrading(address token, address spender, uint256 amount) external;
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// @title XKubTrading — Spot DEX trading module for XKubToken on KUB Chain
contract XKubTrading is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuardUpgradeable {

    // ─── Diamon DEX ────────────────────────────────────────────────────────────
    // Router (mainnet): 0xAb30a29168D792c5e6a54E4bcF1Aec926a3b20FA
    // dexFactory: call router.factory() on bkcscan
    address public router;
    address public dexFactory;
    address public quote;       // KUSDT

    // ─── Protocol ──────────────────────────────────────────────────────────────
    address public vault;
    address public factory;
    address public spotNavVault;

    // ─── Redemption slippage tolerance ────────────────────────────────────────
    // Separate (higher) limit used when auto-liquidating to cover a redemption.
    // Normal leader swaps use SpotNavVault.maxSlippageBps (default 3%).
    // Redemption liquidation slippage limit (set in initializer, default 500 = 5%)
    uint256 public maxRedemptionSlippageBps;

    // ─── API Wallet Auth ───────────────────────────────────────────────────────
    struct ApiWalletInfo {
        bool active;
        uint256 expiresAt;
        string name;
    }
    mapping(address => ApiWalletInfo) public apiWalletInfo;

    uint256 public constant MIN_API_WALLET_DURATION = 60 days;
    uint256 public constant MAX_API_WALLET_DURATION = 180 days;

    // ─── Events ────────────────────────────────────────────────────────────────
    event SwapExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event SwapPathExecuted(address[] path, uint256 amountIn, uint256 amountOut);
    event RedemptionLiquidation(address indexed token, uint256 amountIn, uint256 kusdtOut, uint256 remainingShortfall);
    event MaxRedemptionSlippageUpdated(uint256 bps);
    event ApiWalletAdded(address indexed apiWallet, string name, uint256 expiresAt);
    event ApiWalletRemoved(address indexed apiWallet);
    event ApiWalletRenewed(address indexed apiWallet, uint256 newExpiresAt);
    event SpotNavVaultUpdated(address indexed newVault);

    // ─── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyVaultOrLeader() {
        require(
            msg.sender == vault ||
            msg.sender == IXKubToken(vault).leader() ||
            _isApiWalletValid(msg.sender),
            "!Auth"
        );
        _;
    }

    modifier onlyVault() {
        require(msg.sender == vault, "Only vault");
        _;
    }

    modifier onlyAdmin() {
        require(msg.sender == IXKubToken(vault).admin(), "Not admin");
        _;
    }

    function _isApiWalletValid(address wallet) internal view returns (bool) {
        ApiWalletInfo storage info = apiWalletInfo[wallet];
        return info.active && block.timestamp < info.expiresAt;
    }

    // ─── Init ──────────────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    /// @param _vault        XKubToken vault address
    /// @param _admin        Admin (factory owner)
    /// @param _factory      XKubFactory address
    /// @param _router       Diamon Router: 0xAb30a29168D792c5e6a54E4bcF1Aec926a3b20FA
    /// @param _dexFactory   Diamon Factory (call router.factory() on bkcscan)
    /// @param _quote        KUSDT address
    /// @param _spotNavVault SpotNavVault instance for this vault
    function initialize(
        address _vault,
        address _admin,
        address _factory,
        address _router,
        address _dexFactory,
        address _quote,
        address _spotNavVault
    ) public initializer {
        require(_vault != address(0), "!vault");
        require(_admin != address(0), "!admin");
        require(_factory != address(0), "!factory");
        require(_router != address(0), "!router");
        require(_quote != address(0), "!quote");
        __Ownable_init(_admin);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        vault                    = _vault;
        factory                  = _factory;
        router                   = _router;
        dexFactory               = _dexFactory;
        quote                    = _quote;
        spotNavVault             = _spotNavVault;
        maxRedemptionSlippageBps = 500; // 5% default
    }

    function _authorizeUpgrade(address) internal override {
        require(factory != address(0), "No factory");
        require(msg.sender == IXKubFactory(factory).owner(), "!factory owner");
    }

    // ─── Leader Trading ────────────────────────────────────────────────────────

    /// @notice Execute a spot swap on Diamon (tokenIn → tokenOut)
    /// @param tokenIn        Token to sell (must be in SpotNavVault whitelist)
    /// @param tokenOut       Token to buy  (must be in SpotNavVault whitelist)
    /// @param amountIn       Amount of tokenIn (in tokenIn's native decimals)
    /// @param minAmountOut   Minimum tokenOut expected — slippage protection
    function executeSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut
    ) external onlyVaultOrLeader nonReentrant {
        require(IXKubToken(vault).totalSupply() > 0, "No deposits");
        require(amountIn > 0, "!amount");
        require(tokenIn != tokenOut, "same token");

        // Whitelist + slippage guard (uses SpotNavVault.maxSlippageBps, default 3%)
        ISpotNavVault(spotNavVault).requireWithinSlippage(amountIn, tokenIn, tokenOut);

        uint256 out = _executeRouterSwap(tokenIn, tokenOut, amountIn, minAmountOut);
        emit SwapExecuted(tokenIn, tokenOut, amountIn, out);
    }

    /// @notice Execute a multi-hop swap (e.g. TOKEN → KKUB → KUSDT)
    function executeSwapPath(
        address[] calldata path,
        uint256 amountIn,
        uint256 minAmountOut
    ) external onlyVaultOrLeader nonReentrant {
        require(IXKubToken(vault).totalSupply() > 0, "No deposits");
        require(path.length >= 2, "!path length");
        require(amountIn > 0, "!amount");

        address tokenIn  = path[0];
        address tokenOut = path[path.length - 1];

        ISpotNavVault(spotNavVault).requireWithinSlippage(amountIn, tokenIn, tokenOut);

        IXKubToken(vault).approveForTrading(tokenIn, router, amountIn);

        uint256[] memory amounts = IDiamonRouter(router).swapExactTokensForTokens(
            amountIn, minAmountOut, path, vault, block.timestamp + 300
        );

        uint256 out = amounts[amounts.length - 1];
        emit SwapPathExecuted(path, amountIn, out);
    }

    // ─── Redemption Liquidation (no pending sell) ──────────────────────────────

    /// @notice Auto-swap held tokens → KUSDT to cover a redemption shortfall.
    ///         Called by XKubToken.sell() when vault KUSDT < needed.
    ///         Iterates tracked tokens proportionally; uses maxRedemptionSlippageBps (default 5%).
    ///         Bypasses normal leader-only slippage guard — redemptions must always settle.
    /// @param shortfallNative KUSDT shortfall in quote native decimals
    /// @return covered        Actual KUSDT obtained from liquidation
    function liquidateForRedemption(uint256 shortfallNative)
        external onlyVault returns (uint256 covered)
    {
        if (spotNavVault == address(0) || shortfallNative == 0) return 0;

        address[] memory tokens = ISpotNavVault(spotNavVault).getTrackedTokens();
        uint256 remaining = shortfallNative;

        // Step 1: calculate total non-KUSDT value so we can split proportionally
        uint256 totalNonQuoteValue = 0;
        for (uint256 i = 0; i < tokens.length; i++) {
            address tk = tokens[i];
            if (tk == quote) continue;
            uint256 bal = IERC20(tk).balanceOf(vault);
            if (bal == 0) continue;
            // preview KUSDT value of full balance (mid price, no slippage)
            uint256 val = ISpotNavVault(spotNavVault).previewSwap(bal, tk, quote);
            totalNonQuoteValue += val;
        }

        if (totalNonQuoteValue == 0) return 0; // nothing to liquidate

        // Step 2: proportionally liquidate each token
        for (uint256 i = 0; i < tokens.length && remaining > 0; i++) {
            address tk = tokens[i];
            if (tk == quote) continue;

            uint256 bal = IERC20(tk).balanceOf(vault);
            if (bal == 0) continue;

            uint256 fullValue = ISpotNavVault(spotNavVault).previewSwap(bal, tk, quote);
            if (fullValue == 0) continue;

            // How much of this token to sell:
            //   if its full value <= remaining share → sell all of it
            //   otherwise → sell only what's needed (with 5% buffer for slippage)
            uint256 amountIn;
            uint256 minOut;

            // Proportional share of shortfall for this token
            uint256 myShare = (shortfallNative * fullValue) / totalNonQuoteValue;

            if (fullValue <= myShare || fullValue <= remaining) {
                // Sell entire holding of this token
                amountIn = bal;
                minOut   = (fullValue * (10000 - maxRedemptionSlippageBps)) / 10000;
            } else {
                // Sell only the fraction needed, plus a 5% over-buy buffer
                // to account for slippage making the output slightly less than expected
                uint256 targetOut    = myShare < remaining ? myShare : remaining;
                uint256 amountInIdeal = (bal * targetOut) / fullValue;
                // Add 5% buffer so we don't under-deliver due to slippage
                amountIn = (amountInIdeal * 10500) / 10000;
                if (amountIn > bal) amountIn = bal;
                minOut   = (targetOut * (10000 - maxRedemptionSlippageBps)) / 10000;
            }

            if (amountIn == 0) continue;

            // Pull tokenIn from vault → this contract → approve router → swap → KUSDT to vault
            IXKubToken(vault).approveForTrading(tk, address(this), amountIn);
            IERC20(tk).transferFrom(vault, address(this), amountIn);
            IERC20(tk).approve(router, amountIn);

            address[] memory path = new address[](2);
            path[0] = tk;
            path[1] = quote;

            try IDiamonRouter(router).swapExactTokensForTokens(
                amountIn, minOut, path, vault, block.timestamp + 300
            ) returns (uint256[] memory amounts) {
                uint256 received = amounts[amounts.length - 1];
                covered   += received;
                remaining  = remaining > received ? remaining - received : 0;
                emit RedemptionLiquidation(tk, amountIn, received, remaining);
            } catch {
                // If a swap fails (e.g. pool empty), skip this token and try the next
                emit RedemptionLiquidation(tk, amountIn, 0, remaining);
            }
        }

        return covered;
    }

    // ─── Internal Swap Helper ──────────────────────────────────────────────────

    function _executeRouterSwap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut
    ) internal returns (uint256 amountOut) {
        // Step 1: vault approves trading module to pull tokenIn
        IXKubToken(vault).approveForTrading(tokenIn, address(this), amountIn);
        // Step 2: pull tokenIn from vault into this contract
        IERC20(tokenIn).transferFrom(vault, address(this), amountIn);
        // Step 3: approve router to pull from this contract
        IERC20(tokenIn).approve(router, amountIn);

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        // Step 4: router pulls from this contract, sends tokenOut directly to vault
        uint256[] memory amounts = IDiamonRouter(router).swapExactTokensForTokens(
            amountIn, minAmountOut, path, vault, block.timestamp + 300
        );
        amountOut = amounts[amounts.length - 1];
    }

    // ─── NAV / Total Assets ────────────────────────────────────────────────────

    /// @notice Total vault assets in KUSDT native decimals.
    ///         Delegates to SpotNavVault (sums tracked token balances via Diamon reserves).
    ///         XKubToken scales this to 1e18 using quoteDecimals.
    function getTotalAssets() public view returns (uint256) {
        if (spotNavVault == address(0)) return IERC20(quote).balanceOf(vault);
        return ISpotNavVault(spotNavVault).getTotalAssets();
    }

    /// @notice No Hyperliquid perp on KUB Chain.
    function getL1AccountValue() external pure returns (uint256) { return 0; }

    /// @notice No Hyperliquid L1 spot on KUB Chain.
    function getL1SpotBalance() external pure returns (uint256) { return 0; }

    /// @notice No-op on KUB — all assets are EVM tokens, no L1/EVM split.
    function autoRebalance() external onlyVault { }

    // ─── Preview Helpers ───────────────────────────────────────────────────────

    function previewSwap(address tokenIn, address tokenOut, uint256 amountIn)
        external view returns (uint256)
    {
        return ISpotNavVault(spotNavVault).previewSwap(amountIn, tokenIn, tokenOut);
    }

    function previewSlippage(address tokenIn, address tokenOut, uint256 amountIn)
        external view returns (uint256 bps)
    {
        return ISpotNavVault(spotNavVault).previewSlippage(amountIn, tokenIn, tokenOut);
    }

    function getTrackedTokens() external view returns (address[] memory) {
        return ISpotNavVault(spotNavVault).getTrackedTokens();
    }

    /// @notice Preview total KUSDT obtainable from all held non-KUSDT tokens
    ///         (useful for UI: "max redeemable before slippage issues")
    function previewMaxLiquidation() external view returns (uint256 totalKusdtAvailable) {
        if (spotNavVault == address(0)) return IERC20(quote).balanceOf(vault);
        address[] memory tokens = ISpotNavVault(spotNavVault).getTrackedTokens();
        totalKusdtAvailable = IERC20(quote).balanceOf(vault);
        for (uint256 i = 0; i < tokens.length; i++) {
            address tk = tokens[i];
            if (tk == quote) continue;
            uint256 bal = IERC20(tk).balanceOf(vault);
            if (bal == 0) continue;
            // Use execution price (includes slippage) for realistic estimate
            uint256 kusdtOut = ISpotNavVault(spotNavVault).previewSwap(bal, tk, quote);
            uint256 afterSlippage = (kusdtOut * (10000 - maxRedemptionSlippageBps)) / 10000;
            totalKusdtAvailable += afterSlippage;
        }
    }

    // ─── API Wallet Management ─────────────────────────────────────────────────

    function addApiWallet(address apiWallet, string calldata name, uint256 durationDays) external {
        require(msg.sender == IXKubToken(vault).leader(), "Not leader");
        require(apiWallet != address(0), "Invalid");
        require(!_isApiWalletValid(apiWallet), "Already active");

        uint256 expiresAt;
        if (durationDays == 0) {
            expiresAt = type(uint256).max;
        } else {
            uint256 dur = durationDays * 1 days;
            require(dur >= MIN_API_WALLET_DURATION, "Min 60 days");
            require(dur <= MAX_API_WALLET_DURATION, "Max 180 days");
            expiresAt = block.timestamp + dur;
        }

        apiWalletInfo[apiWallet] = ApiWalletInfo({active: true, expiresAt: expiresAt, name: name});
        emit ApiWalletAdded(apiWallet, name, expiresAt);
    }

    function renewApiWallet(address apiWallet, uint256 durationDays) external {
        require(msg.sender == IXKubToken(vault).leader(), "Not leader");
        ApiWalletInfo storage info = apiWalletInfo[apiWallet];
        require(info.active, "Not active");

        uint256 newExpiresAt;
        if (durationDays == 0) {
            newExpiresAt = type(uint256).max;
        } else {
            uint256 dur = durationDays * 1 days;
            require(dur >= MIN_API_WALLET_DURATION, "Min 60 days");
            require(dur <= MAX_API_WALLET_DURATION, "Max 180 days");
            newExpiresAt = block.timestamp + dur;
        }

        info.expiresAt = newExpiresAt;
        emit ApiWalletRenewed(apiWallet, newExpiresAt);
    }

    function removeApiWallet(address apiWallet) external {
        require(msg.sender == IXKubToken(vault).leader(), "Not leader");
        require(_isApiWalletValid(apiWallet), "Not active");
        apiWalletInfo[apiWallet].active    = false;
        apiWalletInfo[apiWallet].expiresAt = 0;
        emit ApiWalletRemoved(apiWallet);
    }

    function isApiWalletValid(address wallet) external view returns (bool) {
        return _isApiWalletValid(wallet);
    }

    function getApiWalletStatus(address apiWallet)
        external view
        returns (bool active, uint256 expiresAt, uint256 daysRemaining, string memory name)
    {
        ApiWalletInfo storage info = apiWalletInfo[apiWallet];
        if (info.active) {
            expiresAt = info.expiresAt;
            name      = info.name;
            if (expiresAt == type(uint256).max) {
                active        = true;
                daysRemaining = type(uint256).max;
            } else {
                active        = block.timestamp < expiresAt;
                if (active) daysRemaining = (expiresAt - block.timestamp) / 1 days;
            }
        }
    }

    // ─── Admin ─────────────────────────────────────────────────────────────────

    function setSpotNavVault(address _spotNavVault) external onlyOwner {
        spotNavVault = _spotNavVault;
        emit SpotNavVaultUpdated(_spotNavVault);
    }

    function setVault(address _vault) external onlyOwner {
        require(_vault != address(0), "!vault");
        vault = _vault;
    }

    function setMaxRedemptionSlippageBps(uint256 bps) external onlyAdmin {
        require(bps >= 50 && bps <= 3000, "0.5%-30%");
        maxRedemptionSlippageBps = bps;
        emit MaxRedemptionSlippageUpdated(bps);
    }

    function checkReserve() external pure returns (bool) { return false; }
}
