// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LifeboatPQ} from "../../src/crypto/LifeboatPQ.sol";

/// @dev External wrapper so `sig` is delivered as calldata (and gas reflects decoding).
contract PQHarness {
    function verify(bytes32 digest, bytes32 root, bytes32 pubSeed, LifeboatPQ.PQSig calldata s)
        external
        pure
        returns (bool)
    {
        return LifeboatPQ.verify(digest, root, pubSeed, s);
    }
}

abstract contract VectorBase is Test {
    PQHarness internal harness;
    string internal json;
    bytes32 internal root;
    bytes32 internal pubSeed;

    function setUp() public virtual {
        harness = new PQHarness();
        json = vm.readFile("test/vectors/wots_vectors.json");
        root = vm.parseJsonBytes32(json, ".root");
        pubSeed = vm.parseJsonBytes32(json, ".pubSeed");
    }

    function _load(string memory base)
        internal
        view
        returns (bytes32 digest, LifeboatPQ.PQSig memory s)
    {
        digest = vm.parseJsonBytes32(json, string.concat(base, ".digest"));
        s.leafIndex = uint32(vm.parseJsonUint(json, string.concat(base, ".leafIndex")));
        bytes32[] memory sigArr = vm.parseJsonBytes32Array(json, string.concat(base, ".sig"));
        require(sigArr.length == 67, "bad sig length");
        for (uint256 i = 0; i < 67; i++) {
            s.sig[i] = sigArr[i];
        }
        s.authPath = vm.parseJsonBytes32Array(json, string.concat(base, ".authPath"));
    }
}

/// @notice Confirms the Solidity verifier agrees with the TypeScript signer.
contract WOTSVectorsTest is VectorBase {
    function test_good_leaf0() public view {
        (bytes32 digest, LifeboatPQ.PQSig memory s) = _load(".good[0]");
        assertTrue(harness.verify(digest, root, pubSeed, s), "leaf0 should verify");
    }

    function test_good_leaf7() public view {
        (bytes32 digest, LifeboatPQ.PQSig memory s) = _load(".good[1]");
        assertTrue(harness.verify(digest, root, pubSeed, s), "leaf7 should verify");
    }

    function test_good_leafMax() public view {
        (bytes32 digest, LifeboatPQ.PQSig memory s) = _load(".good[2]");
        assertTrue(harness.verify(digest, root, pubSeed, s), "max leaf should verify");
    }

    function test_reject_tamperedSignature() public view {
        (bytes32 digest, LifeboatPQ.PQSig memory s) = _load(".tampered");
        assertFalse(harness.verify(digest, root, pubSeed, s), "tampered sig must fail");
    }

    function test_reject_wrongDigest() public view {
        (, LifeboatPQ.PQSig memory s) = _load(".good[0]");
        bytes32 wrongDigest = keccak256("not the signed message");
        assertFalse(harness.verify(wrongDigest, root, pubSeed, s), "wrong digest must fail");
    }

    function test_reject_wrongLeafIndex() public view {
        (bytes32 digest, LifeboatPQ.PQSig memory s) = _load(".good[0]");
        s.leafIndex = 1; // authPath belongs to leaf 0
        assertFalse(harness.verify(digest, root, pubSeed, s), "wrong leaf index must fail");
    }

    function test_reject_wrongRoot() public view {
        (bytes32 digest, LifeboatPQ.PQSig memory s) = _load(".good[0]");
        assertFalse(
            harness.verify(digest, bytes32(uint256(root) ^ 1), pubSeed, s), "wrong root must fail"
        );
    }
}

/// @notice Reports the on-chain verification gas — the pitch-slide number that
///         must exceed EIP-8141's MAX_VERIFY_GAS (100,000) to require the alt mempool.
contract PQGasTest is VectorBase {
    function test_gas_verify_leaf0() public {
        (bytes32 digest, LifeboatPQ.PQSig memory s) = _load(".good[0]");
        uint256 before = gasleft();
        bool ok = harness.verify(digest, root, pubSeed, s);
        uint256 used = before - gasleft();
        assertTrue(ok);
        emit log_named_uint("PQ verify gas (incl. calldata + external call)", used);
        emit log_named_uint("EIP-8141 MAX_VERIFY_GAS", 100_000);
        assertGt(used, 100_000, "must exceed 100k so the public mempool rejects it");
    }
}
