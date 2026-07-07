// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "./IXKubPerp.sol";

/*//////////////////////////////////////////////////////////////
        XKub Perp: Two-Step Execution Router (anti-front-run)
//////////////////////////////////////////////////////////////

  WHY TWO STEPS
  -------------
  With a keeper-posted oracle, a direct-execution market lets anyone
  trade against a price they know is about to change (watch the CEX,
  beat the keeper's update). GMX-v2-style two-step execution closes
  this: users only SUBMIT a request; a keeper executes it moments
  later at the FRESH price. The user never picks their own fill.

  FLOW
  ----
  1. createIncreaseRequest / createDecreaseRequest
       - collateral (for increases) is escrowed here
       - a small executionFee in native KUB pays the keeper's gas
       - acceptablePrice bounds the fill (0 = no bound)
  2. keeper: executeRequest(id)
       - request too old            → cancel + refund
       - price outside acceptable   → cancel + refund
       - market call reverts        → cancel + refund
       - otherwise position opens/closes for the request owner
     The keeper receives the executionFee in every branch — it paid
     for gas regardless of outcome.
  3. owner may cancelRequest(id) after cancelDelay if no keeper
     picked it up (full refund including executionFee).

  ONE-CLICK TRADING (agent keys)
  ------------------------------
  A wallet popup per order kills UX. Hyperliquid-style fix: the owner
  deposits KUSDT into a router-held balance once, then authorises a
  browser-generated "agent" key via setAgent. The agent submits
  requests FOR the owner with no wallet interaction:
    - collateral is drawn from the owner's router balance
    - the executionFee (native KUB) is paid by the agent itself
    - cancelled agent requests refund collateral back to the balance
  The agent can only trade: positions belong to the owner, close
  payouts go to the owner's wallet (see XKubPerpMarket), and
  withdrawCollateral is owner-only. A leaked agent key can burn fees
  on bad trades but can never move funds out.
*/

interface IXKubReferralRegistrar {
    function registerCodeFor(address owner, bytes32 code) external;
}

interface IXKubPerpMarketRouted {
    function increasePositionFor(address owner, bytes32 marketId, bool isLong, uint256 collateralTokens, uint256 sizeDeltaUsd) external;
    function decreasePositionFor(address owner, bytes32 marketId, bool isLong, uint256 sizeDeltaUsd) external;
    function decreasePositionForTo(address owner, bytes32 marketId, bool isLong, uint256 sizeDeltaUsd, address payoutTo) external returns (uint256 payoutTokens);
    function maxPriceAge() external view returns (uint256);
    function getPosition(address owner, bytes32 marketId, bool isLong)
        external view returns (uint256 sizeUsd, uint256 sizeTokens, uint256 collateralUsd, uint256 entryBorrowX18);
}

contract XKubPerpRouter is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
        GASLESS TRADING (signed orders)
    //////////////////////////////////////////////////////////////
      The agent key SIGNS an order off-chain (no gas); a platform relayer
      (a keeper) submits it and pays the gas. The user never holds KUB — the
      relayer only ever pays to execute a valid, agent-signed trade, so there
      is nothing a user can drain. Front-run-safe: the keeper executes at the
      price it just posted; acceptablePrice bounds the fill.               */
    struct Order {
        address owner;
        bytes32 marketId;
        bool    isLong;
        bool    isIncrease;
        uint256 collateralTokens; // increase: drawn from owner's trading balance
        uint256 sizeDeltaUsd;
        uint256 acceptablePrice;  // 0 = no bound
        uint256 nonce;
        uint256 deadline;
    }
    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address owner,bytes32 marketId,bool isLong,bool isIncrease,uint256 collateralTokens,uint256 sizeDeltaUsd,uint256 acceptablePrice,uint256 nonce,uint256 deadline)"
    );
    mapping(address => uint256) public orderNonce;   // owner → next expected nonce

    struct Request {
        address owner;
        bytes32 marketId;
        bool    isLong;
        bool    isIncrease;
        uint256 collateralTokens;  // escrowed KUSDT (increase only)
        uint256 sizeDeltaUsd;      // USD 1e18
        uint256 acceptablePrice;   // worst fill, USD 1e18; 0 = no bound
        uint256 executionFee;      // native KUB for the executing keeper
        uint64  createdAt;
        uint8   status;            // 0 pending, 1 executed, 2 cancelled
        bool    fromBalance;       // collateral drawn from (and refunded to) the owner's router balance
        bool    payoutToBalance;   // close payout credited to the router balance (1-click) vs owner's wallet
    }

    uint8 constant STATUS_PENDING   = 0;
    uint8 constant STATUS_EXECUTED  = 1;
    uint8 constant STATUS_CANCELLED = 2;

    IERC20 public immutable kusdt;
    IXKubPerpMarketRouted public immutable market;
    IXKubPriceOracle public immutable oracle;

    address public admin;
    address public referral; // optional, for one-tx referral registration
    mapping(address => bool) public isKeeper;

    Request[] public requests;
    uint256 public nextPendingIndex; // keeper scan cursor (monotonic hint)

    // One-click trading
    mapping(address => uint256) public collateralBalance;            // owner → router-held KUSDT
    mapping(address => mapping(address => bool)) public isAgent;     // owner → agent → approved

    uint256 public minExecutionFee = 0.001 ether; // native KUB
    uint256 public maxExecuteAge   = 300;         // requests older → cancel only
    uint256 public cancelDelay     = 60;          // owner self-cancel after

    // Take-profit / stop-loss trigger orders. One per (owner, market, side);
    // the keeper closes the whole position when the oracle price crosses a
    // trigger. Prices are USD 1e18; 0 disables that side.
    struct Trigger {
        uint256 tpPrice;       // take-profit trigger
        uint256 slPrice;       // stop-loss trigger
        uint256 executionFee;  // native KUB for the executing keeper
        bool    active;
        bool    payoutToBalance; // close payout to trading balance (agent) vs wallet
    }
    mapping(bytes32 => Trigger) public triggers; // key = keccak(owner, marketId, isLong)

    event RequestCreated(uint256 indexed id, address indexed owner, bytes32 indexed marketId,
        bool isLong, bool isIncrease, uint256 collateralTokens, uint256 sizeDeltaUsd,
        uint256 acceptablePrice, uint256 executionFee);
    event RequestExecuted(uint256 indexed id, address indexed keeper, uint256 price);
    event RequestCancelled(uint256 indexed id, address indexed by, string reason);
    event KeeperSet(address indexed keeper, bool allowed);
    event AgentSet(address indexed owner, address indexed agent, bool allowed);
    event CollateralDeposited(address indexed owner, uint256 tokens);
    event CollateralWithdrawn(address indexed owner, uint256 tokens);
    event ParamsUpdated(uint256 minExecutionFee, uint256 maxExecuteAge, uint256 cancelDelay);
    event AdminChanged(address indexed oldAdmin, address indexed newAdmin);
    event TriggerSet(address indexed owner, bytes32 indexed marketId, bool isLong, uint256 tpPrice, uint256 slPrice);
    event TriggerCancelled(address indexed owner, bytes32 indexed marketId, bool isLong, address indexed by);
    event TriggerExecuted(address indexed owner, bytes32 indexed marketId, bool isLong, address keeper, uint256 price, bool tp);
    event SignedOrderExecuted(address indexed owner, bytes32 indexed marketId, bool isLong, bool isIncrease, uint256 nonce, uint256 price);

    modifier onlyAdmin() {
        require(msg.sender == admin, "!admin");
        _;
    }

    modifier onlyKeeper() {
        require(isKeeper[msg.sender], "!keeper");
        _;
    }

    constructor(address _kusdt, address _market, address _oracle, address _admin)
        EIP712("XKubPerp", "1")
    {
        require(_kusdt != address(0) && _market != address(0) && _oracle != address(0), "!addr");
        kusdt  = IERC20(_kusdt);
        market = IXKubPerpMarketRouted(_market);
        oracle = IXKubPriceOracle(_oracle);
        admin  = _admin == address(0) ? msg.sender : _admin;
        // The market pulls escrowed collateral from this contract
        IERC20(_kusdt).forceApprove(_market, type(uint256).max);
    }

    // ─── User: submit requests ─────────────────────────────────────────────────

    /// @notice Queue an open/increase. Collateral is escrowed until execution.
    /// @param acceptablePrice worst fill (long: max, short: min). 0 = no bound.
    function createIncreaseRequest(
        bytes32 marketId,
        bool isLong,
        uint256 collateralTokens,
        uint256 sizeDeltaUsd,
        uint256 acceptablePrice
    ) external payable nonReentrant returns (uint256 id) {
        require(msg.value >= minExecutionFee, "fee too low");
        require(collateralTokens > 0 || sizeDeltaUsd > 0, "empty");
        if (collateralTokens > 0) {
            kusdt.safeTransferFrom(msg.sender, address(this), collateralTokens);
        }
        id = _push(msg.sender, marketId, isLong, true, collateralTokens, sizeDeltaUsd, acceptablePrice, false, false);
    }

    /// @notice Queue a close/decrease.
    /// @param acceptablePrice worst fill (long close: min, short close: max). 0 = no bound.
    function createDecreaseRequest(
        bytes32 marketId,
        bool isLong,
        uint256 sizeDeltaUsd,
        uint256 acceptablePrice
    ) external payable nonReentrant returns (uint256 id) {
        require(msg.value >= minExecutionFee, "fee too low");
        require(sizeDeltaUsd > 0, "empty");
        id = _push(msg.sender, marketId, isLong, false, 0, sizeDeltaUsd, acceptablePrice, false, false);
    }

    // ─── One-click trading: balance + agents ───────────────────────────────────

    /// @notice Escrow KUSDT in the router for agent trading.
    function depositCollateral(uint256 tokens) external nonReentrant {
        require(tokens > 0, "empty");
        kusdt.safeTransferFrom(msg.sender, address(this), tokens);
        collateralBalance[msg.sender] += tokens;
        emit CollateralDeposited(msg.sender, tokens);
    }

    /// @notice Withdraw router-held KUSDT. Owner only — agents cannot call
    ///         this with someone else's balance.
    function withdrawCollateral(uint256 tokens) external nonReentrant {
        require(tokens > 0, "empty");
        collateralBalance[msg.sender] -= tokens; // reverts on underflow
        kusdt.safeTransfer(msg.sender, tokens);
        emit CollateralWithdrawn(msg.sender, tokens);
    }

    /// @notice Authorise (or revoke) an agent key to submit requests for you.
    function setAgent(address agent, bool allowed) external {
        require(agent != address(0) && agent != msg.sender, "!agent");
        isAgent[msg.sender][agent] = allowed;
        emit AgentSet(msg.sender, agent, allowed);
    }

    /// @notice One-tx onboarding: authorise an agent, deposit collateral, fund
    ///         the agent's gas, and (optionally) register a referral code — all
    ///         in a single wallet confirmation (works on any wallet, no
    ///         EIP-5792 needed). Approve KUSDT first if depositTokens > 0.
    ///         referralCode = 0 to skip registration.
    function setupAccount(address agent, uint256 depositTokens, bytes32 referralCode) external payable nonReentrant {
        require(agent != address(0) && agent != msg.sender, "!agent");
        isAgent[msg.sender][agent] = true;
        emit AgentSet(msg.sender, agent, true);
        if (depositTokens > 0) {
            kusdt.safeTransferFrom(msg.sender, address(this), depositTokens);
            collateralBalance[msg.sender] += depositTokens;
            emit CollateralDeposited(msg.sender, depositTokens);
        }
        if (referralCode != bytes32(0) && referral != address(0)) {
            IXKubReferralRegistrar(referral).registerCodeFor(msg.sender, referralCode);
        }
        if (msg.value > 0) _payNative(agent, msg.value); // gas for the agent
    }

    function setReferral(address _referral) external onlyAdmin {
        referral = _referral;
    }

    /// @notice Agent entry: open/increase for `owner`. Collateral comes from the
    ///         owner's router balance; the executionFee comes from the agent.
    function createIncreaseRequestFor(
        address owner,
        bytes32 marketId,
        bool isLong,
        uint256 collateralTokens,
        uint256 sizeDeltaUsd,
        uint256 acceptablePrice
    ) external payable nonReentrant returns (uint256 id) {
        require(isAgent[owner][msg.sender], "!agent");
        require(msg.value >= minExecutionFee, "fee too low");
        require(collateralTokens > 0 || sizeDeltaUsd > 0, "empty");
        if (collateralTokens > 0) {
            collateralBalance[owner] -= collateralTokens; // reverts on underflow
        }
        id = _push(owner, marketId, isLong, true, collateralTokens, sizeDeltaUsd, acceptablePrice, true, false);
    }

    /// @notice Agent entry: close/decrease for `owner`. Payout returns to the
    ///         owner's trading balance (1-click), not their wallet.
    function createDecreaseRequestFor(
        address owner,
        bytes32 marketId,
        bool isLong,
        uint256 sizeDeltaUsd,
        uint256 acceptablePrice
    ) external payable nonReentrant returns (uint256 id) {
        require(isAgent[owner][msg.sender], "!agent");
        require(msg.value >= minExecutionFee, "fee too low");
        require(sizeDeltaUsd > 0, "empty");
        id = _push(owner, marketId, isLong, false, 0, sizeDeltaUsd, acceptablePrice, false, true);
    }

    function _push(
        address owner, bytes32 marketId, bool isLong, bool isIncrease,
        uint256 collateralTokens, uint256 sizeDeltaUsd, uint256 acceptablePrice, bool fromBalance, bool payoutToBalance
    ) internal returns (uint256 id) {
        id = requests.length;
        requests.push(Request({
            owner: owner,
            marketId: marketId,
            isLong: isLong,
            isIncrease: isIncrease,
            collateralTokens: collateralTokens,
            sizeDeltaUsd: sizeDeltaUsd,
            acceptablePrice: acceptablePrice,
            executionFee: msg.value,
            createdAt: uint64(block.timestamp),
            status: STATUS_PENDING,
            fromBalance: fromBalance,
            payoutToBalance: payoutToBalance
        }));
        emit RequestCreated(id, owner, marketId, isLong, isIncrease,
            collateralTokens, sizeDeltaUsd, acceptablePrice, msg.value);
    }

    // ─── Take-profit / stop-loss triggers ──────────────────────────────────────

    function _triggerKey(address owner, bytes32 marketId, bool isLong) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(owner, marketId, isLong));
    }

    /// @notice Set (or replace) a TP/SL for your position. Escrows an execution
    ///         fee the keeper collects when it triggers. Replacing refunds the
    ///         previous fee. Either price may be 0 to leave that side unset.
    function setTrigger(bytes32 marketId, bool isLong, uint256 tpPrice, uint256 slPrice)
        external payable nonReentrant
    {
        _setTrigger(msg.sender, marketId, isLong, tpPrice, slPrice, false);
    }

    /// @notice Agent version — set a TP/SL on the owner's behalf. Payout on
    ///         trigger returns to the owner's trading balance (1-click).
    function setTriggerFor(address owner, bytes32 marketId, bool isLong, uint256 tpPrice, uint256 slPrice)
        external payable nonReentrant
    {
        require(isAgent[owner][msg.sender], "!agent");
        _setTrigger(owner, marketId, isLong, tpPrice, slPrice, true);
    }

    function _setTrigger(address owner, bytes32 marketId, bool isLong, uint256 tpPrice, uint256 slPrice, bool payoutToBalance) internal {
        require(tpPrice > 0 || slPrice > 0, "empty");
        require(msg.value >= minExecutionFee, "fee too low");
        bytes32 k = _triggerKey(owner, marketId, isLong);
        Trigger storage t = triggers[k];
        if (t.active && t.executionFee > 0) _payNative(owner, t.executionFee); // refund prior fee
        triggers[k] = Trigger(tpPrice, slPrice, msg.value, true, payoutToBalance);
        emit TriggerSet(owner, marketId, isLong, tpPrice, slPrice);
    }

    /// @notice Cancel your TP/SL and get the escrowed fee back. Owner or agent.
    function cancelTrigger(bytes32 marketId, bool isLong) external nonReentrant {
        _cancelTrigger(msg.sender, marketId, isLong, msg.sender);
    }
    function cancelTriggerFor(address owner, bytes32 marketId, bool isLong) external nonReentrant {
        require(isAgent[owner][msg.sender], "!agent");
        _cancelTrigger(owner, marketId, isLong, owner);
    }
    function _cancelTrigger(address owner, bytes32 marketId, bool isLong, address feeTo) internal {
        bytes32 k = _triggerKey(owner, marketId, isLong);
        Trigger storage t = triggers[k];
        require(t.active, "no trigger");
        uint256 fee = t.executionFee;
        delete triggers[k];
        _payNative(feeTo, fee);
        emit TriggerCancelled(owner, marketId, isLong, msg.sender);
    }

    /// @notice Keeper: close the whole position when its TP/SL is hit at the
    ///         fresh oracle price. If the position is already gone, the trigger
    ///         is cleared and the fee refunded to the owner.
    function executeTrigger(address owner, bytes32 marketId, bool isLong) external nonReentrant onlyKeeper {
        bytes32 k = _triggerKey(owner, marketId, isLong);
        Trigger storage t = triggers[k];
        require(t.active, "no trigger");

        (uint256 sizeUsd,,,) = market.getPosition(owner, marketId, isLong);
        uint256 fee = t.executionFee;

        // Position closed elsewhere → clean up, refund the owner.
        if (sizeUsd == 0) {
            delete triggers[k];
            _payNative(owner, fee);
            emit TriggerCancelled(owner, marketId, isLong, msg.sender);
            return;
        }

        uint256 price = oracle.getPrice(marketId, market.maxPriceAge());
        bool tpHit = t.tpPrice > 0 && (isLong ? price >= t.tpPrice : price <= t.tpPrice);
        bool slHit = t.slPrice > 0 && (isLong ? price <= t.slPrice : price >= t.slPrice);
        require(tpHit || slHit, "not triggered");

        bool toBalance = t.payoutToBalance;
        delete triggers[k];
        if (toBalance) {
            uint256 payout = market.decreasePositionForTo(owner, marketId, isLong, sizeUsd, address(this));
            collateralBalance[owner] += payout;
        } else {
            market.decreasePositionFor(owner, marketId, isLong, sizeUsd); // close full at fresh price
        }
        _payNative(msg.sender, fee);
        emit TriggerExecuted(owner, marketId, isLong, msg.sender, price, tpHit);
    }

    // ─── Gasless: agent-signed orders ──────────────────────────────────────────

    /// @notice EIP-712 digest for an order (frontend signs this with the agent key).
    function hashOrder(Order calldata o) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            ORDER_TYPEHASH, o.owner, o.marketId, o.isLong, o.isIncrease,
            o.collateralTokens, o.sizeDeltaUsd, o.acceptablePrice, o.nonce, o.deadline
        )));
    }

    /// @notice Relayer (keeper) submits an agent-signed order and pays the gas.
    ///         Executes at the fresh oracle price. Collateral for increases comes
    ///         from the owner's trading balance; close payouts return to it.
    function executeSignedOrder(Order calldata o, bytes calldata sig) external nonReentrant onlyKeeper {
        _executeSignedOrder(o, sig);
    }

    /// @notice One-tx variant: apply a keeper-signed fresh price and execute
    ///         atomically. Removes the separate price-post round-trip (halves
    ///         latency) while keeping execution-time pricing — the price is still
    ///         a fresh, keeper-signed value applied in the same tx as the fill.
    function executeSignedOrderWithPrice(
        Order calldata o, bytes calldata orderSig,
        uint256 price, uint256 timestamp, bytes calldata priceSig
    ) external nonReentrant onlyKeeper {
        oracle.applySignedPrice(o.marketId, price, timestamp, priceSig);
        _executeSignedOrder(o, orderSig);
    }

    function _executeSignedOrder(Order calldata o, bytes calldata sig) internal {
        require(block.timestamp <= o.deadline, "expired");
        require(o.nonce == orderNonce[o.owner], "bad nonce");
        address signer = ECDSA.recover(hashOrder(o), sig);
        require(isAgent[o.owner][signer], "!agent sig");
        orderNonce[o.owner]++;

        uint256 price = oracle.getPrice(o.marketId, market.maxPriceAge());
        if (o.acceptablePrice != 0) {
            bool ok = o.isIncrease
                ? (o.isLong ? price <= o.acceptablePrice : price >= o.acceptablePrice)
                : (o.isLong ? price >= o.acceptablePrice : price <= o.acceptablePrice);
            require(ok, "price bound");
        }

        if (o.isIncrease) {
            if (o.collateralTokens > 0) collateralBalance[o.owner] -= o.collateralTokens; // trading balance
            market.increasePositionFor(o.owner, o.marketId, o.isLong, o.collateralTokens, o.sizeDeltaUsd);
        } else {
            uint256 payout = market.decreasePositionForTo(o.owner, o.marketId, o.isLong, o.sizeDeltaUsd, address(this));
            collateralBalance[o.owner] += payout;
        }
        emit SignedOrderExecuted(o.owner, o.marketId, o.isLong, o.isIncrease, o.nonce, price);
    }

    // ─── Keeper: execute ───────────────────────────────────────────────────────

    /// @notice Execute a pending request at the current (fresh) oracle price.
    ///         Never reverts on user-level failures — those cancel + refund,
    ///         and the keeper keeps the executionFee (it paid gas either way).
    function executeRequest(uint256 id) external nonReentrant onlyKeeper {
        Request storage r = requests[id];
        require(r.status == STATUS_PENDING, "not pending");

        if (block.timestamp - r.createdAt > maxExecuteAge) {
            _cancel(id, r, msg.sender, "expired");
            return;
        }

        uint256 price = oracle.getPrice(r.marketId, market.maxPriceAge());
        if (r.acceptablePrice != 0) {
            bool ok = r.isIncrease
                ? (r.isLong ? price <= r.acceptablePrice : price >= r.acceptablePrice)
                : (r.isLong ? price >= r.acceptablePrice : price <= r.acceptablePrice);
            if (!ok) {
                _cancel(id, r, msg.sender, "price bound");
                return;
            }
        }

        bool success;
        if (r.isIncrease) {
            try market.increasePositionFor(r.owner, r.marketId, r.isLong, r.collateralTokens, r.sizeDeltaUsd) {
                success = true;
            } catch {}
        } else if (r.payoutToBalance) {
            // 1-click close: payout returns to the owner's trading balance
            try market.decreasePositionForTo(r.owner, r.marketId, r.isLong, r.sizeDeltaUsd, address(this)) returns (uint256 payout) {
                collateralBalance[r.owner] += payout;
                success = true;
            } catch {}
        } else {
            try market.decreasePositionFor(r.owner, r.marketId, r.isLong, r.sizeDeltaUsd) {
                success = true;
            } catch {}
        }

        if (!success) {
            _cancel(id, r, msg.sender, "market revert");
            return;
        }

        r.status = STATUS_EXECUTED;
        _bumpCursor(id);
        _payNative(msg.sender, r.executionFee);
        emit RequestExecuted(id, msg.sender, price);
    }

    // ─── Owner: self-cancel ────────────────────────────────────────────────────

    /// @notice Cancel your own request (after cancelDelay) — full refund
    ///         including the executionFee. The owner's agent may cancel too
    ///         (the fee then returns to the caller, who originally paid it).
    function cancelRequest(uint256 id) external nonReentrant {
        Request storage r = requests[id];
        require(r.status == STATUS_PENDING, "not pending");
        require(msg.sender == r.owner || isAgent[r.owner][msg.sender], "!owner");
        require(block.timestamp - r.createdAt >= cancelDelay, "too early");
        _cancel(id, r, msg.sender, "user cancel");
    }

    /// @dev Refund escrowed collateral to the owner — to their router balance
    ///      for agent-created requests, to their wallet otherwise. The
    ///      executionFee goes to the caller: the keeper when it triggered the
    ///      cancel (gas spent), the owner/agent when self-cancelling.
    function _cancel(uint256 id, Request storage r, address feeRecipient, string memory reason) internal {
        r.status = STATUS_CANCELLED;
        _bumpCursor(id);
        if (r.isIncrease && r.collateralTokens > 0) {
            if (r.fromBalance) {
                collateralBalance[r.owner] += r.collateralTokens;
            } else {
                kusdt.safeTransfer(r.owner, r.collateralTokens);
            }
        }
        _payNative(feeRecipient, r.executionFee);
        emit RequestCancelled(id, feeRecipient, reason);
    }

    function _bumpCursor(uint256 id) internal {
        if (id == nextPendingIndex) {
            uint256 i = id + 1;
            uint256 n = requests.length;
            while (i < n && requests[i].status != STATUS_PENDING) i++;
            nextPendingIndex = i;
        }
    }

    function _payNative(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool sent,) = payable(to).call{value: amount}("");
        require(sent, "native transfer failed");
    }

    // ─── Views ─────────────────────────────────────────────────────────────────

    function requestsCount() external view returns (uint256) {
        return requests.length;
    }

    /// @notice Pending request ids from the scan cursor (keeper bot helper)
    function getPendingRequests(uint256 limit) external view returns (uint256[] memory ids) {
        uint256 n = requests.length;
        uint256[] memory buf = new uint256[](limit);
        uint256 found = 0;
        for (uint256 i = nextPendingIndex; i < n && found < limit; i++) {
            if (requests[i].status == STATUS_PENDING) buf[found++] = i;
        }
        ids = new uint256[](found);
        for (uint256 j = 0; j < found; j++) ids[j] = buf[j];
    }

    // ─── Admin ─────────────────────────────────────────────────────────────────

    function setKeeper(address keeper, bool allowed) external onlyAdmin {
        require(keeper != address(0), "!keeper");
        isKeeper[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    function setParams(uint256 _minExecutionFee, uint256 _maxExecuteAge, uint256 _cancelDelay) external onlyAdmin {
        require(_maxExecuteAge >= 30 && _maxExecuteAge <= 3600, "age 30s-1h");
        require(_cancelDelay <= _maxExecuteAge, "delay > age");
        minExecutionFee = _minExecutionFee;
        maxExecuteAge   = _maxExecuteAge;
        cancelDelay     = _cancelDelay;
        emit ParamsUpdated(_minExecutionFee, _maxExecuteAge, _cancelDelay);
    }

    function setAdmin(address _admin) external onlyAdmin {
        require(_admin != address(0), "!admin");
        emit AdminChanged(admin, _admin);
        admin = _admin;
    }
}
