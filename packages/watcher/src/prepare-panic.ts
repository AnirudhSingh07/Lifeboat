/**
 * Produce a pre-signed "panic freeze": a revokeHotKey PQ signature the watcher can
 * broadcast without holding your key. Run this on your own device; only the resulting
 * panic.json (a signature, never a secret) goes to the watcher.
 *
 * It reserves the LAST one-time leaf so it never collides with normal signing.
 *
 * Env: RPC_URL, VAULT_ADDRESS, KEYFILE (serialized LifeboatSigner), [PANIC_FILE=panic.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, type Address } from "viem";
import { anvil } from "viem/chains";
import { LifeboatSigner, fromHex } from "@lifeboat/pq-signer";
import { ActionType, LifeboatClient, revokeParamsHash, toContractSig } from "@lifeboat/sdk";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const VAULT = process.env.VAULT_ADDRESS as Address;
const KEYFILE = process.env.KEYFILE;
const PANIC_FILE = process.env.PANIC_FILE ?? "panic.json";

if (!VAULT || !KEYFILE) {
  console.error("Set VAULT_ADDRESS and KEYFILE.");
  process.exit(1);
}

async function main() {
  const signer = LifeboatSigner.fromSerialized(JSON.parse(readFileSync(KEYFILE, "utf8")));
  const leaf = signer.numLeaves - 1; // reserve the last leaf for panic
  const publicClient = createPublicClient({ chain: anvil, transport: http(RPC_URL) });
  const vault = new LifeboatClient(VAULT, publicClient);

  const digest = await vault.pqDigest(ActionType.REVOKE_HOT, revokeParamsHash, leaf);
  const pqSig = signer.signWithLeaf(fromHex(digest), leaf);
  writeFileSync(PANIC_FILE, JSON.stringify(toContractSig(pqSig), null, 2) + "\n");
  console.log(`wrote pre-signed panic freeze (revokeHotKey, leaf #${leaf}) → ${PANIC_FILE}`);
  console.log("This signature can only disable the hot key; it can never move funds.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
