/**
 * Lifeboat PQ signature parameters. See SPEC.md — these MUST match the Solidity
 * verifier (packages/contracts/src/crypto).
 */
export const N = 32; // keccak256 output bytes
export const W = 16; // Winternitz parameter
export const LOG_W = 4; // log2(W)
export const LEN1 = 64; // message digits = ceil(8*N / LOG_W)
export const LEN2 = 3; // checksum digits
export const LEN = LEN1 + LEN2; // 67 WOTS+ chains
export const TREE_HEIGHT = 10; // XMSS Merkle height → 1024 one-time keys
export const NUM_LEAVES = 1 << TREE_HEIGHT;

// PRF domain separators
export const DOMAIN_KEY = 0x00;
export const DOMAIN_BM = 0x01;
