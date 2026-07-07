// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
          XKubTestFactory — Minimal factory for KUB testnet
//////////////////////////////////////////////////////////////
  Provides the interface XKubToken + HyperFunTokenLib expect,
  with hardcoded sensible defaults. Does NOT call initializeL1().

  For production: replace with a full XKubFactory.
*/

contract XKubTestFactory {
    address public owner;
    address public treasury;

    // ─── Global settings ───────────────────────────────────────────────────
    uint256 public tradingFeeBps     = 100;   // 1%
    uint256 public maxPremiumBps     = 500;   // 5% above NAV
    uint256 public maxDiscountBps    = 500;   // 5% below NAV
    uint256 public minDepositUsdc    = 1e6;   // 1 KUSDT (assuming 18 dec: set to 1e18)
    uint256 public rebalanceLowBps   = 4800;  // 48%
    uint256 public rebalanceHighBps  = 5200;  // 52%
    uint256 public reserveRatioBps   = 5000;  // 50%
    uint256 public minReserveRatioBps = 2000; // 20%

    uint256 public maxBuyBps         = 100;   // 1% of total assets per buy
    uint256 public navVirtualAssets  = 2_000_000e18;
    uint256 public navVirtualShares  = 2_000_000e18;
    bool    public exitFeeEnabled    = true;

    uint256 public globalBcVirtualMinimumBps = 1000; // 10%
    uint256 public globalMaxBcRatioBps       = 5000; // max BC ratio
    uint256 public globalMaxSellPremiumBps   = 200;  // 2%

    // ─── Graduation tiers (single simple tier for testnet) ─────────────────
    struct GraduationTier {
        uint256 threshold;
        uint256 bcVirtual;
        uint256 navMinMulBps;
        uint256 navMaxMulBps;
        uint256 squaredRatioBps;
    }
    GraduationTier[] public graduationTiers;

    // ─── Exit fee tiers ────────────────────────────────────────────────────
    struct ExitFeeTier {
        uint256 daysHeld;
        uint256 feeBps;
    }
    ExitFeeTier[] private _globalExitFeeTiers;
    mapping(address => ExitFeeTier[]) private _vaultExitFeeTiers;

    // ─── Per-vault settings ────────────────────────────────────────────────
    mapping(address => bool) public vaultRegistered;

    constructor(address _treasury) {
        owner    = msg.sender;
        treasury = _treasury == address(0) ? msg.sender : _treasury;

        // Single graduation tier: no threshold (always applies)
        graduationTiers.push(GraduationTier({
            threshold:       0,
            bcVirtual:       2_000_000e18,
            navMinMulBps:    9000,   // 0.9x min NAV virtual
            navMaxMulBps:    11000,  // 1.1x max NAV virtual
            squaredRatioBps: 10000   // full squared effect
        }));

        // Simple exit fee: 2% if held < 7 days, 0% after
        _globalExitFeeTiers.push(ExitFeeTier({daysHeld: 0, feeBps: 200}));
        _globalExitFeeTiers.push(ExitFeeTier({daysHeld: 7, feeBps: 0}));
    }

    // ─── View functions expected by XKubToken ────────────────────────────

    function getGlobalSettings() external view returns (
        uint256, uint256, uint256, uint256,
        uint256, uint256, uint256, uint256
    ) {
        return (
            tradingFeeBps, maxPremiumBps, maxDiscountBps, minDepositUsdc,
            rebalanceLowBps, rebalanceHighBps, reserveRatioBps, minReserveRatioBps
        );
    }

    function getGlobalSettingsExt() external view returns (
        uint256, uint256, uint256, bool
    ) {
        return (maxBuyBps, navVirtualAssets, navVirtualShares, exitFeeEnabled);
    }

    function getGlobalExitFeeTiers() external view returns (ExitFeeTier[] memory) {
        return _globalExitFeeTiers;
    }

    function getVaultExitFeeTiers(address vault) external view returns (ExitFeeTier[] memory) {
        ExitFeeTier[] storage vaultTiers = _vaultExitFeeTiers[vault];
        if (vaultTiers.length > 0) return vaultTiers;
        return _globalExitFeeTiers;
    }

    function getGraduationTiers() external view returns (GraduationTier[] memory) {
        return graduationTiers;
    }

    function getGraduationTierCount() external view returns (uint256) {
        return graduationTiers.length;
    }

    function getGraduationTier(uint256 index) external view returns (
        uint256 threshold, uint256 bcVirtual,
        uint256 navMinMulBps, uint256 navMaxMulBps, uint256 squaredRatioBps
    ) {
        GraduationTier storage t = graduationTiers[index];
        return (t.threshold, t.bcVirtual, t.navMinMulBps, t.navMaxMulBps, t.squaredRatioBps);
    }

    function isGraduationTieredMode() external pure returns (bool) { return true; }

    function checkFeeDiscount(address) external pure returns (bool) { return false; }
    function checkFeeDiscountBps(address) external pure returns (uint256) { return 0; }

    function launchGate() external pure returns (address) { return address(0); }
    function seedBuyRouter() external pure returns (address) { return address(0); }
    function referralRegistry() external pure returns (address) { return address(0); }

    function getGlobalNavVirtualDynamic() external view returns (uint256, uint256, uint256) {
        return (1, 10000, navVirtualAssets);
    }

    function getGlobalNavVirtualParams() external view returns (
        uint256, uint256, uint256, uint256, uint256
    ) {
        return (1, 9000, 11000, 1_000_000e18, navVirtualAssets);
    }

    // ─── Admin ─────────────────────────────────────────────────────────────

    modifier onlyOwner() { require(msg.sender == owner, "!owner"); _; }

    function setOwner(address _owner) external onlyOwner { owner = _owner; }
    function setTreasury(address _treasury) external onlyOwner { treasury = _treasury; }
    function setTradingFeeBps(uint256 bps) external onlyOwner { tradingFeeBps = bps; }
    function setMinDepositUsdc(uint256 amount) external onlyOwner { minDepositUsdc = amount; }
    function setExitFeeEnabled(bool enabled) external onlyOwner { exitFeeEnabled = enabled; }
    function setGlobalMaxSellPremiumBps(uint256 bps) external onlyOwner { globalMaxSellPremiumBps = bps; }
}
