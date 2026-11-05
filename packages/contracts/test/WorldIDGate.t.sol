// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LifeboatVault} from "../src/LifeboatVault.sol";
import {LifeboatPQ} from "../src/crypto/LifeboatPQ.sol";
import {IWorldIDGate} from "../src/interfaces/IWorldIDGate.sol";
import {IWorldID} from "../src/interfaces/IWorldID.sol";
import {WorldIDRouterGate} from "../src/adapters/WorldIDRouterGate.sol";
import {PQTestSigner} from "./utils/PQTestSigner.sol";

/// @dev Stand-in for the World ID Router: reverts when `valid` is false.
contract MockWorldIDRouter is IWorldID {
    bool public valid = true;

    function setValid(bool v) external {
        valid = v;
    }

    function verifyProof(uint256, uint256, uint256, uint256, uint256, uint256[8] calldata)
        external
        view
        override
    {
        require(valid, "invalid world id proof");
    }
}

contract WorldIDGateTest is Test {
    uint8 constant ACTION_ROTATE_ROOT = 4;
    uint8 constant HEIGHT = 4;

    LifeboatVault vault;
    PQTestSigner pqs;
    WorldIDRouterGate gate;
    MockWorldIDRouter router;

    address hotKey = makeAddr("hotKey");
    bytes32 masterSeed = keccak256("wid-test-master");
    bytes32 pubSeed = keccak256("wid-test-pubseed");

    uint256 constant ENROLLED_NULLIFIER = 0xBEEF;
    uint256 constant EXTERNAL_NULLIFIER = 0xABCD;

    function setUp() public {
        pqs = new PQTestSigner();
        bytes32 root = pqs.rootOf(pqs.buildLeaves(masterSeed, pubSeed, HEIGHT));

        router = new MockWorldIDRouter();
        gate = new WorldIDRouterGate(IWorldID(address(router)), 1, EXTERNAL_NULLIFIER, address(this));
        gate.enroll(ENROLLED_NULLIFIER);

        vault = new LifeboatVault(hotKey, root, pubSeed, 1 days, IWorldIDGate(address(gate)));
    }

    function _rotateSig(bytes32 newRoot, bytes32 newPubSeed, uint32 leaf)
        internal
        view
        returns (LifeboatPQ.PQSig memory)
    {
        bytes32 paramsHash = keccak256(abi.encode(newRoot, newPubSeed));
        bytes32 digest = vault.pqDigest(ACTION_ROTATE_ROOT, paramsHash, leaf);
        return pqs.makeSig(masterSeed, pubSeed, HEIGHT, digest, leaf);
    }

    function _proof(uint256 nullifier) internal pure returns (bytes memory) {
        return abi.encode(uint256(0x1234), nullifier, [uint256(0), 0, 0, 0, 0, 0, 0, 0]);
    }

    function test_rotate_succeedsWithValidWorldIDProof() public {
        bytes32 newRoot = keccak256("new-root");
        bytes32 newPubSeed = keccak256("new-pubseed");
        LifeboatPQ.PQSig memory s = _rotateSig(newRoot, newPubSeed, 0);
        vault.rotatePQRoot(newRoot, newPubSeed, s, _proof(ENROLLED_NULLIFIER));
        assertEq(vault.pqRoot(), newRoot);
        assertEq(vault.pqEpoch(), 1);
    }

    function test_rotate_revertsWhenProofInvalid() public {
        router.setValid(false);
        bytes32 newRoot = keccak256("new-root");
        bytes32 newPubSeed = keccak256("new-pubseed");
        LifeboatPQ.PQSig memory s = _rotateSig(newRoot, newPubSeed, 0);
        vm.expectRevert(bytes("invalid world id proof"));
        vault.rotatePQRoot(newRoot, newPubSeed, s, _proof(ENROLLED_NULLIFIER));
    }

    function test_rotate_revertsForDifferentHuman() public {
        bytes32 newRoot = keccak256("new-root");
        bytes32 newPubSeed = keccak256("new-pubseed");
        LifeboatPQ.PQSig memory s = _rotateSig(newRoot, newPubSeed, 0);
        vm.expectRevert(WorldIDRouterGate.NotTheEnrolledHuman.selector);
        vault.rotatePQRoot(newRoot, newPubSeed, s, _proof(0xD1FF));
    }

    function test_enroll_onlyOnce() public {
        vm.expectRevert(WorldIDRouterGate.AlreadyEnrolled.selector);
        gate.enroll(0x1111);
    }
}
