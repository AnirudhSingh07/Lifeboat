// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IWorldIDGate} from "../interfaces/IWorldIDGate.sol";

/// @title MockWorldIDGate
/// @notice Local/devnet stand-in for the World ID gate. Approves when `shouldPass` is
///         true, otherwise reverts — lets the demo show both the success and failure
///         paths required by the World ID track. Swap for a real IDKit-backed adapter
///         (on-chain World ID Router or server attestation) in production.
contract MockWorldIDGate is IWorldIDGate {
    bool public shouldPass;
    address public owner;

    event GateChecked(address indexed vault, bytes32 context, bool passed);

    error WorldIDCheckFailed();
    error NotOwner();

    constructor(bool _shouldPass) {
        shouldPass = _shouldPass;
        owner = msg.sender;
    }

    function setShouldPass(bool v) external {
        if (msg.sender != owner) revert NotOwner();
        shouldPass = v;
    }

    function check(address vault, bytes32 context, bytes calldata) external override {
        emit GateChecked(vault, context, shouldPass);
        if (!shouldPass) revert WorldIDCheckFailed();
    }
}
