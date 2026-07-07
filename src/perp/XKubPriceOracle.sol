// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/*//////////////////////////////////////////////////////////////
                XKub Perp: Keeper-Posted Price Oracle
//////////////////////////////////////////////////////////////

  WHY THIS EXISTS
  ---------------
  KUB Chain has no Chainlink / Pyth deployment. Prices for synthetic
  perp markets (BTC, ETH, KUB, ...) are pushed on-chain by whitelisted
  keeper bots reading CEX spot prices.

  TRUST MODEL & GUARDS
  --------------------
  - Only whitelisted keepers may post (tx signature = authentication).
  - Per-update deviation cap vs the previous price (default 5%);
    a compromised keeper cannot teleport the price in one update.
  - Consumers pass a max age; stale prices revert at read time.
  - Admin can force-set (circuit breaker / bootstrap) bypassing the
    deviation cap.

  UNITS
  -----
  Market ids are bytes32 symbols, e.g. bytes32("BTC").
  Prices are USD scaled to 1e18.
*/

contract XKubPriceOracle is EIP712 {
    using ECDSA for bytes32;

    struct PriceData {
        uint192 price;      // USD, 1e18
        uint64  timestamp;  // block.timestamp of last update
    }

    address public admin;
    mapping(address => bool) public isKeeper;
    mapping(bytes32 => PriceData) public prices;

    // Max move allowed per keeper update (bps). 500 = 5%.
    uint256 public maxDeviationBps = 500;

    // Pull/signed prices: a keeper signs (marketId, price, timestamp) off-chain;
    // anyone may submit it (e.g. a liquidator bundling a fresh price with a
    // liquidation). Signed prices allow a larger single move so real gap moves
    // update immediately, and must be recent.
    bytes32 public constant PRICE_TYPEHASH = keccak256("Price(bytes32 marketId,uint256 price,uint256 timestamp)");
    uint256 public maxSignedDeviationBps = 2000; // 20% — bounds a compromised keeper, still passes real gaps
    uint256 public maxSignedAge = 30;            // signed price must be ≤30s old

    event PriceUpdated(bytes32 indexed marketId, uint256 price, address indexed keeper);
    event PriceForced(bytes32 indexed marketId, uint256 price);
    event KeeperSet(address indexed keeper, bool allowed);
    event MaxDeviationUpdated(uint256 bps);
    event SignedPriceParamsUpdated(uint256 maxSignedDeviationBps, uint256 maxSignedAge);
    event AdminChanged(address indexed oldAdmin, address indexed newAdmin);

    modifier onlyAdmin() {
        require(msg.sender == admin, "!admin");
        _;
    }

    modifier onlyKeeper() {
        require(isKeeper[msg.sender], "!keeper");
        _;
    }

    constructor(address _admin) EIP712("XKubPriceOracle", "1") {
        admin = _admin == address(0) ? msg.sender : _admin;
    }

    // ─── Signed (pull) prices ──────────────────────────────────────────────────

    /// @notice Digest a keeper signs off-chain for a pull-price update.
    function hashPrice(bytes32 marketId, uint256 price, uint256 timestamp) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(PRICE_TYPEHASH, marketId, price, timestamp)));
    }

    /// @notice Apply a keeper-signed fresh price. Permissionless — the signature
    ///         is the authorisation. Used to bundle a fresh price with a
    ///         liquidation/execution so it's always current.
    function applySignedPrice(bytes32 marketId, uint256 price, uint256 timestamp, bytes calldata sig) public {
        require(price > 0 && price <= type(uint192).max, "bad price");
        require(timestamp <= block.timestamp && block.timestamp - timestamp <= maxSignedAge, "stale sig");
        require(timestamp >= prices[marketId].timestamp, "older than stored");
        address signer = ECDSA.recover(hashPrice(marketId, price, timestamp), sig);
        require(isKeeper[signer], "!keeper sig");

        uint256 last = prices[marketId].price;
        if (last != 0) {
            uint256 diffBps = price > last ? ((price - last) * 10000) / last : ((last - price) * 10000) / last;
            require(diffBps <= maxSignedDeviationBps, "signed deviation too high");
        }
        prices[marketId] = PriceData(uint192(price), uint64(timestamp));
        emit PriceUpdated(marketId, price, signer);
    }

    // ─── Keeper Price Posts ────────────────────────────────────────────────────

    /// @notice Post prices for multiple markets in one tx (keeper bot entrypoint)
    function setPrices(bytes32[] calldata marketIds, uint256[] calldata newPrices) external onlyKeeper {
        require(marketIds.length == newPrices.length, "len mismatch");
        for (uint256 i = 0; i < marketIds.length; i++) {
            _setPrice(marketIds[i], newPrices[i]);
        }
    }

    function _setPrice(bytes32 marketId, uint256 newPrice) internal {
        require(newPrice > 0 && newPrice <= type(uint192).max, "bad price");
        uint256 last = prices[marketId].price;
        if (last != 0) {
            uint256 diffBps = newPrice > last
                ? ((newPrice - last) * 10000) / last
                : ((last - newPrice) * 10000) / last;
            require(diffBps <= maxDeviationBps, "deviation too high");
        }
        prices[marketId] = PriceData(uint192(newPrice), uint64(block.timestamp));
        emit PriceUpdated(marketId, newPrice, msg.sender);
    }

    // ─── Reads ─────────────────────────────────────────────────────────────────

    /// @notice Price for a market, reverting if unset or older than maxAge seconds
    function getPrice(bytes32 marketId, uint256 maxAge) external view returns (uint256) {
        PriceData memory p = prices[marketId];
        require(p.price != 0, "no price");
        require(block.timestamp - p.timestamp <= maxAge, "stale price");
        return p.price;
    }

    /// @notice Non-reverting read (for UI)
    function peekPrice(bytes32 marketId) external view returns (uint256 price, uint256 updatedAt) {
        PriceData memory p = prices[marketId];
        return (p.price, p.timestamp);
    }

    // ─── Admin ─────────────────────────────────────────────────────────────────

    /// @notice Force-set a price bypassing the deviation guard (bootstrap / circuit breaker)
    function forceSetPrice(bytes32 marketId, uint256 newPrice) external onlyAdmin {
        require(newPrice > 0 && newPrice <= type(uint192).max, "bad price");
        prices[marketId] = PriceData(uint192(newPrice), uint64(block.timestamp));
        emit PriceForced(marketId, newPrice);
    }

    function setKeeper(address keeper, bool allowed) external onlyAdmin {
        require(keeper != address(0), "!keeper");
        isKeeper[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    function setMaxDeviationBps(uint256 bps) external onlyAdmin {
        require(bps >= 10 && bps <= 5000, "10bps-50%");
        maxDeviationBps = bps;
        emit MaxDeviationUpdated(bps);
    }

    function setSignedPriceParams(uint256 devBps, uint256 age) external onlyAdmin {
        require(devBps >= 100 && devBps <= 5000, "1%-50%");
        require(age >= 5 && age <= 300, "5s-5m");
        maxSignedDeviationBps = devBps;
        maxSignedAge = age;
        emit SignedPriceParamsUpdated(devBps, age);
    }

    function setAdmin(address _admin) external onlyAdmin {
        require(_admin != address(0), "!admin");
        emit AdminChanged(admin, _admin);
        admin = _admin;
    }
}
