// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IHyperFunFactoryTierLib {
    function getGraduationTierCount() external view returns (uint256);
    function getGraduationTier(uint256 index) external view returns (
        uint256 threshold,
        uint256 bcVirtual,
        uint256 navMinMulBps,
        uint256 navMaxMulBps,
        uint256 squaredRatioBps
    );
    function globalBcVirtualMinimumBps() external view returns (uint256);
}

/// @title HyperFunTokenLib
/// @notice External library — tier calculation bodies live here, not in HyperFunToken.
///         Reduces Token bytecode by ~240 bytes net.
library HyperFunTokenLib {

    uint256 private constant BPS = 10_000;
    uint256 private constant PRECISION = 1e18;

    // ─── Internal try-catch helpers ───────────────────────────────────────────

    function _getTierCount(address factoryAddr) internal view returns (uint256) {
        try IHyperFunFactoryTierLib(factoryAddr).getGraduationTierCount() returns (uint256 count) {
            return count;
        } catch {
            return 0;
        }
    }

    function _getTier(address factoryAddr, uint256 index) internal view returns (
        uint256 threshold,
        uint256 bcVirtual,
        uint256 navMinMulBps,
        uint256 navMaxMulBps,
        uint256 squaredRatioBps
    ) {
        try IHyperFunFactoryTierLib(factoryAddr).getGraduationTier(index) returns (
            uint256 t, uint256 bc, uint256 minMul, uint256 maxMul, uint256 sqRatio
        ) {
            return (t, bc, minMul, maxMul, sqRatio);
        } catch {
            return (0, 0, 0, 0, BPS); // Default to 100% squared (backwards compatible)
        }
    }

    // ─── Public library functions (called by Token) ───────────────────────────

    /// @notice Calculate NAV Virtual using graduation tiers
    function calcTieredNavVirtual(
        uint256 assets,
        uint256 supply,
        address factoryAddr
    ) external view returns (uint256) {
        uint256 minNavVirtual = 1000 * PRECISION;

        uint256 tierCount = _getTierCount(factoryAddr);
        if (tierCount == 0) {
            return minNavVirtual;
        }

        uint256 prevThreshold = 0;
        uint256 prevNavMaxMul = 0;

        for (uint256 i = 0; i < tierCount; i++) {
            (uint256 threshold, , uint256 navMinMul, uint256 navMaxMul, ) = _getTier(factoryAddr, i);

            if (assets < threshold) {
                uint256 multiplierBps;
                if (i == 0) {
                    if (threshold > 0) {
                        uint256 progress = (assets * BPS) / threshold;
                        multiplierBps = navMinMul + (progress * (navMaxMul - navMinMul)) / BPS;
                    } else {
                        multiplierBps = navMinMul;
                    }
                } else {
                    uint256 tierRange = threshold - prevThreshold;
                    uint256 assetsInTier = assets - prevThreshold;
                    uint256 progress = tierRange > 0 ? (assetsInTier * BPS) / tierRange : 0;
                    multiplierBps = prevNavMaxMul + (progress * (navMaxMul - prevNavMaxMul)) / BPS;
                }

                uint256 baseValue = assets < supply ? assets : supply;
                uint256 navVirtual = (baseValue * multiplierBps) / BPS;
                return navVirtual > minNavVirtual ? navVirtual : minNavVirtual;
            }

            prevThreshold = threshold;
            prevNavMaxMul = navMaxMul;
        }

        // Beyond last tier: use last tier's navMaxMul
        (, , , uint256 lastNavMaxMul, ) = _getTier(factoryAddr, tierCount - 1);
        uint256 finalBase = assets < supply ? assets : supply;
        uint256 navVirtual = (finalBase * lastNavMaxMul) / BPS;
        return navVirtual > minNavVirtual ? navVirtual : minNavVirtual;
    }

    /// @notice Calculate BC Virtual using graduation tiers
    function calcTieredBcVirtual(
        uint256 assets,
        address factoryAddr,
        uint256 storedVirtualBase
    ) external view returns (uint256) {
        uint256 tierCount = _getTierCount(factoryAddr);
        if (tierCount == 0) {
            return storedVirtualBase;
        }

        uint256 minimumBps = IHyperFunFactoryTierLib(factoryAddr).globalBcVirtualMinimumBps();
        if (minimumBps == 0) minimumBps = 500;

        uint256 prevThreshold = 0;
        uint256 prevBcVirtual = 0;

        for (uint256 i = 0; i < tierCount; i++) {
            (uint256 threshold, uint256 bcVirtual, , , ) = _getTier(factoryAddr, i);

            if (assets < threshold) {
                if (i == 0) {
                    uint256 minimum = (bcVirtual * minimumBps) / BPS;
                    if (threshold > 0) {
                        uint256 progress = (assets * BPS) / threshold;
                        return minimum + (progress * (bcVirtual - minimum)) / BPS;
                    }
                    return minimum;
                } else {
                    uint256 tierRange = threshold - prevThreshold;
                    uint256 assetsInTier = assets - prevThreshold;
                    if (tierRange > 0) {
                        uint256 progress = (assetsInTier * BPS) / tierRange;
                        return prevBcVirtual + (progress * (bcVirtual - prevBcVirtual)) / BPS;
                    }
                    return prevBcVirtual;
                }
            }

            prevThreshold = threshold;
            prevBcVirtual = bcVirtual;
        }

        // Beyond last tier: use last tier's bcVirtual
        (, uint256 lastBcVirtual, , , ) = _getTier(factoryAddr, tierCount - 1);
        return lastBcVirtual;
    }

    /// @notice Calculate squared ratio weight using graduation tiers
    function calcSquaredRatioWeight(
        uint256 assets,
        address factoryAddr
    ) external view returns (uint256) {
        uint256 tierCount = _getTierCount(factoryAddr);
        if (tierCount == 0) {
            return BPS;
        }

        for (uint256 i = 0; i < tierCount; i++) {
            (uint256 threshold, , , , uint256 squaredRatioBps) = _getTier(factoryAddr, i);

            if (assets < threshold) {
                return squaredRatioBps;
            }
        }

        // Beyond last tier: use last tier's squaredRatioBps
        (, , , , uint256 lastSquaredRatio) = _getTier(factoryAddr, tierCount - 1);
        return lastSquaredRatio;
    }
}
