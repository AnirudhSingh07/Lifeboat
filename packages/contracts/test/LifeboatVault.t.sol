// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LifeboatVault} from "../src/LifeboatVault.sol";
import {LifeboatPQ} from "../src/crypto/LifeboatPQ.sol";
import {IWorldIDGate} from "../src/interfaces/IWorldIDGate.sol";
import {MockWorldIDGate} from "../src/adapters/MockWorldIDGate.sol";
import {PQTestSigner} from "./utils/PQTestSigner.sol";

contract LifeboatVaultTest is Test {
    // action tags (mirror LifeboatVault internal constants)
    uint8 constant ACTION_VETO = 1;
    uint8 constant ACTION_INSTANT_MOVE = 2;
    uint8 constant ACTION_REVOKE_HOT = 3;
    uint8 constant ACTION_ROTATE_ROOT = 4;

    uint8 constant HEIGHT = 4; // 16 one-time keys — fast in tests
    uint64 constant TIMELOCK = 1 days;

    LifeboatVault vault;
    PQTestSigner pqs;
    MockWorldIDGate gate;

    uint256 hotPk;
    address hotKey;
    address attacker = makeAddr("attacker");
    address owner = makeAddr("owner");

    bytes32 masterSeed = keccak256("lifeboat-test-master");
    bytes32 pubSeed = keccak256("lifeboat-test-pubseed");
    bytes32 root;

    function setUp() public {
        (hotKey, hotPk) = makeAddrAndKey("hotKey");
        pqs = new PQTestSigner();
        root = pqs.rootOf(pqs.buildLeaves(masterSeed, pubSeed, HEIGHT));
        gate = new MockWorldIDGate(true);
        vault = new LifeboatVault(hotKey, root, pubSeed, TIMELOCK, IWorldIDGate(address(gate)));
        vm.deal(address(vault), 100 ether);
    }

    // ----------------------------- helpers --------------------------------

    function _ecdsaRequest(address to, uint256 amount) internal view returns (bytes memory) {
        bytes32 digest = vault.requestDigest(to, amount, vault.hotNonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(hotPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _pqSig(uint8 action, bytes32 paramsHash, uint32 leaf)
        internal
        view
        returns (LifeboatPQ.PQSig memory)
    {
        bytes32 digest = vault.pqDigest(action, paramsHash, leaf);
        return pqs.makeSig(masterSeed, pubSeed, HEIGHT, digest, leaf);
    }

    function _request(address to, uint256 amount) internal returns (uint256 id) {
        id = vault.requestWithdrawal(to, amount, _ecdsaRequest(to, amount));
    }

    // ----------------------------- hot key --------------------------------

    function test_requestWithdrawal_entersPending() public {
        uint256 id = _request(attacker, 10 ether);
        (address to, uint256 amount, uint64 unlockTime, bool vetoed) = vault.pending(id);
        assertEq(to, attacker);
        assertEq(amount, 10 ether);
        assertEq(unlockTime, uint64(block.timestamp) + TIMELOCK);
        assertFalse(vetoed);
    }

    function test_requestWithdrawal_directFromHotKey() public {
        // a real wallet (the hot key) can call directly, no relayed signature
        vm.prank(hotKey);
        uint256 id = vault.requestWithdrawal(owner, 3 ether, "");
        (address to, uint256 amount,,) = vault.pending(id);
        assertEq(to, owner);
        assertEq(amount, 3 ether);
    }

    function test_requestWithdrawal_rejectsWrongSigner() public {
        (, uint256 wrongPk) = makeAddrAndKey("not-the-hot-key");
        bytes32 digest = vault.requestDigest(attacker, 1 ether, vault.hotNonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPk, digest);
        vm.expectRevert(LifeboatVault.BadECDSASignature.selector);
        vault.requestWithdrawal(attacker, 1 ether, abi.encodePacked(r, s, v));
    }

    function test_executeWithdrawal_afterTimelock() public {
        uint256 id = _request(owner, 5 ether);
        vm.warp(block.timestamp + TIMELOCK);
        uint256 balBefore = owner.balance;
        vault.executeWithdrawal(id);
        assertEq(owner.balance, balBefore + 5 ether);
    }

    function test_executeWithdrawal_revertsBeforeTimelock() public {
        uint256 id = _request(owner, 5 ether);
        vm.expectRevert(LifeboatVault.TimelockNotElapsed.selector);
        vault.executeWithdrawal(id);
    }

    // --------------------------- the hero flow -----------------------------

    /// @notice The attack story: attacker holds the ECDSA key, starts a full drain,
    ///         the PQ key vetoes it, the funds stay put.
    function test_attackVetoScenario() public {
        // 1. attacker (who stole the ECDSA key) tries to drain the whole vault
        uint256 id = _request(attacker, 100 ether);
        (,, uint64 unlockTime,) = vault.pending(id);
        assertGt(unlockTime, block.timestamp, "must be timelocked, not instant");

        // 2. owner vetoes with the post-quantum key
        LifeboatPQ.PQSig memory s = _pqSig(ACTION_VETO, keccak256(abi.encode(id)), 0);
        vm.expectEmit(true, false, false, true, address(vault));
        emit LifeboatVault.WithdrawalVetoed(id, 0);
        vault.veto(id, s);

        // 3. even after the timelock, execution fails — funds never move
        vm.warp(block.timestamp + TIMELOCK + 1);
        vm.expectRevert(LifeboatVault.AlreadyVetoed.selector);
        vault.executeWithdrawal(id);
        assertEq(address(vault).balance, 100 ether, "funds intact");

        // 4. owner cuts the cord: the stolen key is now powerless
        LifeboatPQ.PQSig memory revokeSig = _pqSig(ACTION_REVOKE_HOT, bytes32(0), 1);
        vault.revokeHotKey(revokeSig);
        assertEq(vault.hotKey(), address(0));
        // compute the ECDSA sig BEFORE expectRevert (the helper makes view calls)
        bytes memory sig = _ecdsaRequest(attacker, 1 ether);
        vm.expectRevert(LifeboatVault.HotKeyRevokedError.selector);
        vault.requestWithdrawal(attacker, 1 ether, sig);
    }

    function test_instantMove_movesFundsImmediately() public {
        LifeboatPQ.PQSig memory s =
            _pqSig(ACTION_INSTANT_MOVE, keccak256(abi.encode(owner, 7 ether)), 0);
        uint256 balBefore = owner.balance;
        vault.instantMove(owner, 7 ether, s);
        assertEq(owner.balance, balBefore + 7 ether);
    }

    // -------------------------- one-time keys ------------------------------

    function test_pq_rejectsReusedLeaf() public {
        uint256 id = _request(attacker, 1 ether);
        LifeboatPQ.PQSig memory s = _pqSig(ACTION_VETO, keccak256(abi.encode(id)), 0);
        vault.veto(id, s);

        // reuse leaf 0 for a different action
        LifeboatPQ.PQSig memory s2 =
            _pqSig(ACTION_INSTANT_MOVE, keccak256(abi.encode(owner, 1 ether)), 0);
        vm.expectRevert(LifeboatVault.LeafAlreadyUsed.selector);
        vault.instantMove(owner, 1 ether, s2);
    }

    function test_pq_rejectsBadSignature() public {
        uint256 id = _request(attacker, 1 ether);
        LifeboatPQ.PQSig memory s = _pqSig(ACTION_VETO, keccak256(abi.encode(id)), 0);
        s.sig[0] = bytes32(uint256(s.sig[0]) ^ 1); // corrupt one chain
        vm.expectRevert(LifeboatVault.BadPQSignature.selector);
        vault.veto(id, s);
    }

    function test_pq_rejectsWrongAction() public {
        // a signature authorizing INSTANT_MOVE cannot be replayed as a VETO
        uint256 id = _request(attacker, 1 ether);
        LifeboatPQ.PQSig memory s =
            _pqSig(ACTION_INSTANT_MOVE, keccak256(abi.encode(owner, 1 ether)), 0);
        vm.expectRevert(LifeboatVault.BadPQSignature.selector);
        vault.veto(id, s);
    }

    // ----------------------------- rotation --------------------------------

    function test_rotatePQRoot_succeedsWithWorldID() public {
        bytes32 newRoot = keccak256("new-root");
        bytes32 newPubSeed = keccak256("new-pubseed");
        LifeboatPQ.PQSig memory s =
            _pqSig(ACTION_ROTATE_ROOT, keccak256(abi.encode(newRoot, newPubSeed)), 0);
        vault.rotatePQRoot(newRoot, newPubSeed, s, hex"");
        assertEq(vault.pqRoot(), newRoot);
        assertEq(vault.pqPubSeed(), newPubSeed);
        assertEq(vault.pqEpoch(), 1);
    }

    function test_rotatePQRoot_failsWhenWorldIDFails() public {
        gate.setShouldPass(false);
        bytes32 newRoot = keccak256("new-root");
        bytes32 newPubSeed = keccak256("new-pubseed");
        LifeboatPQ.PQSig memory s =
            _pqSig(ACTION_ROTATE_ROOT, keccak256(abi.encode(newRoot, newPubSeed)), 0);
        vm.expectRevert(MockWorldIDGate.WorldIDCheckFailed.selector);
        vault.rotatePQRoot(newRoot, newPubSeed, s, hex"");
        assertEq(vault.pqEpoch(), 0, "rotation must not take effect");
    }

    function test_leafUsage_resetsAcrossEpochs() public {
        // use leaf 0 in epoch 0 (revoke), then rotate, then leaf 0 usable again
        LifeboatPQ.PQSig memory revokeSig = _pqSig(ACTION_REVOKE_HOT, bytes32(0), 0);
        vault.revokeHotKey(revokeSig);
        assertTrue(vault.isLeafUsed(0, 0));

        bytes32 newRoot = pqs.rootOf(pqs.buildLeaves(masterSeed, pubSeed, HEIGHT)); // same tree, new epoch
        LifeboatPQ.PQSig memory rot =
            _pqSig(ACTION_ROTATE_ROOT, keccak256(abi.encode(newRoot, pubSeed)), 1);
        vault.rotatePQRoot(newRoot, pubSeed, rot, hex"");

        assertEq(vault.pqEpoch(), 1);
        assertFalse(vault.isLeafUsed(1, 0), "leaf 0 fresh in new epoch");
    }
}
