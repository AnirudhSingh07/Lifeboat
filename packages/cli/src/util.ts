import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { LifeboatSigner, type SerializedKey } from "@lifeboat/pq-signer";

export const DEFAULT_RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
// Anvil account #0 — a public dev key, used as the default local submitter/payer.
export const DEFAULT_PK =
  (process.env.PRIVATE_KEY as Hex) ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export interface Clients {
  chain: Chain;
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
}

/** Build viem clients against `rpc`, discovering the chain id from the node. */
export async function getClients(rpc = DEFAULT_RPC, pk: Hex = DEFAULT_PK): Promise<Clients> {
  const probe = createPublicClient({ transport: http(rpc) });
  const id = await probe.getChainId();
  const chain = defineChain({
    id,
    name: `chain-${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const account = privateKeyToAccount(pk);
  return {
    chain,
    publicClient: createPublicClient({ chain, transport: http(rpc) }),
    walletClient: createWalletClient({ account, chain, transport: http(rpc) }),
    account,
  };
}

// ---- keyfile (holds the PQ master seed; never leaves the owner's device) ----

export function loadSigner(path: string): LifeboatSigner {
  if (!existsSync(path)) throw new Error(`keyfile not found: ${path} (run \`lifeboat keygen\`)`);
  return LifeboatSigner.fromSerialized(JSON.parse(readFileSync(path, "utf8")) as SerializedKey);
}

export function saveSigner(path: string, signer: LifeboatSigner): void {
  writeFileSync(path, JSON.stringify(signer.serialize(), null, 2) + "\n");
}

// ---- deployment record ----

export interface Deployment {
  chainId: number;
  vault: Hex;
  gate: Hex;
  hotKey: Hex;
  timelock: number;
}

export function loadDeployment(path: string): Deployment {
  if (!existsSync(path)) throw new Error(`deployment not found: ${path} (run \`lifeboat deploy\`)`);
  return JSON.parse(readFileSync(path, "utf8")) as Deployment;
}

export function saveDeployment(path: string, d: Deployment): void {
  writeFileSync(path, JSON.stringify(d, null, 2) + "\n");
}

// ---- misc ----

export const eth = (wei: bigint) => `${Number(wei) / 1e18} ETH`;

export function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}
