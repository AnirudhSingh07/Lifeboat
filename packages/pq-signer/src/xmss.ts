import { Bytes, equal, keccak } from "./bytes.js";

/** Index-based Merkle hash. SPEC §4. */
function hashNode(left: Bytes, right: Bytes): Bytes {
  return keccak(left, right);
}

/**
 * A fully-materialized Merkle tree. Height is inferred from the number of leaves,
 * which must be a power of two (production uses 2^TREE_HEIGHT; tests may use fewer).
 * `levels[0]` = leaves, `levels[height]` = [root].
 */
export class MerkleTree {
  readonly levels: Bytes[][];
  readonly height: number;

  constructor(leaves: Bytes[]) {
    const n = leaves.length;
    if (n < 1 || (n & (n - 1)) !== 0) {
      throw new Error(`leaf count must be a power of two, got ${n}`);
    }
    this.height = Math.log2(n);
    this.levels = [leaves];
    for (let level = 0; level < this.height; level++) {
      const prev = this.levels[level]!;
      const next: Bytes[] = [];
      for (let i = 0; i < prev.length; i += 2) {
        next.push(hashNode(prev[i]!, prev[i + 1]!));
      }
      this.levels.push(next);
    }
  }

  get root(): Bytes {
    return this.levels[this.height]![0]!;
  }

  /** Sibling nodes bottom-up for a given leaf. */
  authPath(leafIndex: number): Bytes[] {
    if (leafIndex < 0 || leafIndex >= this.levels[0]!.length) {
      throw new Error("leafIndex out of range");
    }
    const path: Bytes[] = [];
    let idx = leafIndex;
    for (let level = 0; level < this.height; level++) {
      const sibling = idx ^ 1;
      path.push(this.levels[level]![sibling]!);
      idx >>= 1;
    }
    return path;
  }
}

/** Recompute the root from a leaf + auth path. SPEC §4. */
export function merkleRootFromPath(leaf: Bytes, leafIndex: number, authPath: Bytes[]): Bytes {
  let node = leaf;
  let idx = leafIndex;
  for (let level = 0; level < authPath.length; level++) {
    const sib = authPath[level]!;
    node = (idx & 1) === 0 ? hashNode(node, sib) : hashNode(sib, node);
    idx >>= 1;
  }
  return node;
}

export function verifyMerkle(
  leaf: Bytes,
  leafIndex: number,
  authPath: Bytes[],
  root: Bytes,
): boolean {
  return equal(merkleRootFromPath(leaf, leafIndex, authPath), root);
}
