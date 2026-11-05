// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IWorldID
/// @notice Minimal interface for the World ID Router's on-chain proof verification.
///         `verifyProof` reverts if the Semaphore proof is invalid.
interface IWorldID {
    function verifyProof(
        uint256 root,
        uint256 groupId,
        uint256 signalHash,
        uint256 nullifierHash,
        uint256 externalNullifierHash,
        uint256[8] calldata proof
    ) external view;
}
