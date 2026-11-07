// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LifeboatVault} from "../src/LifeboatVault.sol";
import {LifeboatPQ} from "../src/crypto/LifeboatPQ.sol";
import {IWorldIDGate} from "../src/interfaces/IWorldIDGate.sol";
import {MockWorldIDGate} from "../src/adapters/MockWorldIDGate.sol";
import {EACRegistryMock} from "../src/ens/EACRegistryMock.sol";
import {PQTestSigner} from "./utils/PQTestSigner.sol";

/// @notice A quantum attacker with the ECDSA key must not be able to repoint `you.eth`.
///         The name's critical ENSv2 role (ROLE_SET_RESOLVER) is held by the Lifeboat vault,
///         which only acts under a post-quantum signature via pqExecute.
contract ENSProtectionTest is Test {
    uint8 constant ACTION_EXECUTE = 5;
    uint8 constant HEIGHT = 4;

    LifeboatVault vault;
    PQTestSigner pqs;
    EACRegistryMock registry;

    address hotKey = makeAddr("hotKey"); // the everyday ECDSA key (attacker steals this)
    bytes32 masterSeed = keccak256("ens-test-master");
    bytes32 pubSeed = keccak256("ens-test-pubseed");

    bytes32 labelhash = keccak256("lifeboat"); // "lifeboat.eth"
    address resolver0 = address(0xA11CE);
    address goodResolver = address(0xB0B);
    address evilResolver = address(0xBAD);

    function setUp() public {
        pqs = new PQTestSigner();
        bytes32 root = pqs.rootOf(pqs.buildLeaves(masterSeed, pubSeed, HEIGHT));
        MockWorldIDGate gate = new MockWorldIDGate(true);
        vault = new LifeboatVault(hotKey, root, pubSeed, 1 days, IWorldIDGate(address(gate)));

        registry = new EACRegistryMock();
        // Register the name and put the CRITICAL resolver role under the vault (PQ-controlled).
        registry.register(labelhash, registry.ROLE_SET_RESOLVER(), address(vault), resolver0);
    }

    function _pqExecSig(address target, uint256 value, bytes memory data, uint32 leaf)
        internal
        view
        returns (LifeboatPQ.PQSig memory)
    {
        bytes32 paramsHash = keccak256(abi.encode(target, value, keccak256(data)));
        bytes32 digest = vault.pqDigest(ACTION_EXECUTE, paramsHash, leaf);
        return pqs.makeSig(masterSeed, pubSeed, HEIGHT, digest, leaf);
    }

    function test_vaultHoldsResolverRole_attackerDoesNot() public view {
        uint256 res = registry.resourceOf(labelhash);
        assertTrue(registry.hasRoles(res, registry.ROLE_SET_RESOLVER(), address(vault)));
        assertFalse(registry.hasRoles(res, registry.ROLE_SET_RESOLVER(), hotKey));
    }

    function test_attackerCannotRepointResolver() public {
        // The attacker holds the stolen ECDSA key, but it has no ENS role.
        vm.prank(hotKey);
        vm.expectRevert(
            abi.encodeWithSelector(EACRegistryMock.Unauthorized.selector, registry.ROLE_SET_RESOLVER())
        );
        registry.setResolver(labelhash, evilResolver);
        assertEq(registry.getResolver(labelhash), resolver0, "resolver must be unchanged");
    }

    function test_ownerRepointsResolverViaPQ() public {
        bytes memory data =
            abi.encodeCall(EACRegistryMock.setResolver, (labelhash, goodResolver));
        LifeboatPQ.PQSig memory s = _pqExecSig(address(registry), 0, data, 0);

        vault.pqExecute(address(registry), 0, data, s);
        assertEq(registry.getResolver(labelhash), goodResolver, "PQ owner can repoint");
    }

    function test_pqExecuteRejectsBadSignature() public {
        bytes memory data = abi.encodeCall(EACRegistryMock.setResolver, (labelhash, goodResolver));
        LifeboatPQ.PQSig memory s = _pqExecSig(address(registry), 0, data, 0);
        s.sig[3] = bytes32(uint256(s.sig[3]) ^ 1); // corrupt one chain
        vm.expectRevert(LifeboatVault.BadPQSignature.selector);
        vault.pqExecute(address(registry), 0, data, s);
    }

    function test_pqExecuteRevertsWhenTargetReverts() public {
        // A PQ-authorized call whose target reverts should bubble up as ExecFailed.
        bytes memory data = abi.encodeCall(EACRegistryMock.setResolver, (labelhash, goodResolver));
        // vault has the role, so this specific call succeeds; instead target a bad selector
        bytes memory badData = abi.encodeWithSignature("doesNotExist()");
        LifeboatPQ.PQSig memory s = _pqExecSig(address(registry), 0, badData, 0);
        vm.expectRevert();
        vault.pqExecute(address(registry), 0, badData, s);
        data; // silence unused
    }
}
