// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LifeboatPQ} from "../../src/crypto/LifeboatPQ.sol";

/// @title PQTestSigner
/// @notice A Solidity reimplementation of the TypeScript WOTS+/XMSS signer, used only
///         in tests so the vault can be exercised with signatures that bind the live
///         vault address + chainid + leaf index. Derivation matches
///         packages/pq-signer/src/signer.ts byte-for-byte. (The TS↔Solidity *verify*
///         equivalence is proved separately by the committed vectors test.)
contract PQTestSigner {
    uint256 internal constant LEN = 67;
    uint256 internal constant W = 16;

    /// @dev sk[i] = keccak256(masterSeed ‖ "LB-SK" ‖ leafIndex(4 BE) ‖ i)
    function deriveSK(bytes32 masterSeed, uint32 leafIndex)
        public
        pure
        returns (bytes32[67] memory sk)
    {
        for (uint8 i = 0; i < LEN; i++) {
            sk[i] = keccak256(abi.encodePacked(masterSeed, bytes("LB-SK"), leafIndex, i));
        }
    }

    function leafOf(bytes32 masterSeed, bytes32 pubSeed, uint32 leafIndex)
        public
        pure
        returns (bytes32)
    {
        bytes32[67] memory sk = deriveSK(masterSeed, leafIndex);
        bytes memory buf = new bytes(32 + LEN * 32);
        assembly {
            mstore(add(buf, 32), pubSeed)
        }
        for (uint256 i = 0; i < LEN; i++) {
            bytes32 pk = LifeboatPQ.chain(sk[i], pubSeed, uint8(i), 0, uint8(W - 1));
            assembly {
                mstore(add(buf, add(64, mul(i, 32))), pk)
            }
        }
        return keccak256(buf);
    }

    function buildLeaves(bytes32 masterSeed, bytes32 pubSeed, uint8 height)
        public
        pure
        returns (bytes32[] memory leaves)
    {
        uint256 n = uint256(1) << height;
        leaves = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            leaves[i] = leafOf(masterSeed, pubSeed, uint32(i));
        }
    }

    function rootOf(bytes32[] memory leaves) public pure returns (bytes32) {
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            bytes32[] memory next = new bytes32[](level.length / 2);
            for (uint256 i = 0; i < next.length; i++) {
                next[i] = keccak256(abi.encodePacked(level[2 * i], level[2 * i + 1]));
            }
            level = next;
        }
        return level[0];
    }

    function authPathOf(bytes32[] memory leaves, uint32 leafIndex, uint8 height)
        public
        pure
        returns (bytes32[] memory path)
    {
        path = new bytes32[](height);
        bytes32[] memory level = leaves;
        uint256 idx = leafIndex;
        for (uint8 lvl = 0; lvl < height; lvl++) {
            path[lvl] = level[idx ^ 1];
            bytes32[] memory next = new bytes32[](level.length / 2);
            for (uint256 i = 0; i < next.length; i++) {
                next[i] = keccak256(abi.encodePacked(level[2 * i], level[2 * i + 1]));
            }
            level = next;
            idx >>= 1;
        }
    }

    /// @dev sig[i] = chain(sk[i], 0, d[i])
    function signDigest(bytes32 masterSeed, bytes32 pubSeed, bytes32 digest, uint32 leafIndex)
        public
        pure
        returns (bytes32[67] memory sig)
    {
        bytes32[67] memory sk = deriveSK(masterSeed, leafIndex);
        uint8[67] memory d = LifeboatPQ.messageToDigits(digest);
        for (uint256 i = 0; i < LEN; i++) {
            sig[i] = LifeboatPQ.chain(sk[i], pubSeed, uint8(i), 0, d[i]);
        }
    }

    /// @notice Produce a complete PQSig (sig + auth path) for `digest` at `leafIndex`.
    function makeSig(
        bytes32 masterSeed,
        bytes32 pubSeed,
        uint8 height,
        bytes32 digest,
        uint32 leafIndex
    ) public pure returns (LifeboatPQ.PQSig memory s) {
        s.leafIndex = leafIndex;
        s.sig = signDigest(masterSeed, pubSeed, digest, leafIndex);
        s.authPath = authPathOf(buildLeaves(masterSeed, pubSeed, height), leafIndex, height);
    }
}
