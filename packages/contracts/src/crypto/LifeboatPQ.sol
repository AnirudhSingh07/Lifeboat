// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title LifeboatPQ
/// @notice keccak-based WOTS+ one-time signatures + XMSS Merkle verification.
/// @dev Byte-for-byte equivalent to the TypeScript signer in packages/pq-signer.
///      The authoritative spec is packages/pq-signer/SPEC.md. Any change here must
///      be mirrored there (and the committed test vectors regenerated).
library LifeboatPQ {
    uint256 internal constant N = 32; // keccak output bytes
    uint256 internal constant W = 16; // Winternitz parameter
    uint256 internal constant LEN1 = 64; // message digits
    uint256 internal constant LEN2 = 3; // checksum digits
    uint256 internal constant LEN = 67; // total WOTS+ chains
    uint8 internal constant DOMAIN_KEY = 0x00;
    uint8 internal constant DOMAIN_BM = 0x01;
    uint256 internal constant MAX_TREE_HEIGHT = 32;

    /// @dev A detached PQ signature. Layout matches SPEC.md §6.
    struct PQSig {
        uint32 leafIndex;
        bytes32[67] sig; // WOTS+ chain values
        bytes32[] authPath; // Merkle siblings, bottom-up
    }

    // ---------------------------------------------------------------------
    // WOTS+ chaining (SPEC §1)
    // ---------------------------------------------------------------------

    function prf(bytes32 pubSeed, uint8 domain, uint8 chainIndex, uint8 hashIndex)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(pubSeed, domain, chainIndex, hashIndex));
    }

    function chainStep(bytes32 x, bytes32 pubSeed, uint8 chainIndex, uint8 hashIndex)
        internal
        pure
        returns (bytes32)
    {
        bytes32 key = prf(pubSeed, DOMAIN_KEY, chainIndex, hashIndex);
        bytes32 bm = prf(pubSeed, DOMAIN_BM, chainIndex, hashIndex);
        return keccak256(abi.encodePacked(key, x ^ bm));
    }

    /// @dev Apply `steps` chain iterations starting at hashIndex = `start`.
    function chain(bytes32 x, bytes32 pubSeed, uint8 chainIndex, uint8 start, uint8 steps)
        internal
        pure
        returns (bytes32)
    {
        bytes32 out = x;
        for (uint8 j = 0; j < steps; j++) {
            out = chainStep(out, pubSeed, chainIndex, start + j);
        }
        return out;
    }

    // ---------------------------------------------------------------------
    // Message encoding (SPEC §2)
    // ---------------------------------------------------------------------

    function messageToDigits(bytes32 digest) internal pure returns (uint8[67] memory d) {
        for (uint256 k = 0; k < N; k++) {
            uint8 b = uint8(digest[k]);
            d[2 * k] = b >> 4;
            d[2 * k + 1] = b & 0x0f;
        }
        uint256 c = 0;
        for (uint256 i = 0; i < LEN1; i++) {
            c += (W - 1 - uint256(d[i]));
        }
        d[LEN1] = uint8((c >> 8) & 0x0f);
        d[LEN1 + 1] = uint8((c >> 4) & 0x0f);
        d[LEN1 + 2] = uint8(c & 0x0f);
    }

    // ---------------------------------------------------------------------
    // Leaf recovery (SPEC §3)
    // ---------------------------------------------------------------------

    /// @dev Recovers the WOTS+ leaf commitment from a signature over `digest`.
    function leafFromSig(bytes32[67] calldata sig, bytes32 pubSeed, bytes32 digest)
        internal
        pure
        returns (bytes32)
    {
        uint8[67] memory d = messageToDigits(digest);
        // buffer = pubSeed ++ pk[0] ++ ... ++ pk[66]
        bytes memory buf = new bytes(32 + LEN * 32);
        assembly {
            mstore(add(buf, 32), pubSeed)
        }
        for (uint256 i = 0; i < LEN; i++) {
            uint8 di = d[i];
            bytes32 pk = chain(sig[i], pubSeed, uint8(i), di, uint8(W - 1 - uint256(di)));
            assembly {
                mstore(add(buf, add(64, mul(i, 32))), pk)
            }
        }
        return keccak256(buf);
    }

    // ---------------------------------------------------------------------
    // Merkle verification (SPEC §4)
    // ---------------------------------------------------------------------

    function verifyMerkle(bytes32 leaf, uint256 leafIndex, bytes32[] calldata authPath, bytes32 root)
        internal
        pure
        returns (bool)
    {
        require(authPath.length <= MAX_TREE_HEIGHT, "authPath too long");
        bytes32 node = leaf;
        uint256 idx = leafIndex;
        for (uint256 lvl = 0; lvl < authPath.length; lvl++) {
            bytes32 sib = authPath[lvl];
            if (idx & 1 == 0) {
                node = keccak256(abi.encodePacked(node, sib));
            } else {
                node = keccak256(abi.encodePacked(sib, node));
            }
            idx >>= 1;
        }
        return node == root;
    }

    // ---------------------------------------------------------------------
    // Full verification
    // ---------------------------------------------------------------------

    /// @notice Verify a PQ signature over `digest` against a committed `(root, pubSeed)`.
    function verify(bytes32 digest, bytes32 root, bytes32 pubSeed, PQSig calldata s)
        internal
        pure
        returns (bool)
    {
        bytes32 leaf = leafFromSig(s.sig, pubSeed, digest);
        return verifyMerkle(leaf, s.leafIndex, s.authPath, root);
    }
}
