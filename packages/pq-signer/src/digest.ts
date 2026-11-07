import { Bytes, fromHex, keccak } from "./bytes.js";

/** Action type tags — MUST match LifeboatVault.sol. SPEC §5. */
export const ActionType = {
  VETO: 1,
  INSTANT_MOVE: 2,
  REVOKE_HOT: 3,
  ROTATE_ROOT: 4,
  EXECUTE: 5,
} as const;
export type ActionType = (typeof ActionType)[keyof typeof ActionType];

function u256be(n: bigint): Bytes {
  if (n < 0n || n > (1n << 256n) - 1n) throw new Error("uint256 out of range");
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function addressTo32(addr: string): Bytes {
  const b = fromHex(addr);
  if (b.length !== 20) throw new Error("address must be 20 bytes");
  const out = new Uint8Array(32);
  out.set(b, 12); // left-padded
  return out;
}

/**
 * The 32-byte digest the vault signs. Equivalent to:
 *   keccak256(abi.encode(bytes32 domain, uint256 chainId, address vault,
 *                        uint8 actionType, bytes32 actionParamsHash, uint32 leafIndex))
 * All fields are static, so abi.encode == tightly concatenated 32-byte words.
 */
export function actionDigest(args: {
  domain: string; // bytes32
  chainId: bigint | number;
  vault: string; // address
  actionType: ActionType;
  actionParamsHash: string; // bytes32
  leafIndex: number;
}): Bytes {
  return keccak(
    fromHex(args.domain),
    u256be(BigInt(args.chainId)),
    addressTo32(args.vault),
    u256be(BigInt(args.actionType)),
    fromHex(args.actionParamsHash),
    u256be(BigInt(args.leafIndex)),
  );
}
