// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC7579Account, IERC7579Module, MODULE_TYPE_EXECUTOR} from "./IERC7579.sol";

/// @title LifeboatExecutor
/// @notice An ERC-7579 executor module that brings Lifeboat's "the everyday key can only
///         start a timelocked, vetoable withdrawal" guarantee to an EXISTING modular smart
///         account — no migration, no new seed. Install it, and value leaving the account
///         through this module is timelocked and can be vetoed by the strong key.
/// @dev MVP scope: the strong (veto) key is a `guardian` address (a hardware wallet, or the
///      Lifeboat vault itself, or an MPC signer). The post-quantum verifier plugs in exactly
///      as in the standalone LifeboatVault — swap the guardian check for `LifeboatPQ.verify`.
///      Caveat: this only governs funds moved THROUGH the account's module flow; it cannot
///      stop a raw signature on an EOA (the documented protocol-level migration gap).
contract LifeboatExecutor is IERC7579Module {
    struct Policy {
        address hotKey; // may only request
        address guardian; // strong key: may veto
        uint64 timelock;
        bool installed;
    }

    struct Pending {
        address to;
        uint256 value;
        bytes data;
        uint64 unlockTime; // 0 == none
        bool vetoed;
    }

    mapping(address account => Policy) public policy;
    mapping(address account => mapping(uint256 id => Pending)) private _pending;
    mapping(address account => uint256) public count;

    event Installed(address indexed account, address hotKey, address guardian, uint64 timelock);
    event Uninstalled(address indexed account);
    event Requested(address indexed account, uint256 indexed id, address to, uint256 value, uint64 unlockTime);
    event Executed(address indexed account, uint256 indexed id);
    event Vetoed(address indexed account, uint256 indexed id);

    error NotHotKey();
    error NotGuardian();
    error NotPending();
    error AlreadyVetoed();
    error TimelockNotElapsed();
    error NotInstalled();

    // --------------------------- ERC-7579 lifecycle ---------------------------

    /// @param data abi.encode(address hotKey, address guardian, uint64 timelock)
    function onInstall(bytes calldata data) external override {
        (address hotKey, address guardian, uint64 timelock) =
            abi.decode(data, (address, address, uint64));
        policy[msg.sender] = Policy(hotKey, guardian, timelock, true);
        emit Installed(msg.sender, hotKey, guardian, timelock);
    }

    function onUninstall(bytes calldata) external override {
        delete policy[msg.sender];
        emit Uninstalled(msg.sender);
    }

    function isModuleType(uint256 moduleTypeId) external pure override returns (bool) {
        return moduleTypeId == MODULE_TYPE_EXECUTOR;
    }

    function isInitialized(address account) external view override returns (bool) {
        return policy[account].installed;
    }

    // ------------------------------ Lifeboat flow ------------------------------

    /// @notice Hot key opens a timelocked withdrawal from `account`.
    function requestWithdrawal(address account, address to, uint256 value, bytes calldata data)
        external
        returns (uint256 id)
    {
        Policy memory p = policy[account];
        if (!p.installed) revert NotInstalled();
        if (msg.sender != p.hotKey) revert NotHotKey();
        id = ++count[account];
        uint64 unlockTime = uint64(block.timestamp) + p.timelock;
        _pending[account][id] = Pending(to, value, data, unlockTime, false);
        emit Requested(account, id, to, value, unlockTime);
    }

    /// @notice Strong key cancels a pending withdrawal.
    function veto(address account, uint256 id) external {
        if (msg.sender != policy[account].guardian) revert NotGuardian();
        Pending storage pend = _pending[account][id];
        if (pend.unlockTime == 0) revert NotPending();
        if (pend.vetoed) revert AlreadyVetoed();
        pend.vetoed = true;
        emit Vetoed(account, id);
    }

    /// @notice Anyone may execute after the timelock; the module drives the account.
    function executeWithdrawal(address account, uint256 id) external {
        Pending storage pend = _pending[account][id];
        if (pend.unlockTime == 0) revert NotPending();
        if (pend.vetoed) revert AlreadyVetoed();
        if (block.timestamp < pend.unlockTime) revert TimelockNotElapsed();

        address to = pend.to;
        uint256 value = pend.value;
        bytes memory data = pend.data;
        delete _pending[account][id];
        emit Executed(account, id);

        // ERC-7579 single call: mode 0, executionCalldata = packed(target, value, data)
        IERC7579Account(account).executeFromExecutor(bytes32(0), abi.encodePacked(to, value, data));
    }

    function pending(address account, uint256 id) external view returns (Pending memory) {
        return _pending[account][id];
    }
}
