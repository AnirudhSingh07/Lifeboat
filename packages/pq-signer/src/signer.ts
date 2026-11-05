import { LEN, TREE_HEIGHT } from "./params.js";
import { Bytes, concat, fromHex, keccak, random32, toHex, u8 } from "./bytes.js";
import { wotsLeafFromSecret, wotsSign } from "./wots.js";
import { MerkleTree } from "./xmss.js";

const SK_LABEL = new TextEncoder().encode("LB-SK"); // domain for secret-key derivation

function u32be(n: number): Bytes {
  if (n < 0 || n > 0xffffffff) throw new Error(`u32 out of range: ${n}`);
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

/** A detached PQ signature, ABI-aligned with the on-chain verifier. SPEC §6. */
export interface PQSignature {
  leafIndex: number;
  sig: Bytes[]; // LEN (67) chain values
  authPath: Bytes[]; // tree-height (10) siblings, bottom-up
}

export interface SerializedKey {
  version: 1;
  height: number;
  masterSeed: `0x${string}`; // derives every one-time secret key
  pubSeed: `0x${string}`; // public, used in chaining + leaf hashing
  root: `0x${string}`;
  nextLeafIndex: number;
}

/**
 * Holds the XMSS tree for a Lifeboat vault and produces one-time WOTS+ signatures.
 * Secrets are derived deterministically from `masterSeed`, so persisted state is
 * just two 32-byte seeds + a leaf counter. Keys never leave this object.
 */
export class LifeboatSigner {
  readonly masterSeed: Bytes;
  readonly pubSeed: Bytes;
  readonly height: number;
  readonly numLeaves: number;
  private tree: MerkleTree;
  private _nextLeafIndex: number;

  private constructor(masterSeed: Bytes, pubSeed: Bytes, height: number, nextLeafIndex = 0) {
    if (masterSeed.length !== 32 || pubSeed.length !== 32) {
      throw new Error("seeds must be 32 bytes");
    }
    this.masterSeed = masterSeed;
    this.pubSeed = pubSeed;
    this.height = height;
    this.numLeaves = 1 << height;
    this._nextLeafIndex = nextLeafIndex;
    this.tree = new MerkleTree(this.buildLeaves());
  }

  /** Create a brand-new tree from fresh randomness. */
  static generate(height: number = TREE_HEIGHT): LifeboatSigner {
    return new LifeboatSigner(random32(), random32(), height);
  }

  /** Reconstruct from persisted state (masterSeed stays on-device). */
  static fromSerialized(s: SerializedKey): LifeboatSigner {
    return new LifeboatSigner(
      fromHex(s.masterSeed),
      fromHex(s.pubSeed),
      s.height,
      s.nextLeafIndex,
    );
  }

  /** Derive secret chain j of leaf `leafIndex`. */
  private secret(leafIndex: number, chain: number): Bytes {
    return keccak(this.masterSeed, SK_LABEL, u32be(leafIndex), u8(chain));
  }

  private secretKey(leafIndex: number): Bytes[] {
    const sk = new Array<Bytes>(LEN);
    for (let i = 0; i < LEN; i++) sk[i] = this.secret(leafIndex, i);
    return sk;
  }

  private buildLeaves(): Bytes[] {
    const leaves = new Array<Bytes>(this.numLeaves);
    for (let leaf = 0; leaf < this.numLeaves; leaf++) {
      leaves[leaf] = wotsLeafFromSecret(this.secretKey(leaf), this.pubSeed);
    }
    return leaves;
  }

  get root(): Bytes {
    return this.tree.root;
  }

  get nextLeafIndex(): number {
    return this._nextLeafIndex;
  }

  get remaining(): number {
    return this.numLeaves - this._nextLeafIndex;
  }

  /** Sign a 32-byte digest with an explicit one-time leaf (does not advance the counter). */
  signWithLeaf(digest: Bytes, leafIndex: number): PQSignature {
    if (leafIndex < 0 || leafIndex >= this.numLeaves) throw new Error("leafIndex out of range");
    const sig = wotsSign(this.secretKey(leafIndex), this.pubSeed, digest);
    const authPath = this.tree.authPath(leafIndex);
    return { leafIndex, sig, authPath };
  }

  /** Sign using the next unused leaf and advance the counter. One-time use. */
  sign(digest: Bytes): PQSignature {
    if (this._nextLeafIndex >= this.numLeaves) {
      throw new Error("XMSS tree exhausted — rotate the PQ root");
    }
    const out = this.signWithLeaf(digest, this._nextLeafIndex);
    this._nextLeafIndex += 1;
    return out;
  }

  serialize(): SerializedKey {
    return {
      version: 1,
      height: this.height,
      masterSeed: toHex(this.masterSeed),
      pubSeed: toHex(this.pubSeed),
      root: toHex(this.root),
      nextLeafIndex: this._nextLeafIndex,
    };
  }
}

/** Flatten a signature's chain values / auth path for ABI encoding or hex transport. */
export function sigToHex(sig: PQSignature): {
  leafIndex: number;
  sig: `0x${string}`[];
  authPath: `0x${string}`[];
} {
  return {
    leafIndex: sig.leafIndex,
    sig: sig.sig.map(toHex),
    authPath: sig.authPath.map(toHex),
  };
}

export { concat };
