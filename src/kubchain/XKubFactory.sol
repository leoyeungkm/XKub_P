// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
// SpotNavVault is NOT imported here — its bytecode lives in SpotNavVaultDeployer.sol.
// This keeps XKubFactory under the 24 KB EIP-170 size limit.

/*//////////////////////////////////////////////////////////////
                XKubFactory — Production Vault Factory
//////////////////////////////////////////////////////////////

  FORKED FROM: HyperFunFactory.sol (HypersFun on HyperEVM)

  KEY CHANGES FROM HyperFunFactory
  ----------------------------------
  1. All Hyperliquid L1 code removed:
       - initializeL1 / approveBuilderFee / emergencyWithdrawL1SpotToEVM
       - defaultBuilder / defaultBuilderFeeRate / defaultBuilderDexIndices
       - L1_INIT_FEE (was 1 USDC for Hyperliquid account init)
  2. KUB-specific state added:
       - kusdt          — KUSDT quote token address
       - quoteDecimals  — 18 (KAP-20) or 6 (bridged)
       - router         — Diamon Router
       - dexFactory     — Diamon Factory
  3. createVault now deploys THREE contracts per vault:
       - XKubToken proxy  (core vault)
       - XKubTrading proxy (trading module)
       - SpotNavVault        (NAV + slippage guard, plain contract)
  4. VaultInfo extended with spotNavVault address.
  5. Factory-level SpotNavVault admin helpers:
       - trackTokenForVault / untrackTokenForVault
       - setVaultSlippage
       - transferSpotNavAdmin (hand over admin to leader if desired)
  6. No creation fee on KUB testnet by default (creationFee = 0).
       Owner can enable optional KUSDT fee for production.

  VAULT CREATION FLOW
  -------------------
  1. Deploy XKubTrading proxy (empty — no init calldata)
  2. Deploy XKubToken proxy  (empty — no init calldata)
  3. Deploy SpotNavVault(router, dexFactory, kusdt, core, factory)
  4. Initialize XKubTrading
  5. Initialize XKubToken  (admin = factory temporarily)
  6. Call core.initTwapNav() while factory is admin
  7. Transfer admin to owner()
  8. Register in allVaults

  GLOBAL SETTINGS (read by all vaults via IXKubFactory)
  -------------------------------------------------------
  Same interface as HyperFunFactory — XKubToken and HyperFunTokenLib
  read these values unchanged.

  GRADUATION TIERS
  ----------------
  Four tiers (same concept as HypersFun):
    Tier 0: < 10K KUSDT    — smallest BC virtual (tightest curve)
    Tier 1: < 100K KUSDT   — medium
    Tier 2: < 1M KUSDT     — large
    Tier 3: ≥ 1M KUSDT     — whale
*/

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface IXKubToken {
    function initialize(
        address _leader,
        string calldata _name,
        string calldata _symbol,
        uint256 _feeBps,
        address _treasury,
        address _admin,
        address _tradingModule,
        address _factory,
        uint256 _virtualBase,
        uint256 _virtualTokens,
        uint256 _initialAssets,
        address _kusdt,
        uint8   _quoteDecimals
    ) external;
    function setAdmin(address _admin) external;
    function leader() external view returns (address);
    function initTwapNav() external;
    function emergencyWithdrawEVM(uint256 amountNative) external;
    function emergencyRecoverToken(address token, uint256 amount) external;
    function setPaused(bool _paused) external;
    function setTradingModule(address _tradingModule) external;
}

interface IXKubTrading {
    function initialize(
        address _vault,
        address _admin,
        address _factory,
        address _router,
        address _dexFactory,
        address _quote,
        address _spotNavVault
    ) external;
}

interface ISpotNavVaultAdmin {
    function trackToken(address token) external;
    function untrackToken(address token) external;
    function setMaxSlippageBps(uint256 bps) external;
    function setAdmin(address _admin) external;
}

interface ISpotNavVaultDeployer {
    function deploy(
        address _router,
        address _dexFactory,
        address _quote,
        address _vault,
        address _admin
    ) external returns (address spotNavVault);
}

interface IHFReferral {
    function setAuthorizedCaller(address caller, bool authorized) external;
}

interface IHyperFunResolver {
    function hasFeeDiscount(address wallet) external view returns (bool);
    function getFeeDiscountBps(address wallet) external view returns (uint256);
}

/// @title XKubFactory — UUPS Upgradeable Factory for XKub Vaults on KUB Chain
contract XKubFactory is Initializable, UUPSUpgradeable, OwnableUpgradeable {

    // ─── Errors ────────────────────────────────────────────────────────────────
    error InvalidVault();
    error InvalidAddr();
    error TransferFailed();
    error ContractPaused();
    error InvalidParam();

    // ─── Constants ─────────────────────────────────────────────────────────────
    uint256 public constant MAX_PERFORMANCE_FEE = 3000; // 30%
    uint256 public constant MAX_EXIT_FEE        = 1500; // 15% per tier

    // ─── Implementation Contracts ──────────────────────────────────────────────
    address public coreImplementation;     // XKubToken logic
    address public tradingImplementation;  // XKubTrading logic

    // ─── Platform Config ───────────────────────────────────────────────────────
    address public treasury;
    address public kusdt;         // KUSDT on KUB Chain — VERIFY decimals on bkcscan
    uint8   public quoteDecimals; // 18 (KAP-20) or 6 (bridged Ethereum USDT)

    address public router;        // Diamon Router: 0xAb30a29168D792c5e6a54E4bcF1Aec926a3b20FA
    address public dexFactory;    // Diamon Factory (call router.factory() on bkcscan)

    /// @dev SpotNavVaultDeployer — deploys SpotNavVault instances.
    ///      Separating it keeps XKubFactory under the 24 KB EIP-170 limit.
    address public spotNavVaultDeployer;

    uint256 public creationFee;   // Optional KUSDT fee to create a vault (0 = free)

    // ─── Default BC Params ─────────────────────────────────────────────────────
    uint256 public defaultBcVirtualBase;   // 2M tokens
    uint256 public defaultBcVirtualTokens; // 2M tokens
    uint256 public defaultInitialAssets;   // 1K KUSDT baseline

    // ─── Global Vault Settings (read by all vaults via IXKubFactory) ─────────
    uint256 public globalTradingFeeBps;
    uint256 public globalMaxPremiumBps;
    uint256 public globalMaxDiscountBps;
    uint256 public globalMinDepositUsdc;     // in quote native decimals
    uint256 public globalRebalanceLowBps;
    uint256 public globalRebalanceHighBps;
    uint256 public globalReserveRatioBps;
    uint256 public globalMinReserveRatioBps;
    uint256 public globalMaxBuyBps;
    uint256 public globalNavVirtualAssets;
    uint256 public globalNavVirtualShares;
    bool    public globalExitFeeEnabled;

    // BC Virtual floor and ratio cap
    uint256 public globalBcVirtualMinimumBps; // 500 = 5% floor
    uint256 public globalMaxBcRatioBps;        // 0 = disabled

    // V70: sell NAV ceiling (default 200 = 2% above NAV)
    uint256 public globalMaxSellPremiumBps;

    // Dynamic NAV Virtual (V35/V36 — same slots as HyperFunFactory)
    uint256 public globalNavVirtualMode;
    uint256 public globalNavVirtualMultiplierBps;
    uint256 public globalNavVirtualMinimum;
    uint256 public globalNavVirtualMaxMultiplierBps;
    uint256 public globalNavVirtualTargetAssets;

    // ─── Exit Fee Tiers ────────────────────────────────────────────────────────
    struct ExitFeeTier {
        uint256 daysHeld;
        uint256 feeBps;
    }
    ExitFeeTier[] public globalExitFeeTiers;
    mapping(address => ExitFeeTier[]) private _vaultExitFeeTiers;

    // ─── Graduation Tiers (V37/V38) ────────────────────────────────────────────
    struct GraduationTier {
        uint256 threshold;       // Asset threshold to enter this tier (1e18 precision)
        uint256 bcVirtual;       // BC Virtual pool size for this tier (1e18)
        uint256 navMinMulBps;    // NAV Virtual min multiplier (2000 = 0.2×)
        uint256 navMaxMulBps;    // NAV Virtual max multiplier (5000 = 0.5×)
        uint256 squaredRatioBps; // Squared effect weight (10000=100% squared)
    }
    GraduationTier[] public graduationTiers;
    bool public graduationTieredMode;

    // ─── Vault Registry ────────────────────────────────────────────────────────
    address[] public allVaults;
    mapping(address => address[]) public vaultsByLeader;
    mapping(address => bool) public isVault;
    mapping(address => bool) public isVerified;

    struct VaultInfo {
        address core;
        address trading;
        address spotNavVault; // KUB-specific: NAV module
        address leader;
        string  name;
        string  symbol;
        uint256 performanceFeeBps;
        uint256 createdAt;
        bool    verified;
    }
    mapping(address => VaultInfo) public vaultInfo;

    // ─── Platform Features ─────────────────────────────────────────────────────
    bool    public paused;
    address public feeDiscountResolver; // Genesis Pass / staker fee discount
    address public launchGate;          // Token.buy() gating
    address public seedBuyRouter;       // Authorized seed buy router
    address public referralRegistry;    // Referral fee distributor
    uint256 public referralFeeBps;      // 20% of trading fee to referrer

    // ─── Events ────────────────────────────────────────────────────────────────
    event VaultCreated(
        address indexed leader,
        address indexed core,
        address indexed trading,
        address spotNavVault,
        string name,
        string symbol,
        uint256 performanceFeeBps
    );
    event ImplementationUpdated(address newCore, address newTrading);
    event VaultVerified(address indexed vault, bool verified);
    event CreationFeeUpdated(uint256 oldFee, uint256 newFee);
    event DefaultsUpdated(uint256 bcVirtualBase, uint256 bcVirtualTokens, uint256 initialAssets);
    event VaultExitFeeTiersSet(address indexed vault, uint256[] daysHeld, uint256[] feeBps);
    event TokenTrackedForVault(address indexed vault, address indexed token);
    event TokenUntrackedForVault(address indexed vault, address indexed token);

    // ─── Init ──────────────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    /// @param _coreImpl            XKubToken implementation address
    /// @param _tradingImpl         XKubTrading implementation address
    /// @param _treasury            Fee destination
    /// @param _kusdt               KUSDT address on KUB Chain
    /// @param _quoteDecimals       18 for KAP-20, 6 for bridged. MUST match actual token.
    /// @param _router              Diamon Router (mainnet: 0xAb30a29168D792c5e6a54E4bcF1Aec926a3b20FA)
    /// @param _dexFactory          Diamon Factory (call router.factory())
    /// @param _spotNavVaultDeployer SpotNavVaultDeployer address
    function initialize(
        address _coreImpl,
        address _tradingImpl,
        address _treasury,
        address _kusdt,
        uint8   _quoteDecimals,
        address _router,
        address _dexFactory,
        address _spotNavVaultDeployer
    ) public initializer {
        if (_coreImpl    == address(0)) revert InvalidAddr();
        if (_tradingImpl == address(0)) revert InvalidAddr();
        if (_treasury    == address(0)) revert InvalidAddr();
        if (_kusdt       == address(0)) revert InvalidAddr();
        if (_router      == address(0)) revert InvalidAddr();
        if (_dexFactory  == address(0)) revert InvalidAddr();
        if (_spotNavVaultDeployer == address(0)) revert InvalidAddr();
        require(_quoteDecimals == 6 || _quoteDecimals == 18, "quoteDecimals: 6 or 18");

        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();

        coreImplementation    = _coreImpl;
        tradingImplementation = _tradingImpl;
        treasury              = _treasury;
        kusdt                 = _kusdt;
        quoteDecimals         = _quoteDecimals;
        router                = _router;
        dexFactory            = _dexFactory;
        spotNavVaultDeployer  = _spotNavVaultDeployer;

        creationFee = 0; // Free on launch

        // ─── Default BC params ─────────────────────────────────────────────────
        defaultBcVirtualBase   = 2_000_000e18;
        defaultBcVirtualTokens = 2_000_000e18;
        // Scale initialAssets baseline to match quoteDecimals
        defaultInitialAssets   = _quoteDecimals == 18
            ? 1_000e18   // 1,000 KUSDT
            : 1_000e6;   // 1,000 KUSDT (6 dec)

        // ─── Global settings ───────────────────────────────────────────────────
        globalTradingFeeBps    = 100;   // 1%
        globalMaxPremiumBps    = 10000; // 100%
        globalMaxDiscountBps   = 5000;  // 50%
        // Min deposit scales with quoteDecimals
        globalMinDepositUsdc   = _quoteDecimals == 18 ? 5e18 : 5e6; // 5 KUSDT
        globalRebalanceLowBps  = 4800;  // 48%
        globalRebalanceHighBps = 5200;  // 52%
        globalReserveRatioBps  = 5000;  // 50%
        globalMinReserveRatioBps = 3000; // 30%
        globalMaxBuyBps        = 100;   // 1% per tx
        globalNavVirtualAssets = _quoteDecimals == 18 ? 500_000e18 : 500_000e6;
        globalNavVirtualShares = 500_000e18;
        globalExitFeeEnabled   = true;
        globalBcVirtualMinimumBps = 500; // 5%
        globalMaxSellPremiumBps   = 200; // 2%

        // Dynamic NAV Virtual (mode 0 = fixed by default)
        globalNavVirtualMode           = 0;
        globalNavVirtualMultiplierBps  = 15000; // 1.5x
        globalNavVirtualMinimum        = _quoteDecimals == 18 ? 1_000e18 : 1_000e6;
        globalNavVirtualMaxMultiplierBps = 20000; // 2.0x max
        globalNavVirtualTargetAssets   = _quoteDecimals == 18 ? 1_000_000e18 : 1_000_000e6;

        referralFeeBps = 2000; // 20% of trading fee to referrer

        // ─── Default exit fee tiers ────────────────────────────────────────────
        //   < 7  days: 5% (short-flip tax)
        //   7-30 days: 2%
        //   30-90 days: 0.5%
        //   ≥ 90 days: 0%
        globalExitFeeTiers.push(ExitFeeTier({daysHeld: 0,  feeBps: 500}));
        globalExitFeeTiers.push(ExitFeeTier({daysHeld: 7,  feeBps: 200}));
        globalExitFeeTiers.push(ExitFeeTier({daysHeld: 30, feeBps: 50}));
        globalExitFeeTiers.push(ExitFeeTier({daysHeld: 90, feeBps: 0}));

        // ─── Graduation tiers ──────────────────────────────────────────────────
        //  Tier 0: < 10K KUSDT   — small vault (tightest curve)
        //  Tier 1: < 100K KUSDT  — medium
        //  Tier 2: < 1M KUSDT    — large
        //  Tier 3: ≥ 1M KUSDT    — whale (loosest curve)
        uint256 scale = _quoteDecimals == 18 ? 1e18 : 1e6;
        graduationTiers.push(GraduationTier({
            threshold:       0,
            bcVirtual:       500_000e18,
            navMinMulBps:    5000,  // 0.5×
            navMaxMulBps:    5000,  // 0.5×
            squaredRatioBps: 10000
        }));
        graduationTiers.push(GraduationTier({
            threshold:       10_000 * scale,
            bcVirtual:       1_000_000e18,
            navMinMulBps:    3000,  // 0.3×
            navMaxMulBps:    7000,  // 0.7×
            squaredRatioBps: 8000
        }));
        graduationTiers.push(GraduationTier({
            threshold:       100_000 * scale,
            bcVirtual:       2_000_000e18,
            navMinMulBps:    2000,  // 0.2×
            navMaxMulBps:    8000,  // 0.8×
            squaredRatioBps: 6000
        }));
        graduationTiers.push(GraduationTier({
            threshold:       1_000_000 * scale,
            bcVirtual:       5_000_000e18,
            navMinMulBps:    1000,  // 0.1×
            navMaxMulBps:    10000, // 1.0×
            squaredRatioBps: 4000
        }));
        graduationTieredMode = true;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ─── Create Vault ──────────────────────────────────────────────────────────

    /// @notice Create a vault with default BC parameters.
    ///         Deploys XKubToken + XKubTrading + SpotNavVault.
    /// @param _name           Vault ERC20 name
    /// @param _symbol         Vault ERC20 symbol
    /// @param _performanceFeeBps Leader performance fee (max 30%)
    function createVault(
        string calldata _name,
        string calldata _symbol,
        uint256 _performanceFeeBps
    ) external returns (address core, address trading, address spotNavVault) {
        return _createVaultInternal(_name, _symbol, _performanceFeeBps, 0, 0, 0);
    }

    /// @notice Create a vault with custom BC parameters. Owner only.
    function createVaultAdvanced(
        string calldata _name,
        string calldata _symbol,
        uint256 _performanceFeeBps,
        uint256 _bcVirtualBase,
        uint256 _bcVirtualTokens,
        uint256 _initialAssets
    ) external onlyOwner returns (address core, address trading, address spotNavVault) {
        return _createVaultInternal(
            _name, _symbol, _performanceFeeBps,
            _bcVirtualBase, _bcVirtualTokens, _initialAssets
        );
    }

    function _createVaultInternal(
        string memory _name,
        string memory _symbol,
        uint256 _performanceFeeBps,
        uint256 _bcVirtualBase,
        uint256 _bcVirtualTokens,
        uint256 _initialAssets
    ) internal returns (address core, address trading, address spotNavVaultAddr) {
        if (paused) revert ContractPaused();
        require(bytes(_name).length > 0,  "!name");
        require(bytes(_symbol).length > 0, "!sym");
        require(_performanceFeeBps <= MAX_PERFORMANCE_FEE, "!fee");

        // seedBuyRouter: use tx.origin so the actual user is the vault leader
        address _leader = (seedBuyRouter != address(0) && msg.sender == seedBuyRouter)
            ? tx.origin
            : msg.sender;

        // Optional creation fee in KUSDT
        if (creationFee > 0) {
            if (!IERC20(kusdt).transferFrom(msg.sender, treasury, creationFee))
                revert TransferFailed();
        }

        // Use defaults if 0
        uint256 virtualBase   = _bcVirtualBase   > 0 ? _bcVirtualBase   : defaultBcVirtualBase;
        uint256 virtualTokens = _bcVirtualTokens > 0 ? _bcVirtualTokens : defaultBcVirtualTokens;
        uint256 initialAssets = _initialAssets   > 0 ? _initialAssets   : defaultInitialAssets;

        // ── Step 1: Deploy proxies (uninitialized) ──────────────────────────────
        trading = address(new ERC1967Proxy(tradingImplementation, ""));
        core    = address(new ERC1967Proxy(coreImplementation, ""));

        // ── Step 2: Deploy SpotNavVault via deployer (bytecode lives there, not here) ──
        //    Admin = factory initially (transferred to owner below).
        spotNavVaultAddr = ISpotNavVaultDeployer(spotNavVaultDeployer).deploy(
            router,
            dexFactory,
            kusdt,
            core,           // vault address — SpotNavVault reads balances from here
            address(this)   // admin = factory initially
        );

        // ── Step 3: Initialize XKubTrading ────────────────────────────────────
        IXKubTrading(trading).initialize(
            core,
            address(this),   // admin = factory initially
            address(this),   // factory
            router,
            dexFactory,
            kusdt,
            spotNavVaultAddr
        );

        // ── Step 4: Initialize XKubToken (admin = factory temporarily) ────────
        IXKubToken(core).initialize(
            _leader,
            _name,
            _symbol,
            _performanceFeeBps,
            treasury,
            address(this),   // admin = factory (for initTwapNav below)
            trading,
            address(this),   // factory
            virtualBase,
            virtualTokens,
            initialAssets,
            kusdt,
            quoteDecimals
        );

        // ── Step 5: Init TWAP NAV while factory is still admin ──────────────────
        IXKubToken(core).initTwapNav();

        // ── Step 6: Transfer core admin to platform owner ───────────────────────
        IXKubToken(core).setAdmin(owner());

        // NOTE: SpotNavVault admin stays as address(this) (the factory).
        // This allows factory.trackTokenForVault() / setVaultSlippage() to work
        // via onlyOwner. Use transferSpotNavAdmin() to hand over control if needed.

        // ── Step 7: Authorize vault in referral registry ────────────────────────
        if (referralRegistry != address(0)) {
            try IHFReferral(referralRegistry).setAuthorizedCaller(core, true) {} catch {}
        }

        // ── Step 8: Register vault ───────────────────────────────────────────────
        allVaults.push(core);
        vaultsByLeader[_leader].push(core);
        isVault[core] = true;

        vaultInfo[core] = VaultInfo({
            core:             core,
            trading:          trading,
            spotNavVault:     spotNavVaultAddr,
            leader:           _leader,
            name:             _name,
            symbol:           _symbol,
            performanceFeeBps: _performanceFeeBps,
            createdAt:        block.timestamp,
            verified:         false
        });

        emit VaultCreated(_leader, core, trading, spotNavVaultAddr, _name, _symbol, _performanceFeeBps);
        return (core, trading, spotNavVaultAddr);
    }

    // ─── SpotNavVault Admin ────────────────────────────────────────────────────

    /// @notice Whitelist a KAP-20 token for a vault's NAV + trading.
    ///         A KUSDT/token pair must exist on Diamon first.
    function trackTokenForVault(address vault, address token) external onlyOwner {
        if (!isVault[vault]) revert InvalidVault();
        ISpotNavVaultAdmin(vaultInfo[vault].spotNavVault).trackToken(token);
        emit TokenTrackedForVault(vault, token);
    }

    /// @notice Batch track tokens across multiple vaults at once.
    function batchTrackToken(address[] calldata vaults, address token) external onlyOwner {
        for (uint256 i = 0; i < vaults.length; i++) {
            if (!isVault[vaults[i]]) continue;
            try ISpotNavVaultAdmin(vaultInfo[vaults[i]].spotNavVault).trackToken(token) {} catch {}
            emit TokenTrackedForVault(vaults[i], token);
        }
    }

    /// @notice Remove a token from a vault's whitelist.
    function untrackTokenForVault(address vault, address token) external onlyOwner {
        if (!isVault[vault]) revert InvalidVault();
        ISpotNavVaultAdmin(vaultInfo[vault].spotNavVault).untrackToken(token);
        emit TokenUntrackedForVault(vault, token);
    }

    /// @notice Adjust the max swap slippage tolerance for a vault's SpotNavVault.
    ///         Affects leader swaps (pre-trade check). Range: 10–2000 bps.
    function setVaultSlippage(address vault, uint256 bps) external onlyOwner {
        if (!isVault[vault]) revert InvalidVault();
        ISpotNavVaultAdmin(vaultInfo[vault].spotNavVault).setMaxSlippageBps(bps);
    }

    /// @notice Transfer SpotNavVault admin to a new address (e.g. vault leader).
    function transferSpotNavAdmin(address vault, address newAdmin) external onlyOwner {
        if (!isVault[vault]) revert InvalidVault();
        ISpotNavVaultAdmin(vaultInfo[vault].spotNavVault).setAdmin(newAdmin);
    }

    // ─── IXKubFactory Interface — Read by All Vaults ─────────────────────────

    function getGlobalSettings() external view returns (
        uint256 tradingFeeBps, uint256 maxPremiumBps, uint256 maxDiscountBps,
        uint256 minDepositUsdc, uint256 rebalanceLowBps, uint256 rebalanceHighBps,
        uint256 reserveRatioBps, uint256 minReserveRatioBps
    ) {
        return (
            globalTradingFeeBps, globalMaxPremiumBps, globalMaxDiscountBps,
            globalMinDepositUsdc, globalRebalanceLowBps, globalRebalanceHighBps,
            globalReserveRatioBps, globalMinReserveRatioBps
        );
    }

    function getGlobalSettingsExt() external view returns (
        uint256 maxBuyBps, uint256 navVirtualAssets, uint256 navVirtualShares, bool exitFeeEnabled
    ) {
        return (globalMaxBuyBps, globalNavVirtualAssets, globalNavVirtualShares, globalExitFeeEnabled);
    }

    function getGlobalExitFeeTiers() external view returns (ExitFeeTier[] memory) {
        return globalExitFeeTiers;
    }

    function getVaultExitFeeTiers(address vault) external view returns (ExitFeeTier[] memory) {
        if (_vaultExitFeeTiers[vault].length > 0) return _vaultExitFeeTiers[vault];
        return globalExitFeeTiers;
    }

    // V35/V36: Dynamic NAV Virtual — same signature as HyperFunFactory
    function getGlobalNavVirtualDynamic() external view returns (uint256, uint256, uint256) {
        return (globalNavVirtualMode, globalNavVirtualMultiplierBps, globalNavVirtualAssets);
    }

    function getGlobalNavVirtualParams() external view returns (
        uint256, uint256, uint256, uint256, uint256
    ) {
        return (
            globalNavVirtualMode,
            globalNavVirtualMultiplierBps,  // minMulBps
            globalNavVirtualMaxMultiplierBps,
            globalNavVirtualMinimum,
            globalNavVirtualAssets
        );
    }

    // V37/V38: Graduation tiers
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

    function isGraduationTieredMode() external view returns (bool) {
        return graduationTieredMode;
    }

    // Fee discount
    function checkFeeDiscount(address wallet) external view returns (bool) {
        if (feeDiscountResolver == address(0)) return false;
        try IHyperFunResolver(feeDiscountResolver).hasFeeDiscount(wallet) returns (bool r) {
            return r;
        } catch { return false; }
    }

    function checkFeeDiscountBps(address wallet) external view returns (uint256) {
        if (feeDiscountResolver == address(0)) return 0;
        try IHyperFunResolver(feeDiscountResolver).getFeeDiscountBps(wallet) returns (uint256 bps) {
            return bps;
        } catch { return 0; }
    }

    // ─── Vault Registry View ───────────────────────────────────────────────────

    function totalVaults() external view returns (uint256) { return allVaults.length; }
    function getAllVaults() external view returns (address[] memory) { return allVaults; }

    function getVaults(uint256 offset, uint256 limit) external view returns (address[] memory) {
        uint256 total = allVaults.length;
        if (offset >= total) return new address[](0);
        uint256 end = offset + limit > total ? total : offset + limit;
        address[] memory result = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) result[i - offset] = allVaults[i];
        return result;
    }

    function getVaultsByLeader(address _leader) external view returns (address[] memory) {
        return vaultsByLeader[_leader];
    }

    function getVaultCountByLeader(address _leader) external view returns (uint256) {
        return vaultsByLeader[_leader].length;
    }

    function getVaultInfo(address vault) external view returns (VaultInfo memory) {
        return vaultInfo[vault];
    }

    function getVerifiedVaults() external view returns (address[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < allVaults.length; i++) {
            if (isVerified[allVaults[i]]) count++;
        }
        address[] memory result = new address[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < allVaults.length; i++) {
            if (isVerified[allVaults[i]]) result[idx++] = allVaults[i];
        }
        return result;
    }

    // ─── Admin: Implementations & Platform ────────────────────────────────────

    function setImplementations(address _core, address _trading) external onlyOwner {
        if (_core == address(0) || _trading == address(0)) revert InvalidAddr();
        coreImplementation    = _core;
        tradingImplementation = _trading;
        emit ImplementationUpdated(_core, _trading);
    }

    function setSpotNavVaultDeployer(address _deployer) external onlyOwner {
        if (_deployer == address(0)) revert InvalidAddr();
        spotNavVaultDeployer = _deployer;
    }

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert InvalidAddr();
        treasury = _treasury;
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
    }

    function setCreationFee(uint256 _fee) external onlyOwner {
        uint256 old = creationFee;
        creationFee = _fee;
        emit CreationFeeUpdated(old, _fee);
    }

    function setFeeDiscountResolver(address _resolver) external onlyOwner {
        feeDiscountResolver = _resolver;
    }

    function setLaunchGate(address _gate) external onlyOwner {
        launchGate = _gate;
    }

    function setSeedBuyRouter(address _router) external onlyOwner {
        seedBuyRouter = _router;
    }

    function setReferralRegistry(address _registry) external onlyOwner {
        referralRegistry = _registry;
    }

    function setReferralFeeBps(uint256 _bps) external onlyOwner {
        require(_bps <= 5000, "Max 50%");
        referralFeeBps = _bps;
    }

    // ─── Admin: Default BC Params ──────────────────────────────────────────────

    function setDefaults(
        uint256 _bcVirtualBase,
        uint256 _bcVirtualTokens,
        uint256 _initialAssets
    ) external onlyOwner {
        defaultBcVirtualBase   = _bcVirtualBase;
        defaultBcVirtualTokens = _bcVirtualTokens;
        defaultInitialAssets   = _initialAssets;
        emit DefaultsUpdated(_bcVirtualBase, _bcVirtualTokens, _initialAssets);
    }

    // ─── Admin: Global Settings ────────────────────────────────────────────────

    function setGlobalTradingFee(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= 500, "Max 5%");
        globalTradingFeeBps = _feeBps;
    }

    function setGlobalPriceLimits(uint256 _maxPremiumBps, uint256 _maxDiscountBps) external onlyOwner {
        require(_maxPremiumBps <= 10000, "Max 100%");
        require(_maxDiscountBps <= 5000, "Max 50%");
        globalMaxPremiumBps  = _maxPremiumBps;
        globalMaxDiscountBps = _maxDiscountBps;
    }

    function setGlobalMinDeposit(uint256 _minNative) external onlyOwner {
        globalMinDepositUsdc = _minNative;
    }

    function setGlobalRebalanceThresholds(uint256 _lowBps, uint256 _highBps) external onlyOwner {
        require(_lowBps < globalReserveRatioBps, "!low");
        require(_highBps > globalReserveRatioBps, "!high");
        require(_highBps <= 10000, "Max 100%");
        globalRebalanceLowBps  = _lowBps;
        globalRebalanceHighBps = _highBps;
    }

    function setGlobalReserveRatio(uint256 _ratioBps, uint256 _minRatioBps) external onlyOwner {
        require(_ratioBps <= 10000 && _minRatioBps < _ratioBps, "!ratio");
        globalReserveRatioBps    = _ratioBps;
        globalMinReserveRatioBps = _minRatioBps;
    }

    function setGlobalMaxBuyBps(uint256 _maxBuyBps) external onlyOwner {
        require(_maxBuyBps >= 10 && _maxBuyBps <= 1000, "0.1-10%");
        globalMaxBuyBps = _maxBuyBps;
    }

    function setGlobalExitFeeEnabled(bool _enabled) external onlyOwner {
        globalExitFeeEnabled = _enabled;
    }

    function setGlobalNavVirtual(uint256 _assets, uint256 _shares) external onlyOwner {
        globalNavVirtualAssets = _assets;
        globalNavVirtualShares = _shares;
    }

    function setGlobalNavVirtualDynamic(
        uint256 _mode,
        uint256 _minMulBps,
        uint256 _maxMulBps,
        uint256 _minimum,
        uint256 _targetAssets
    ) external onlyOwner {
        require(_mode <= 2, "!mode");
        globalNavVirtualMode             = _mode;
        globalNavVirtualMultiplierBps    = _minMulBps;
        globalNavVirtualMaxMultiplierBps = _maxMulBps;
        globalNavVirtualMinimum          = _minimum;
        globalNavVirtualTargetAssets     = _targetAssets;
    }

    function setGlobalBcVirtualMinimum(uint256 _minimumBps) external onlyOwner {
        require(_minimumBps >= 100 && _minimumBps <= 5000, "1-50%");
        globalBcVirtualMinimumBps = _minimumBps;
    }

    function setGlobalMaxBcRatio(uint256 _ratioBps) external onlyOwner {
        if (_ratioBps != 0 && (_ratioBps < 10000 || _ratioBps > 50000)) revert InvalidParam();
        globalMaxBcRatioBps = _ratioBps;
    }

    function setGlobalMaxSellPremium(uint256 _bps) external onlyOwner {
        require(_bps <= 2000, "Max 20%");
        globalMaxSellPremiumBps = _bps;
    }

    // ─── Admin: Exit Fee Tiers ─────────────────────────────────────────────────

    /// @notice Replace global exit fee tiers. Max 10 tiers, max fee 15% each.
    function setGlobalExitFeeTiers(
        uint256[] calldata _daysHeld,
        uint256[] calldata _feeBps
    ) external onlyOwner {
        require(_daysHeld.length == _feeBps.length, "Length");
        require(_daysHeld.length > 0 && _daysHeld.length <= 10, "Tiers");
        delete globalExitFeeTiers;
        for (uint256 i = 0; i < _daysHeld.length; i++) {
            require(i == 0 || _daysHeld[i] > _daysHeld[i - 1], "Asc");
            require(_feeBps[i] <= MAX_EXIT_FEE, "Max 15%");
            globalExitFeeTiers.push(ExitFeeTier({daysHeld: _daysHeld[i], feeBps: _feeBps[i]}));
        }
    }

    /// @notice Set per-vault exit fee tiers.
    ///         Owner: can set/update anytime.
    ///         Vault leader: one-time only — cannot change after set.
    function setVaultExitFeeTiers(
        address vault,
        uint256[] calldata _daysHeld,
        uint256[] calldata _feeBps
    ) external {
        if (!isVault[vault]) revert InvalidVault();
        bool isOwner  = msg.sender == owner();
        bool isRouter = (seedBuyRouter != address(0) && msg.sender == seedBuyRouter);
        address caller = isRouter ? tx.origin : msg.sender;
        require(isOwner || caller == IXKubToken(vault).leader(), "!auth");
        if (!isOwner) require(_vaultExitFeeTiers[vault].length == 0, "already set");
        require(_daysHeld.length == _feeBps.length, "Length");
        require(_daysHeld.length > 0 && _daysHeld.length <= 10, "Tiers");
        delete _vaultExitFeeTiers[vault];
        for (uint256 i = 0; i < _daysHeld.length; i++) {
            require(i == 0 || _daysHeld[i] > _daysHeld[i - 1], "Asc");
            require(_feeBps[i] <= MAX_EXIT_FEE, "Max 15%");
            _vaultExitFeeTiers[vault].push(ExitFeeTier({daysHeld: _daysHeld[i], feeBps: _feeBps[i]}));
        }
        emit VaultExitFeeTiersSet(vault, _daysHeld, _feeBps);
    }

    // ─── Admin: Graduation Tiers ───────────────────────────────────────────────

    /// @notice Replace all graduation tiers atomically.
    function setGraduationTiers(
        uint256[] calldata thresholds,
        uint256[] calldata bcVirtuals,
        uint256[] calldata navMinMulBpsArr,
        uint256[] calldata navMaxMulBpsArr,
        uint256[] calldata squaredRatioBpsArr
    ) external onlyOwner {
        uint256 n = thresholds.length;
        require(n > 0 && n <= 10, "1-10 tiers");
        require(
            bcVirtuals.length == n && navMinMulBpsArr.length == n &&
            navMaxMulBpsArr.length == n && squaredRatioBpsArr.length == n,
            "Length"
        );
        delete graduationTiers;
        for (uint256 i = 0; i < n; i++) {
            require(i == 0 || thresholds[i] > thresholds[i - 1], "Asc");
            graduationTiers.push(GraduationTier({
                threshold:       thresholds[i],
                bcVirtual:       bcVirtuals[i],
                navMinMulBps:    navMinMulBpsArr[i],
                navMaxMulBps:    navMaxMulBpsArr[i],
                squaredRatioBps: squaredRatioBpsArr[i]
            }));
        }
    }

    function setGraduationTieredMode(bool _enabled) external onlyOwner {
        graduationTieredMode = _enabled;
    }

    // ─── Admin: Vault Management ───────────────────────────────────────────────

    function setVaultVerified(address vault, bool verified) external onlyOwner {
        if (!isVault[vault]) revert InvalidVault();
        isVerified[vault]           = verified;
        vaultInfo[vault].verified   = verified;
        emit VaultVerified(vault, verified);
    }

    function batchSetVaultVerified(address[] calldata vaults, bool verified) external onlyOwner {
        for (uint256 i = 0; i < vaults.length; i++) {
            if (!isVault[vaults[i]]) continue;
            isVerified[vaults[i]]         = verified;
            vaultInfo[vaults[i]].verified = verified;
            emit VaultVerified(vaults[i], verified);
        }
    }

    function pauseVault(address vault, bool _paused) external onlyOwner {
        if (!isVault[vault]) revert InvalidVault();
        IXKubToken(vault).setPaused(_paused);
    }

    // ─── Admin: Emergency ─────────────────────────────────────────────────────

    /// @notice Emergency withdraw KUSDT from a vault to treasury.
    function emergencyWithdrawEVM(address vault, uint256 amountNative) external onlyOwner {
        if (!isVault[vault]) revert InvalidVault();
        IXKubToken(vault).emergencyWithdrawEVM(amountNative);
    }

    /// @notice Emergency recover a KAP-20 token accidentally sent to a vault.
    function emergencyRecoverToken(address vault, address token, uint256 amount) external onlyOwner {
        if (!isVault[vault]) revert InvalidVault();
        IXKubToken(vault).emergencyRecoverToken(token, amount);
    }

    /// @notice Recover tokens accidentally sent to the factory itself.
    function rescueTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).transfer(owner(), amount);
    }
}
