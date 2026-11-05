// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IWorldIDGate} from "../interfaces/IWorldIDGate.sol";
import {IWorldID} from "../interfaces/IWorldID.sol";

/// @title WorldIDRouterGate
/// @notice Production on-chain implementation of IWorldIDGate. Verifies a World ID proof
///         via the World ID Router and enforces that it is the SAME unique human who
///         enrolled at vault setup (matched by nullifier hash for a fixed action).
/// @dev Deploy on a chain where the World ID Router is available. For local devnet,
///      LifeboatVault uses MockWorldIDGate instead (driven by a real server-side
///      verifyCloudProof result). World ID is a human-recovery factor, never the
///      quantum-safety layer — rotation still requires the PQ signature.
contract WorldIDRouterGate is IWorldIDGate {
    IWorldID public immutable worldId;
    uint256 public immutable groupId; // 1 = Orb
    uint256 public immutable externalNullifierHash; // hash(app_id, action)

    address public owner;
    uint256 public enrolledNullifier; // the human allowed to rotate; 0 until enrolled

    event Enrolled(uint256 nullifierHash);

    error NotOwner();
    error AlreadyEnrolled();
    error NotEnrolled();
    error NotTheEnrolledHuman();

    constructor(IWorldID _worldId, uint256 _groupId, uint256 _externalNullifierHash, address _owner) {
        worldId = _worldId;
        groupId = _groupId;
        externalNullifierHash = _externalNullifierHash;
        owner = _owner;
    }

    /// @notice Record the enrolled human's nullifier (once), after a successful setup proof.
    function enroll(uint256 nullifierHash) external {
        if (msg.sender != owner) revert NotOwner();
        if (enrolledNullifier != 0) revert AlreadyEnrolled();
        enrolledNullifier = nullifierHash;
        emit Enrolled(nullifierHash);
    }

    /// @inheritdoc IWorldIDGate
    /// @dev `proof` is abi.encode(uint256 root, uint256 nullifierHash, uint256[8] proof).
    ///      `context` is the vault-provided signal (e.g. keccak(newRoot, newPubSeed)).
    function check(address, bytes32 context, bytes calldata proof) external view override {
        if (enrolledNullifier == 0) revert NotEnrolled();
        (uint256 root, uint256 nullifierHash, uint256[8] memory zk) =
            abi.decode(proof, (uint256, uint256, uint256[8]));

        // same unique human: the nullifier for this fixed action is deterministic per person
        if (nullifierHash != enrolledNullifier) revert NotTheEnrolledHuman();

        // reverts if the proof is invalid
        worldId.verifyProof(
            root, groupId, hashToField(context), nullifierHash, externalNullifierHash, zk
        );
    }

    /// @dev World ID's ByteHasher: keccak256 of the signal, right-shifted to fit the field.
    function hashToField(bytes32 value) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(value))) >> 8;
    }
}
