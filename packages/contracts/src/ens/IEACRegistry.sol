// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IEACRegistry
/// @notice Subset of the ENSv2 Permissioned Registry's Enhanced Access Control surface that
///         Lifeboat uses. Role constants and signatures follow the ENSv2 docs
///         (docs.ens.domains/ensv2/permissioned-registry). The Lifeboat vault holds the
///         critical roles and exercises them via `pqExecute`, so a quantum attacker holding
///         the ECDSA key can never repoint the name.
interface IEACRegistry {
    // Role bit positions (regular half). Admin variant of each is `role << 128`.
    function ROLE_UNREGISTER() external view returns (uint256); // 1 << 12
    function ROLE_RENEW() external view returns (uint256); //       1 << 16
    function ROLE_SET_SUBREGISTRY() external view returns (uint256); // 1 << 20
    function ROLE_SET_RESOLVER() external view returns (uint256); //   1 << 24

    function setResolver(bytes32 labelhash, address resolver) external;
    function setSubregistry(bytes32 labelhash, address registry) external;
    function grantRoles(uint256 resource, uint256 roleBitmap, address account) external;
    function revokeRoles(uint256 resource, uint256 roleBitmap, address account) external;

    function getResolver(bytes32 labelhash) external view returns (address);
    function hasRoles(uint256 resource, uint256 roleBitmap, address account)
        external
        view
        returns (bool);
    function resourceOf(bytes32 labelhash) external pure returns (uint256);
}
