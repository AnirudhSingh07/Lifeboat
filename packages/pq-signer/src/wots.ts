import { DOMAIN_BM, DOMAIN_KEY, LEN, LEN1, LEN2, N, W } from "./params.js";
import { Bytes, concat, keccak, random32, u8, xor } from "./bytes.js";

/**
 * WOTS+ chaining. See SPEC.md §1.
 *
 * PRF(domain, chainIndex, hashIndex) = keccak256(pubSeed ‖ domain ‖ chainIndex ‖ hashIndex)
 * chainStep(x) = keccak256( PRF(0) ‖ (x XOR PRF(1)) )
 */
function prf(pubSeed: Bytes, domain: number, chainIndex: number, hashIndex: number): Bytes {
  return keccak(pubSeed, u8(domain), u8(chainIndex), u8(hashIndex));
}

function chainStep(x: Bytes, pubSeed: Bytes, chainIndex: number, hashIndex: number): Bytes {
  const key = prf(pubSeed, DOMAIN_KEY, chainIndex, hashIndex);
  const bm = prf(pubSeed, DOMAIN_BM, chainIndex, hashIndex);
  return keccak(key, xor(x, bm));
}

/** Apply `steps` chain iterations starting at hashIndex=`start`. */
export function chain(
  x: Bytes,
  pubSeed: Bytes,
  chainIndex: number,
  start: number,
  steps: number,
): Bytes {
  let out = x;
  for (let j = 0; j < steps; j++) {
    out = chainStep(out, pubSeed, chainIndex, start + j);
  }
  return out;
}

/** 32-byte digest → base-w digit vector d[0..LEN-1] (message digits ‖ checksum). SPEC §2. */
export function messageToDigits(digest: Bytes): number[] {
  if (digest.length !== N) throw new Error(`digest must be ${N} bytes`);
  const d = new Array<number>(LEN);
  // message digits: high nibble then low nibble of each byte (MSB-first)
  for (let k = 0; k < N; k++) {
    d[2 * k] = digest[k]! >> 4;
    d[2 * k + 1] = digest[k]! & 0x0f;
  }
  // checksum
  let c = 0;
  for (let i = 0; i < LEN1; i++) c += W - 1 - d[i]!;
  // 3 base-16 digits, MSB-first
  d[LEN1] = (c >> 8) & 0x0f;
  d[LEN1 + 1] = (c >> 4) & 0x0f;
  d[LEN1 + 2] = c & 0x0f;
  if (LEN2 !== 3) throw new Error("checksum encoding assumes LEN2 == 3");
  return d;
}

/** Fresh WOTS+ secret key: LEN random 32-byte chains. */
export function wotsKeygen(): Bytes[] {
  const sk = new Array<Bytes>(LEN);
  for (let i = 0; i < LEN; i++) sk[i] = random32();
  return sk;
}

/** WOTS+ public chain-ends pk[i] = chain(sk[i], 0, w-1). */
export function wotsPublicChains(sk: Bytes[], pubSeed: Bytes): Bytes[] {
  const pk = new Array<Bytes>(LEN);
  for (let i = 0; i < LEN; i++) pk[i] = chain(sk[i]!, pubSeed, i, 0, W - 1);
  return pk;
}

/** Leaf = keccak256(pubSeed ‖ pk[0] ‖ … ‖ pk[LEN-1]). SPEC §3. */
export function wotsLeaf(pk: Bytes[], pubSeed: Bytes): Bytes {
  return keccak(pubSeed, concat(...pk));
}

/** Convenience: compute the leaf directly from the secret key. */
export function wotsLeafFromSecret(sk: Bytes[], pubSeed: Bytes): Bytes {
  return wotsLeaf(wotsPublicChains(sk, pubSeed), pubSeed);
}

/** WOTS+ signature for a digest: sig[i] = chain(sk[i], 0, d[i]). */
export function wotsSign(sk: Bytes[], pubSeed: Bytes, digest: Bytes): Bytes[] {
  const d = messageToDigits(digest);
  const sig = new Array<Bytes>(LEN);
  for (let i = 0; i < LEN; i++) sig[i] = chain(sk[i]!, pubSeed, i, 0, d[i]!);
  return sig;
}

/**
 * Recover the leaf from a signature: pk'[i] = chain(sig[i], d[i], w-1-d[i]).
 * Verifier compares the returned leaf against the Merkle root.
 */
export function wotsLeafFromSig(sig: Bytes[], pubSeed: Bytes, digest: Bytes): Bytes {
  const d = messageToDigits(digest);
  const pk = new Array<Bytes>(LEN);
  for (let i = 0; i < LEN; i++) pk[i] = chain(sig[i]!, pubSeed, i, d[i]!, W - 1 - d[i]!);
  return wotsLeaf(pk, pubSeed);
}
