// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LifeboatVault} from "../src/LifeboatVault.sol";
import {LifeboatPQ} from "../src/crypto/LifeboatPQ.sol";
import {IWorldIDGate} from "../src/interfaces/IWorldIDGate.sol";
import {MockWorldIDGate} from "../src/adapters/MockWorldIDGate.sol";
import {PQTestSigner} from "./utils/PQTestSigner.sol";

/// @notice Risk-based spend policy: allowlisted/under-limit sends are instant, everything
///         else is timelocked + vetoable. Makes the vault a drain-resistant everyday wallet.
contract SpendPolicyTest is Test {
    uint8 constant ACTION_EXECUTE = 5;
    uint8 constant HEIGHT = 4;
    uint64 constant TIMELOCK = 1 days;

    LifeboatVault vault;
    PQTestSigner pqs;

    uint256 hotPk;
    address hotKey;
    address dest = makeAddr("dest");
    bytes32 masterSeed = keccak256("policy-master");
    bytes32 pubSeed = keccak256("policy-pubseed");

    function setUp() public {
        (hotKey, hotPk) = makeAddrAndKey("hot");
        pqs = new PQTestSigner();
        bytes32 root = pqs.rootOf(pqs.buildLeaves(masterSeed, pubSeed, HEIGHT));
        MockWorldIDGate gate = new MockWorldIDGate(true);
        vault = new LifeboatVault(hotKey, root, pubSeed, TIMELOCK, IWorldIDGate(address(gate)));
        vm.deal(address(vault), 100 ether);
    }

    function _ecdsaRequest(address to, uint256 amount) internal view returns (bytes memory) {
        bytes32 digest = vault.requestDigest(to, amount, vault.hotNonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(hotPk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Drive a self-call (policy setter) through the PQ-gated pqExecute path.
    function _pqSelf(bytes memory data, uint32 leaf) internal {
        bytes32 paramsHash = keccak256(abi.encode(address(vault), uint256(0), keccak256(data)));
        bytes32 digest = vault.pqDigest(ACTION_EXECUTE, paramsHash, leaf);
        LifeboatPQ.PQSig memory s = pqs.makeSig(masterSeed, pubSeed, HEIGHT, digest, leaf);
        vault.pqExecute(address(vault), 0, data, s);
    }

    function _request(address to, uint256 amount) internal returns (uint256) {
        return vault.requestWithdrawal(to, amount, _ecdsaRequest(to, amount));
    }

    function test_setters_revertWhenCalledDirectly() public {
        vm.expectRevert(LifeboatVault.NotSelf.selector);
        vault.setDailyLimit(1 ether);
        vm.expectRevert(LifeboatVault.NotSelf.selector);
        vault.setAllowed(dest, true);
    }

    function test_instant_whenAllowlisted() public {
        _pqSelf(abi.encodeCall(LifeboatVault.setAllowed, (dest, true)), 0);
        uint256 balBefore = dest.balance;
        uint256 id = _request(dest, 5 ether);
        assertEq(id, 0, "allowlisted send should be instant (id 0)");
        assertEq(dest.balance, balBefore + 5 ether, "funds moved instantly");
    }

    function test_instant_underDailyLimit_timelocked_over() public {
        _pqSelf(abi.encodeCall(LifeboatVault.setDailyLimit, (10 ether)), 0);
        assertEq(_request(dest, 3 ether), 0, "3 <= 10 instant");
        assertEq(_request(dest, 3 ether), 0, "6 <= 10 instant");
        // 6 + 5 > 10 → timelocked pending
        uint256 id = _request(dest, 5 ether);
        assertGt(id, 0, "over limit should be timelocked");
        (,, uint64 unlockTime,) = vault.pending(id);
        assertEq(unlockTime, uint64(block.timestamp) + TIMELOCK);
    }

    function test_dailyLimit_windowResets() public {
        _pqSelf(abi.encodeCall(LifeboatVault.setDailyLimit, (5 ether)), 0);
        assertEq(_request(dest, 5 ether), 0, "first 5 instant");
        assertGt(_request(dest, 1 ether), 0, "window exhausted -> timelocked");
        vm.warp(block.timestamp + 1 days + 1);
        assertEq(_request(dest, 5 ether), 0, "window reset -> instant again");
    }

    /// @notice The anti-drainer guarantee: a big drain by the hot key is capped to the
    ///         allowance and otherwise timelocked + vetoable.
    function test_bigDrainIsTimelocked() public {
        _pqSelf(abi.encodeCall(LifeboatVault.setDailyLimit, (1 ether)), 0);
        uint256 id = _request(dest, 100 ether); // attacker tries to drain everything
        assertGt(id, 0, "big drain must be timelocked, not instant");
        assertEq(address(vault).balance, 100 ether, "nothing moved yet");
    }
}
