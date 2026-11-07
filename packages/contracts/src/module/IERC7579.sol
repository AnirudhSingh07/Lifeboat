// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Minimal ERC-7579 surface used by the Lifeboat executor module.
uint256 constant MODULE_TYPE_EXECUTOR = 2;

/// @notice An ERC-7579 account lets an installed executor module act on its behalf.
interface IERC7579Account {
    /// @param mode encodes call-type/exec-type; Lifeboat uses a single `call`.
    /// @param executionCalldata for a single call: abi.encodePacked(target, value, data).
    function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata)
        external
        payable
        returns (bytes[] memory returnData);
}

/// @notice ERC-7579 module lifecycle. `onInstall`/`onUninstall` run with the account as
///         msg.sender, so a module keeps per-account configuration.
interface IERC7579Module {
    function onInstall(bytes calldata data) external;
    function onUninstall(bytes calldata data) external;
    function isModuleType(uint256 moduleTypeId) external view returns (bool);
    function isInitialized(address account) external view returns (bool);
}
