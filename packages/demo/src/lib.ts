import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { LifeboatSigner, toHex } from "@lifeboat/pq-signer";
import { LifeboatClient, deployMockWorldIDGate, deployLifeboatVault } from "@lifeboat/sdk";

export const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";

// Anvil default accounts.
export const ANVIL_ACCT0_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
export const ANVIL_ACCT2 = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;

const transport = http(RPC_URL);
export const publicClient = createPublicClient({ chain: anvil, transport });
export const testClient = createTestClient({ chain: anvil, mode: "anvil", transport });

/** The everyday ECDSA "hot key" — the one a quantum attacker would recover. */
export const hotAccount = privateKeyToAccount(ANVIL_ACCT0_PK);
export const walletClient = createWalletClient({
  account: hotAccount,
  chain: anvil,
  transport,
});

export interface Deployment {
  vault: LifeboatClient;
  gate: Address;
  signer: LifeboatSigner;
}

/** Generate a PQ tree, deploy the gate + vault, and fund it. */
export async function setupVault(opts?: {
  height?: number;
  timelockSeconds?: bigint;
  fundEther?: string;
}): Promise<Deployment> {
  const height = opts?.height ?? 8;
  const timelockSeconds = opts?.timelockSeconds ?? 86_400n; // 1 day
  const fundEther = opts?.fundEther ?? "100";

  console.log(`  generating XMSS tree (height ${height} → ${1 << height} one-time keys)…`);
  const signer = LifeboatSigner.generate(height);

  const gate = await deployMockWorldIDGate(walletClient, publicClient, hotAccount, true);
  const vaultAddr = await deployLifeboatVault(walletClient, publicClient, hotAccount, {
    hotKey: hotAccount.address,
    pqRoot: toHex(signer.root),
    pqPubSeed: toHex(signer.pubSeed),
    timelockSeconds,
    worldIdGate: gate,
  });

  // Fund the vault.
  const fundHash = await walletClient.sendTransaction({
    account: hotAccount,
    chain: anvil,
    to: vaultAddr,
    value: parseEther(fundEther),
  });
  await publicClient.waitForTransactionReceipt({ hash: fundHash });

  return { vault: new LifeboatClient(vaultAddr, publicClient, walletClient), gate, signer };
}

export async function wait(hash: Hex) {
  return publicClient.waitForTransactionReceipt({ hash });
}

export const fmtEth = (wei: bigint) => `${Number(wei) / 1e18} ETH`;
