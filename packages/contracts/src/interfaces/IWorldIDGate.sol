// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IWorldIDGate
/// @notice Human-recovery factor for the most sensitive action (PQ root rotation).
///         The vault stays agnostic: on devnet this is a mock; in production it wraps
///         the World ID Router's on-chain proof check (or a server attestation).
/// @dev World ID is NOT post-quantum. It is only an additional human factor layered on
///      top of the PQ signature — never the sole security layer. See README.
interface IWorldIDGate {
    /// @notice Reverts if `proof` is not a valid World ID proof for the human enrolled
    ///         to `vault`, or if the nullifier does not match the enrolled one.
    /// @param vault   the Lifeboat vault requesting the check
    /// @param context action-specific context bound into the proof (signal/external nullifier)
    /// @param proof   opaque IDKit proof payload
    function check(address vault, bytes32 context, bytes calldata proof) external;
}
