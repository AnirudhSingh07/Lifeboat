import { type Address, type Hex, type PublicClient, type WalletClient, type Account } from "viem";
import {
  lifeboatVaultAbi,
  lifeboatVaultBytecode,
  mockWorldIDGateAbi,
  mockWorldIDGateBytecode,
} from "./abis.js";

async function deployAndWait(
  wallet: WalletClient,
  publicClient: PublicClient,
  account: Account,
  abi: readonly unknown[],
  bytecode: Hex,
  args: readonly unknown[],
): Promise<Address> {
  const hash = await wallet.deployContract({
    chain: wallet.chain,
    account,
    abi: abi as never,
    bytecode,
    args: args as never,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("deploy: no contract address in receipt");
  return receipt.contractAddress;
}

/** Deploy a MockWorldIDGate (devnet human-recovery stand-in). */
export function deployMockWorldIDGate(
  wallet: WalletClient,
  publicClient: PublicClient,
  account: Account,
  shouldPass = true,
): Promise<Address> {
  return deployAndWait(wallet, publicClient, account, mockWorldIDGateAbi, mockWorldIDGateBytecode, [
    shouldPass,
  ]);
}

export interface DeployVaultArgs {
  hotKey: Address;
  pqRoot: Hex;
  pqPubSeed: Hex;
  timelockSeconds: bigint;
  worldIdGate: Address;
}

export function deployLifeboatVault(
  wallet: WalletClient,
  publicClient: PublicClient,
  account: Account,
  args: DeployVaultArgs,
): Promise<Address> {
  return deployAndWait(wallet, publicClient, account, lifeboatVaultAbi, lifeboatVaultBytecode, [
    args.hotKey,
    args.pqRoot,
    args.pqPubSeed,
    args.timelockSeconds,
    args.worldIdGate,
  ]);
}
