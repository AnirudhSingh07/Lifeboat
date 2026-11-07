// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IEACRegistry} from "./IEACRegistry.sol";

/// @title EACRegistryMock
/// @notice A faithful minimal stand-in for the ENSv2 Permissioned Registry's Enhanced
///         Access Control, for local devnet testing of Lifeboat's ENS protection. Role
///         constants and the role-gated `setResolver` mirror the ENSv2 docs. On Sepolia you
///         would point Lifeboat at the real deployed registry instead of this mock.
/// @dev Simplifications vs. production: resource = uint256(labelhash) (production packs the
///      labelhash in the upper 224 bits with a 32-bit eacVersionId); `register` grants initial
///      roles without a separate admin flow.
contract EACRegistryMock is IEACRegistry {
    uint256 public constant override ROLE_UNREGISTER = 1 << 12;
    uint256 public constant override ROLE_RENEW = 1 << 16;
    uint256 public constant override ROLE_SET_SUBREGISTRY = 1 << 20;
    uint256 public constant override ROLE_SET_RESOLVER = 1 << 24;

    mapping(uint256 => address) public resolvers;
    mapping(uint256 => address) public subregistries;
    mapping(uint256 => mapping(address => uint256)) private _roles; // resource => account => bitmap

    event EACRolesChanged(uint256 indexed resource, address indexed account, uint256 oldBitmap, uint256 newBitmap);
    event ResolverSet(uint256 indexed resource, address resolver);
    event SubregistrySet(uint256 indexed resource, address registry);

    error Unauthorized(uint256 role);
    error NotAdmin();

    function resourceOf(bytes32 labelhash) public pure override returns (uint256) {
        return uint256(labelhash);
    }

    /// @notice Register a name and grant initial roles (e.g. all critical roles to the vault).
    function register(bytes32 labelhash, uint256 roleBitmap, address roleHolder, address resolver)
        external
    {
        uint256 res = resourceOf(labelhash);
        resolvers[res] = resolver;
        if (roleBitmap != 0) _grant(res, roleBitmap, roleHolder);
    }

    function grantRoles(uint256 resource, uint256 roleBitmap, address account) external override {
        // admin of a role is `role << 128`; holder of the admin bits may grant the regular bits
        if (!hasRoles(resource, roleBitmap << 128, msg.sender)) revert NotAdmin();
        _grant(resource, roleBitmap, account);
    }

    function revokeRoles(uint256 resource, uint256 roleBitmap, address account) external override {
        if (!hasRoles(resource, roleBitmap << 128, msg.sender)) revert NotAdmin();
        uint256 old = _roles[resource][account];
        uint256 next = old & ~roleBitmap;
        _roles[resource][account] = next;
        emit EACRolesChanged(resource, account, old, next);
    }

    function setResolver(bytes32 labelhash, address resolver) external override {
        uint256 res = resourceOf(labelhash);
        if (!hasRoles(res, ROLE_SET_RESOLVER, msg.sender)) revert Unauthorized(ROLE_SET_RESOLVER);
        resolvers[res] = resolver;
        emit ResolverSet(res, resolver);
    }

    function setSubregistry(bytes32 labelhash, address registry) external override {
        uint256 res = resourceOf(labelhash);
        if (!hasRoles(res, ROLE_SET_SUBREGISTRY, msg.sender)) {
            revert Unauthorized(ROLE_SET_SUBREGISTRY);
        }
        subregistries[res] = registry;
        emit SubregistrySet(res, registry);
    }

    function getResolver(bytes32 labelhash) external view override returns (address) {
        return resolvers[resourceOf(labelhash)];
    }

    function hasRoles(uint256 resource, uint256 roleBitmap, address account)
        public
        view
        override
        returns (bool)
    {
        return (_roles[resource][account] & roleBitmap) == roleBitmap;
    }

    function _grant(uint256 resource, uint256 roleBitmap, address account) internal {
        uint256 old = _roles[resource][account];
        // grant the regular roles AND their admin bits, so the holder can delegate further
        uint256 next = old | roleBitmap | (roleBitmap << 128);
        _roles[resource][account] = next;
        emit EACRolesChanged(resource, account, old, next);
    }
}
