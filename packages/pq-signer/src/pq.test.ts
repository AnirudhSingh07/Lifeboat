import { describe, expect, it } from "vitest";
import { LEN, LEN1, LEN2, W } from "./params.js";
import { equal, keccak, random32 } from "./bytes.js";
import { messageToDigits, wotsKeygen, wotsLeafFromSecret, wotsLeafFromSig, wotsSign } from "./wots.js";
import { MerkleTree, merkleRootFromPath, verifyMerkle } from "./xmss.js";
import { LifeboatSigner } from "./signer.js";

const pubSeed = keccak(new TextEncoder().encode("test-pubseed"));

describe("messageToDigits", () => {
  it("produces LEN digits with a correct checksum", () => {
    const digest = random32();
    const d = messageToDigits(digest);
    expect(d.length).toBe(LEN);
    for (const x of d) expect(x).toBeGreaterThanOrEqual(0), expect(x).toBeLessThan(W);

    let c = 0;
    for (let i = 0; i < LEN1; i++) c += W - 1 - d[i]!;
    const csum = ((d[LEN1]! << 8) | (d[LEN1 + 1]! << 4) | d[LEN1 + 2]!);
    expect(csum).toBe(c);
  });

  it("splits each byte high-nibble then low-nibble", () => {
    const digest = new Uint8Array(32).fill(0xab);
    const d = messageToDigits(digest);
    expect(d[0]).toBe(0xa);
    expect(d[1]).toBe(0xb);
  });

  it("checksum fits in LEN2 nibbles even at the extreme (all-zero digest)", () => {
    const d = messageToDigits(new Uint8Array(32)); // all nibbles 0 → max checksum 64*15=960
    const csum = (d[LEN1]! << 8) | (d[LEN1 + 1]! << 4) | d[LEN1 + 2]!;
    expect(csum).toBe(LEN1 * (W - 1));
    expect(LEN2).toBe(3);
  });
});

describe("WOTS+ sign / recover", () => {
  it("recovers the correct leaf from a valid signature", () => {
    const sk = wotsKeygen();
    const leaf = wotsLeafFromSecret(sk, pubSeed);
    const digest = random32();
    const sig = wotsSign(sk, pubSeed, digest);
    expect(equal(wotsLeafFromSig(sig, pubSeed, digest), leaf)).toBe(true);
  });

  it("rejects a tampered signature (wrong leaf)", () => {
    const sk = wotsKeygen();
    const leaf = wotsLeafFromSecret(sk, pubSeed);
    const digest = random32();
    const sig = wotsSign(sk, pubSeed, digest);
    sig[0] = random32(); // corrupt one chain
    expect(equal(wotsLeafFromSig(sig, pubSeed, digest), leaf)).toBe(false);
  });

  it("rejects the signature under a different message", () => {
    const sk = wotsKeygen();
    const leaf = wotsLeafFromSecret(sk, pubSeed);
    const sig = wotsSign(sk, pubSeed, random32());
    expect(equal(wotsLeafFromSig(sig, pubSeed, random32()), leaf)).toBe(false);
  });
});

describe("Merkle tree", () => {
  it("round-trips auth paths for every leaf of a small tree", () => {
    const leaves = Array.from({ length: 8 }, (_, i) => keccak(new Uint8Array([i])));
    const tree = new MerkleTree(leaves);
    expect(tree.height).toBe(3);
    for (let i = 0; i < 8; i++) {
      const path = tree.authPath(i);
      expect(verifyMerkle(leaves[i]!, i, path, tree.root)).toBe(true);
    }
  });

  it("fails verification for the wrong leaf index", () => {
    const leaves = Array.from({ length: 4 }, (_, i) => keccak(new Uint8Array([i])));
    const tree = new MerkleTree(leaves);
    const path = tree.authPath(1);
    expect(verifyMerkle(leaves[1]!, 2, path, tree.root)).toBe(false);
    expect(equal(merkleRootFromPath(leaves[1]!, 1, path), tree.root)).toBe(true);
  });
});

describe("LifeboatSigner end-to-end", () => {
  it("signs with the next leaf and verifies to the root", () => {
    const signer = LifeboatSigner.generate(4); // 16 leaves for speed
    const digest = random32();
    const s = signer.sign(digest);
    expect(s.leafIndex).toBe(0);
    expect(s.sig.length).toBe(LEN);
    expect(s.authPath.length).toBe(4);

    const leaf = wotsLeafFromSig(s.sig, signer.pubSeed, digest);
    expect(verifyMerkle(leaf, s.leafIndex, s.authPath, signer.root)).toBe(true);
    expect(signer.nextLeafIndex).toBe(1);
  });

  it("is deterministic across serialize / restore (same root)", () => {
    const signer = LifeboatSigner.generate(4);
    signer.sign(random32());
    const restored = LifeboatSigner.fromSerialized(signer.serialize());
    expect(equal(restored.root, signer.root)).toBe(true);
    expect(restored.nextLeafIndex).toBe(1);
  });

  it("throws when the tree is exhausted", () => {
    const signer = LifeboatSigner.generate(1); // 2 leaves
    signer.sign(random32());
    signer.sign(random32());
    expect(() => signer.sign(random32())).toThrow(/exhausted/);
  });

  it("different leaves produce independent valid signatures", () => {
    const signer = LifeboatSigner.generate(3);
    const d1 = random32();
    const d2 = random32();
    const s1 = signer.signWithLeaf(d1, 5);
    const s2 = signer.signWithLeaf(d2, 6);
    expect(verifyMerkle(wotsLeafFromSig(s1.sig, signer.pubSeed, d1), 5, s1.authPath, signer.root)).toBe(true);
    expect(verifyMerkle(wotsLeafFromSig(s2.sig, signer.pubSeed, d2), 6, s2.authPath, signer.root)).toBe(true);
  });
});
