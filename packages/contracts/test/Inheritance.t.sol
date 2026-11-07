// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LifeboatVault} from "../src/LifeboatVault.sol";
import {LifeboatPQ} from "../src/crypto/LifeboatPQ.sol";
import {IWorldIDGate} from "../src/interfaces/IWorldIDGate.sol";
import {MockWorldIDGate} from "../src/adapters/MockWorldIDGate.sol";
import {PQTestSigner} from "./utils/PQTestSigner.sol";

/// @notice Inheritance / dead-man's switch: after prolonged inactivity the beneficiary can
///         sweep the vault, but any owner heartbeat during the grace window cancels it.
contract InheritanceTest is Test {
    uint8 constant ACTION_EXECUTE = 5;
    uint8 constant HEIGHT = 4;
    uint64 constant TIMELOCK = 1 days; // doubles as the inheritance grace window
    uint256 constant INACTIVITY = 30 days;

    LifeboatVault vault;
    PQTestSigner pqs;

    address hotKey;
    uint256 hotPk;
    address beneficiary = makeAddr("beneficiary");
    bytes32 masterSeed = keccak256("inherit-master");
    bytes32 pubSeed = keccak256("inherit-pubseed");

    function setUp() public {
        (hotKey, hotPk) = makeAddrAndKey("hot");
        pqs = new PQTestSigner();
        bytes32 root = pqs.rootOf(pqs.buildLeaves(masterSeed, pubSeed, HEIGHT));
        MockWorldIDGate gate = new MockWorldIDGate(true);
        vault = new LifeboatVault(hotKey, root, pubSeed, TIMELOCK, IWorldIDGate(address(gate)));
        vm.deal(address(vault), 100 ether);
        _pqSelf(abi.encodeCall(LifeboatVault.setBeneficiary, (beneficiary)), 0);
        _pqSelf(abi.encodeCall(LifeboatVault.setInactivityPeriod, (INACTIVITY)), 1);
    }

    function _pqSelf(bytes memory data, uint32 leaf) internal {
        bytes32 paramsHash = keccak256(abi.encode(address(vault), uint256(0), keccak256(data)));
        bytes32 digest = vault.pqDigest(ACTION_EXECUTE, paramsHash, leaf);
        LifeboatPQ.PQSig memory s = pqs.makeSig(masterSeed, pubSeed, HEIGHT, digest, leaf);
        vault.pqExecute(address(vault), 0, data, s);
    }

    function test_fullClaimFlow() public {
        vm.warp(block.timestamp + INACTIVITY + 1);
        vm.prank(beneficiary);
        vault.startInheritanceClaim();
        vm.warp(block.timestamp + TIMELOCK + 1);
        uint256 balBefore = beneficiary.balance;
        vm.prank(beneficiary);
        vault.claimInheritance();
        assertEq(beneficiary.balance, balBefore + 100 ether, "beneficiary swept the vault");
        assertEq(address(vault).balance, 0);
    }

    function test_cannotStartWhileActive() public {
        vm.prank(beneficiary);
        vm.expectRevert(LifeboatVault.StillActive.selector);
        vault.startInheritanceClaim();
    }

    function test_heartbeatCancelsClaim() public {
        vm.warp(block.timestamp + INACTIVITY + 1);
        vm.prank(beneficiary);
        vault.startInheritanceClaim();

        // owner comes back and heartbeats → claim cancelled
        vm.prank(hotKey);
        vault.heartbeat();
        assertEq(vault.inheritanceUnlock(), 0, "claim cancelled by heartbeat");

        vm.warp(block.timestamp + TIMELOCK + 1);
        vm.prank(beneficiary);
        vm.expectRevert(LifeboatVault.ClaimNotStarted.selector);
        vault.claimInheritance();
    }

    function test_onlyBeneficiaryCanStart() public {
        vm.warp(block.timestamp + INACTIVITY + 1);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(LifeboatVault.NotBeneficiary.selector);
        vault.startInheritanceClaim();
    }

    function test_cannotClaimBeforeGrace() public {
        vm.warp(block.timestamp + INACTIVITY + 1);
        vm.prank(beneficiary);
        vault.startInheritanceClaim();
        vm.prank(beneficiary);
        vm.expectRevert(LifeboatVault.GraceNotElapsed.selector);
        vault.claimInheritance();
    }

    function test_disabledByDefault() public {
        // a vault with no beneficiary configured rejects claims
        bytes32 root = pqs.rootOf(pqs.buildLeaves(masterSeed, pubSeed, HEIGHT));
        MockWorldIDGate gate = new MockWorldIDGate(true);
        LifeboatVault bare =
            new LifeboatVault(hotKey, root, pubSeed, TIMELOCK, IWorldIDGate(address(gate)));
        vm.warp(block.timestamp + INACTIVITY + 1);
        vm.prank(beneficiary);
        vm.expectRevert(LifeboatVault.InheritanceDisabled.selector);
        bare.startInheritanceClaim();
    }
}
