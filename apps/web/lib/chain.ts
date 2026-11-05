"use client";
import {
  createPublicClient,
  createWalletClient,
  createTestClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";

/**
 * DEV ONLY. The local Anvil account #0 — it plays BOTH the vault owner and, in the
 * attack demo, the "stolen" everyday ECDSA key. In production the hot key lives in the
 * user's wallet (wagmi/RainbowKit → a viem WalletClient the SDK consumes unchanged);
 * nothing like this private key is ever shipped to a browser.
 */
export const DEV_HOT_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

/** A throwaway "attacker destination" (Anvil account #3). */
export const ATTACKER_DEST = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address;

export const hotAccount = privateKeyToAccount(DEV_HOT_PK);

const transport = http(RPC_URL);
export const publicClient = createPublicClient({ chain: anvil, transport });
export const walletClient = createWalletClient({ account: hotAccount, chain: anvil, transport });
export const testClient = createTestClient({ chain: anvil, mode: "anvil", transport });

/** XMSS height used for the in-browser demo (64 one-time keys — fast to generate). */
export const DEMO_TREE_HEIGHT = 6;
