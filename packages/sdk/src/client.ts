import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
} from "viem";
import { LifeboatSigner, fromHex } from "@lifeboat/pq-signer";
import { lifeboatVaultAbi } from "./abis.js";
import {
  ActionType,
  instantMoveParamsHash,
  revokeParamsHash,
  rotateParamsHash,
  toContractSig,
  vetoParamsHash,
} from "./paramHash.js";

export interface VaultState {
  hotKey: Address;
  pqRoot: Hex;
  pqPubSeed: Hex;
  timelock: bigint;
  pqEpoch: number;
  hotNonce: bigint;
  withdrawalCount: bigint;
  balance: bigint;
}

export interface PendingWithdrawal {
  id: bigint;
  to: Address;
  amount: bigint;
  unlockTime: bigint;
  vetoed: boolean;
  exists: boolean;
}

/**
 * High-level client for a Lifeboat vault. Reads are via a PublicClient; writes need a
 * WalletClient. PQ actions take a LifeboatSigner (keys stay in the signer object).
 */
export class LifeboatClient {
  constructor(
    public readonly address: Address,
    public readonly publicClient: PublicClient,
    public readonly walletClient?: WalletClient,
  ) {}

  private get account(): Account {
    const a = this.walletClient?.account;
    if (!a) throw new Error("LifeboatClient: a WalletClient with an account is required for writes");
    return a;
  }

  private read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.publicClient.readContract({
      address: this.address,
      abi: lifeboatVaultAbi,
      functionName: functionName as never,
      args: args as never,
    }) as Promise<T>;
  }

  // --------------------------------- reads ---------------------------------

  async getState(): Promise<VaultState> {
    const [hotKey, pqRoot, pqPubSeed, timelock, pqEpoch, hotNonce, withdrawalCount, balance] =
      await Promise.all([
        this.read<Address>("hotKey"),
        this.read<Hex>("pqRoot"),
        this.read<Hex>("pqPubSeed"),
        this.read<bigint>("timelock"),
        this.read<number>("pqEpoch"),
        this.read<bigint>("hotNonce"),
        this.read<bigint>("withdrawalCount"),
        this.publicClient.getBalance({ address: this.address }),
      ]);
    return { hotKey, pqRoot, pqPubSeed, timelock, pqEpoch, hotNonce, withdrawalCount, balance };
  }

  async getPending(id: bigint): Promise<PendingWithdrawal> {
    const [to, amount, unlockTime, vetoed] = await this.read<
      [Address, bigint, bigint, boolean]
    >("pending", [id]);
    return { id, to, amount, unlockTime, vetoed, exists: unlockTime !== 0n };
  }

  /** All pending withdrawals (ids 1..withdrawalCount). */
  async listPending(): Promise<PendingWithdrawal[]> {
    const count = await this.read<bigint>("withdrawalCount");
    const out: PendingWithdrawal[] = [];
    for (let i = 1n; i <= count; i++) out.push(await this.getPending(i));
    return out.filter((p) => p.exists);
  }

  requestDigest(to: Address, amount: bigint, nonce: bigint): Promise<Hex> {
    return this.read<Hex>("requestDigest", [to, amount, nonce]);
  }

  pqDigest(action: ActionType, paramsHash: Hex, leafIndex: number): Promise<Hex> {
    return this.read<Hex>("pqDigest", [action, paramsHash, leafIndex]);
  }

  // ----------------------------- hot-key writes -----------------------------

  /** Start a timelocked withdrawal using an ECDSA signature from the hot key. */
  async requestWithdrawal(to: Address, amount: bigint, ecdsaSig: Hex): Promise<Hex> {
    return this.walletClient!.writeContract({
      chain: this.walletClient!.chain,
      account: this.account,
      address: this.address,
      abi: lifeboatVaultAbi,
      functionName: "requestWithdrawal",
      args: [to, amount, ecdsaSig],
    });
  }

  async executeWithdrawal(id: bigint): Promise<Hex> {
    return this.walletClient!.writeContract({
      chain: this.walletClient!.chain,
      account: this.account,
      address: this.address,
      abi: lifeboatVaultAbi,
      functionName: "executeWithdrawal",
      args: [id],
    });
  }

  // ------------------------------- PQ writes --------------------------------

  /**
   * Sign `action`+`paramsHash` with the next one-time leaf and submit. Advances the
   * signer's leaf counter. Returns the leaf used and the tx hash.
   */
  private async submitPQ(
    action: ActionType,
    paramsHash: Hex,
    signer: LifeboatSigner,
    send: (sig: ReturnType<typeof toContractSig>) => Promise<Hex>,
  ): Promise<{ leafIndex: number; hash: Hex }> {
    const leafIndex = signer.nextLeafIndex;
    const digest = await this.pqDigest(action, paramsHash, leafIndex);
    const pqSig = signer.sign(fromHex(digest)); // signs at leafIndex, advances counter
    const hash = await send(toContractSig(pqSig));
    return { leafIndex, hash };
  }

  veto(id: bigint, signer: LifeboatSigner) {
    return this.submitPQ(ActionType.VETO, vetoParamsHash(id), signer, (sig) =>
      this.walletClient!.writeContract({
        chain: this.walletClient!.chain,
        account: this.account,
        address: this.address,
        abi: lifeboatVaultAbi,
        functionName: "veto",
        args: [id, sig as never],
      }),
    );
  }

  instantMove(to: Address, amount: bigint, signer: LifeboatSigner) {
    return this.submitPQ(ActionType.INSTANT_MOVE, instantMoveParamsHash(to, amount), signer, (sig) =>
      this.walletClient!.writeContract({
        chain: this.walletClient!.chain,
        account: this.account,
        address: this.address,
        abi: lifeboatVaultAbi,
        functionName: "instantMove",
        args: [to, amount, sig as never],
      }),
    );
  }

  revokeHotKey(signer: LifeboatSigner) {
    return this.submitPQ(ActionType.REVOKE_HOT, revokeParamsHash, signer, (sig) =>
      this.walletClient!.writeContract({
        chain: this.walletClient!.chain,
        account: this.account,
        address: this.address,
        abi: lifeboatVaultAbi,
        functionName: "revokeHotKey",
        args: [sig as never],
      }),
    );
  }

  rotatePQRoot(newRoot: Hex, newPubSeed: Hex, signer: LifeboatSigner, worldIdProof: Hex = "0x") {
    return this.submitPQ(ActionType.ROTATE_ROOT, rotateParamsHash(newRoot, newPubSeed), signer, (sig) =>
      this.walletClient!.writeContract({
        chain: this.walletClient!.chain,
        account: this.account,
        address: this.address,
        abi: lifeboatVaultAbi,
        functionName: "rotatePQRoot",
        args: [newRoot, newPubSeed, sig as never, worldIdProof],
      }),
    );
  }
}
