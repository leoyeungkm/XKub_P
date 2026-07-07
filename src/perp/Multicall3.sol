// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal Multicall3 — batches many view calls into one eth_call so
///         the frontend (viem/wagmi useReadContracts) does a single RPC round
///         trip. Deployed on chains that lack the canonical Multicall3
///         (KUB testnet / local); KUB mainnet already has it at
///         0xcA11bde05977b3631167028862bE2a173976CA11.
contract Multicall3 {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }
    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory returnData) {
        uint256 length = calls.length;
        returnData = new Result[](length);
        for (uint256 i = 0; i < length; i++) {
            Call3 calldata c = calls[i];
            (bool success, bytes memory ret) = c.target.call(c.callData);
            if (!success && !c.allowFailure) {
                revert("Multicall3: call failed");
            }
            returnData[i] = Result(success, ret);
        }
    }

    function getCurrentBlockTimestamp() external view returns (uint256) {
        return block.timestamp;
    }

    function getEthBalance(address addr) external view returns (uint256) {
        return addr.balance;
    }
}
