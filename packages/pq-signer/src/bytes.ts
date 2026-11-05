import { keccak_256 } from "@noble/hashes/sha3";
import { randomBytes } from "@noble/hashes/utils";

export type Bytes = Uint8Array;

/** keccak256 — matches the EVM opcode (not SHA3-256). */
export function keccak(...parts: Bytes[]): Bytes {
  return keccak_256(concat(...parts));
}

export function concat(...parts: Bytes[]): Bytes {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Fixed-length XOR; inputs must be equal length. */
export function xor(a: Bytes, b: Bytes): Bytes {
  if (a.length !== b.length) throw new Error(`xor length mismatch: ${a.length} vs ${b.length}`);
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

export function equal(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function random32(): Bytes {
  return randomBytes(32);
}

export function u8(n: number): Bytes {
  if (n < 0 || n > 0xff) throw new Error(`u8 out of range: ${n}`);
  return new Uint8Array([n]);
}

export function toHex(b: Bytes): `0x${string}` {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s as `0x${string}`;
}

export function fromHex(hex: string): Bytes {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
