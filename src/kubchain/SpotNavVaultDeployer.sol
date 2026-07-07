// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./SpotNavVault.sol";

/// @title SpotNavVaultDeployer
/// @notice Tiny helper that deploys fresh SpotNavVault instances on behalf of XKubFactory.
///         Separating deployment here keeps XKubFactory under the 24 KB contract size limit,
///         since SpotNavVault + DiamonPricing bytecode is not embedded in the factory.
contract SpotNavVaultDeployer {
    event SpotNavVaultDeployed(address indexed spotNavVault, address indexed vault);

    /// @param _router     Diamon Router
    /// @param _dexFactory Diamon Factory
    /// @param _quote      KUSDT address
    /// @param _vault      XKubToken vault (NAV reads balances from here)
    /// @param _admin      Initial admin (pass factory address — transfer after init)
    function deploy(
        address _router,
        address _dexFactory,
        address _quote,
        address _vault,
        address _admin
    ) external returns (address spotNavVault) {
        SpotNavVault snv = new SpotNavVault(_router, _dexFactory, _quote, _vault, _admin);
        spotNavVault = address(snv);
        emit SpotNavVaultDeployed(spotNavVault, _vault);
    }
}
