// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LifeboatVault} from "../src/LifeboatVault.sol";
import {LifeboatPQ} from "../src/crypto/LifeboatPQ.sol";
import {IWorldIDGate} from "../src/interfaces/IWorldIDGate.sol";
import {MockWorldIDGate} from "../src/adapters/MockWorldIDGate.sol";
import {PQTestSigner} from "./utils/PQTestSigner.sol";

/// @notice Emergency freeze: a low-power freezer can pause all hot-path outflow (buying time
///         to veto), but can never move funds or lift the freeze. Only a strong key unfreezes.
contract FreezeTest is Test {
    uint8 constant ACTION_EXECUTE = 5;
    uint8 constant HEIGHT = 4;
    uint64 constant TIMELOCK = 1 days;

    LifeboatVault vault;
    PQTestSigner pqs;
    uint256 hotPk;
    address hotKey;
    address freezer = makeAddr("freezer-bot");
    address dest = makeAddr("dest");
    bytes32 masterSeed = keccak256("freeze-master");
    bytes32 pubSeed = keccak256("freeze-pubseed");

    function setUp() public {
        (hotKey, hotPk) = makeAddrAndKey("hot");
        pqs = new PQTestSigner();
        bytes32 root = pqs.rootOf(pqs.buildLeaves(masterSeed, pubSeed, HEIGHT));
        MockWorldIDGate gate = new MockWorldIDGate(true);
        vault = new LifeboatVault(hotKey, root, pubSeed, TIMELOCK, IWorldIDGate(address(gate)));
        vm.deal(address(vault), 100 ether);
        _pqSelf(abi.encodeCall(LifeboatVault.setFreezer, (freezer)), 0);
    }

    function _pqSelf(bytes memory data, uint32 leaf) internal {
        bytes32 paramsHash = keccak256(abi.encode(address(vault), uint256(0), keccak256(data)));
        bytes32 digest = vault.pqDigest(ACTION_EXECUTE, paramsHash, leaf);
        LifeboatPQ.PQSig memory s = pqs.makeSig(masterSeed, pubSeed, HEIGHT, digest, leaf);
        vault.pqExecute(address(vault), 0, data, s);
    }

    function _request(address to, uint256 amount) internal returns (uint256 id) {
        bytes32 digest = vault.requestDigest(to, amount, vault.hotNonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(hotPk, digest);
        id = vault.requestWithdrawal(to, amount, abi.encodePacked(r, s, v));
    }

    function test_freezerCanFreeze_blocksExecute() public {
        uint256 id = _request(dest, 100 ether);
        vm.prank(freezer);
        vault.freeze();
        assertTrue(vault.frozen());
        vm.warp(block.timestamp + TIMELOCK + 1);
        vm.expectRevert(LifeboatVault.VaultFrozen.selector);
        vault.executeWithdrawal(id); // the drain can't complete while frozen
        assertEq(address(vault).balance, 100 ether);
    }

    function test_nonFreezerCannotFreeze() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(LifeboatVault.NotFreezer.selector);
        vault.freeze();
    }

    function test_freezerCannotUnfreeze() public {
        vm.prank(freezer);
        vault.freeze();
        vm.prank(freezer);
        vm.expectRevert(LifeboatVault.NotSelf.selector);
        vault.unfreeze(); // freezer may only freeze
    }

    function test_strongKeyUnfreezes() public {
        vm.prank(freezer);
        vault.freeze();
        _pqSelf(abi.encodeCall(LifeboatVault.unfreeze, ()), 1);
        assertFalse(vault.frozen());
    }

    function test_frozenBlocksInstantPath() public {
        _pqSelf(abi.encodeCall(LifeboatVault.setDailyLimit, (10 ether)), 1);
        vm.prank(freezer);
        vault.freeze();
        // under the limit would normally be instant; while frozen it must be timelocked instead
        uint256 id = _request(dest, 1 ether);
        assertGt(id, 0, "frozen forces timelocked pending, no instant outflow");
        assertEq(address(vault).balance, 100 ether);
    }
}
