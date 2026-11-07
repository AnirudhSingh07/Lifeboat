import type { Address } from "viem";

/**
 * Live-mode config. Set these in apps/web/.env.local to point the DApp at a real
 * deployed vault instead of the in-browser local demo:
 *   NEXT_PUBLIC_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
 *   NEXT_PUBLIC_CHAIN_ID=11155111
 *   NEXT_PUBLIC_VAULT_ADDRESS=0x...   (from `lifeboat deploy`)
 */
export const LIVE_CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 11155111); // Sepolia
export const LIVE_RPC =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
export const LIVE_VAULT = (process.env.NEXT_PUBLIC_VAULT_ADDRESS as Address | undefined) ?? undefined;
export const LOCAL_RPC = "http://127.0.0.1:8545";
