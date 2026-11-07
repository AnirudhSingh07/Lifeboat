import { encodeAbiParameters, keccak256, zeroHash, type Address, type Hex } from "viem";
import { toHex, type PQSignature } from "@lifeboat/pq-signer";

/** Action tags — mirror LifeboatVault.sol / pq-signer digest.ts. */
export const ActionType = {
  VETO: 1,
  INSTANT_MOVE: 2,
  REVOKE_HOT: 3,
  ROTATE_ROOT: 4,
  EXECUTE: 5,
} as const;
export type ActionType = (typeof ActionType)[keyof typeof ActionType];

// paramsHash values, matching the vault's keccak256(abi.encode(...)).
export function vetoParamsHash(id: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint256" }], [id]));
}

export function instantMoveParamsHash(to: Address, amount: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [to, amount]));
}

export const revokeParamsHash: Hex = zeroHash;

export function rotateParamsHash(newRoot: Hex, newPubSeed: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [newRoot, newPubSeed]));
}

export function executeParamsHash(target: Address, value: bigint, data: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "bytes32" }],
      [target, value, keccak256(data)],
    ),
  );
}

/** On-chain PQSig tuple shape. */
export interface ContractPQSig {
  leafIndex: number;
  sig: readonly Hex[]; // length 67
  authPath: readonly Hex[];
}

export function toContractSig(s: PQSignature): ContractPQSig {
  return {
    leafIndex: s.leafIndex,
    sig: s.sig.map(toHex),
    authPath: s.authPath.map(toHex),
  };
}
