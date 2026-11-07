// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LifeboatVault} from "../src/LifeboatVault.sol";
import {LifeboatPQ} from "../src/crypto/LifeboatPQ.sol";
import {IWorldIDGate} from "../src/interfaces/IWorldIDGate.sol";
import {MockWorldIDGate} from "../src/adapters/MockWorldIDGate.sol";
import {PQTestSigner} from "./utils/PQTestSigner.sol";

/// @notice Guardian (M-of-N ECDSA) path: a Ledger (1-of-1) or friends (M-of-N) can veto and
///         move funds alongside the PQ key — the "useful today" strong authority.
contract GuardianTest is Test {
    uint8 constant ACTION_VETO = 1;
    uint8 constant ACTION_EXECUTE = 5;
    uint8 constant HEIGHT = 4;
    uint64 constant TIMELOCK = 1 days;

    LifeboatVault vault;
    PQTestSigner pqs;

    uint256 hotPk;
    address hotKey;
    address dest = makeAddr("dest");

    bytes32 masterSeed = keccak256("guardian-master");
    bytes32 pubSeed = keccak256("guardian-pubseed");

    uint256[] guardianPks;

    function setUp() public {
        (hotKey, hotPk) = makeAddrAndKey("hot");
        pqs = new PQTestSigner();
        bytes32 root = pqs.rootOf(pqs.buildLeaves(masterSeed, pubSeed, HEIGHT));
        MockWorldIDGate gate = new MockWorldIDGate(true);
        vault = new LifeboatVault(hotKey, root, pubSeed, TIMELOCK, IWorldIDGate(address(gate)));
        vm.deal(address(vault), 100 ether);

        (, uint256 g1) = makeAddrAndKey("guardian1");
        (, uint256 g2) = makeAddrAndKey("guardian2");
        (, uint256 g3) = makeAddrAndKey("guardian3");
        guardianPks = [g1, g2, g3];

        // configure 2-of-3 guardians via the PQ path (leaves 0..3)
        _pqSelf(abi.encodeCall(LifeboatVault.addGuardian, (vm.addr(g1))), 0);
        _pqSelf(abi.encodeCall(LifeboatVault.addGuardian, (vm.addr(g2))), 1);
        _pqSelf(abi.encodeCall(LifeboatVault.addGuardian, (vm.addr(g3))), 2);
        _pqSelf(abi.encodeCall(LifeboatVault.setGuardianThreshold, (2)), 3);
    }

    function _pqSelf(bytes memory data, uint32 leaf) internal {
        bytes32 paramsHash = keccak256(abi.encode(address(vault), uint256(0), keccak256(data)));
        bytes32 digest = vault.pqDigest(ACTION_EXECUTE, paramsHash, leaf);
        LifeboatPQ.PQSig memory s = pqs.makeSig(masterSeed, pubSeed, HEIGHT, digest, leaf);
        vault.pqExecute(address(vault), 0, data, s);
    }

    function _ecdsaRequest(address to, uint256 amount) internal view returns (bytes memory) {
        bytes32 digest = vault.requestDigest(to, amount, vault.hotNonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(hotPk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Sign `digest` with each pk and return the sigs ordered by signer address ascending.
    function _sortedSigs(bytes32 digest, uint256[] memory pks) internal pure returns (bytes[] memory) {
        uint256 n = pks.length;
        for (uint256 i = 0; i < n; i++) {
            for (uint256 j = i + 1; j < n; j++) {
                if (vm.addr(pks[j]) < vm.addr(pks[i])) {
                    (pks[i], pks[j]) = (pks[j], pks[i]);
                }
            }
        }
        bytes[] memory sigs = new bytes[](n);
        for (uint256 i = 0; i < n; i++) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(pks[i], digest);
            sigs[i] = abi.encodePacked(r, s, v);
        }
        return sigs;
    }

    function _twoGuardians() internal view returns (uint256[] memory pks) {
        pks = new uint256[](2);
        pks[0] = guardianPks[0];
        pks[1] = guardianPks[1];
    }

    function test_setup_guardiansConfigured() public view {
        assertEq(vault.guardianCount(), 3);
        assertEq(vault.guardianThreshold(), 2);
    }

    function test_guardianVeto_withQuorum() public {
        uint256 id = vault.requestWithdrawal(dest, 100 ether, _ecdsaRequest(dest, 100 ether));
        bytes32 digest = vault.guardianDigest(ACTION_VETO, keccak256(abi.encode(id)));
        vault.guardianVeto(id, _sortedSigs(digest, _twoGuardians()));
        (,,, bool vetoed) = vault.pending(id);
        assertTrue(vetoed, "guardian quorum vetoed the drain");
    }

    function test_guardianExecute_movesFunds() public {
        bytes memory data = "";
        bytes32 paramsHash = keccak256(abi.encode(dest, uint256(7 ether), keccak256(data)));
        bytes32 digest = vault.guardianDigest(ACTION_EXECUTE, paramsHash);
        uint256 balBefore = dest.balance;
        vault.guardianExecute(dest, 7 ether, data, _sortedSigs(digest, _twoGuardians()));
        assertEq(dest.balance, balBefore + 7 ether);
    }

    function test_guardianExecute_canRevokeHotKey() public {
        bytes memory data = abi.encodeCall(LifeboatVault.setHotKey, (address(0)));
        bytes32 paramsHash = keccak256(abi.encode(address(vault), uint256(0), keccak256(data)));
        bytes32 digest = vault.guardianDigest(ACTION_EXECUTE, paramsHash);
        vault.guardianExecute(address(vault), 0, data, _sortedSigs(digest, _twoGuardians()));
        assertEq(vault.hotKey(), address(0), "guardians cut the cord");
    }

    function test_guardianQuorum_insufficient() public {
        uint256 id = vault.requestWithdrawal(dest, 100 ether, _ecdsaRequest(dest, 100 ether));
        uint256[] memory one = new uint256[](1);
        one[0] = guardianPks[0];
        bytes32 digest = vault.guardianDigest(ACTION_VETO, keccak256(abi.encode(id)));
        vm.expectRevert(LifeboatVault.BadGuardianQuorum.selector);
        vault.guardianVeto(id, _sortedSigs(digest, one));
    }

    function test_guardianQuorum_rejectsNonGuardian() public {
        uint256 id = vault.requestWithdrawal(dest, 100 ether, _ecdsaRequest(dest, 100 ether));
        (, uint256 strangerPk) = makeAddrAndKey("stranger");
        uint256[] memory pks = new uint256[](2);
        pks[0] = guardianPks[0];
        pks[1] = strangerPk;
        bytes32 digest = vault.guardianDigest(ACTION_VETO, keccak256(abi.encode(id)));
        vm.expectRevert(LifeboatVault.BadGuardianQuorum.selector);
        vault.guardianVeto(id, _sortedSigs(digest, pks));
    }

    function test_guardian_replayProtected() public {
        bytes memory data = "";
        bytes32 paramsHash = keccak256(abi.encode(dest, uint256(1 ether), keccak256(data)));
        bytes32 digest = vault.guardianDigest(ACTION_EXECUTE, paramsHash);
        bytes[] memory sigs = _sortedSigs(digest, _twoGuardians());
        vault.guardianExecute(dest, 1 ether, data, sigs);
        // nonce advanced → same sigs no longer verify
        vm.expectRevert(LifeboatVault.BadGuardianQuorum.selector);
        vault.guardianExecute(dest, 1 ether, data, sigs);
    }
}
