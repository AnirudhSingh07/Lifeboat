import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type LocalAccount,
  encodeFunctionData,
} from "viem";
import { LifeboatSigner, fromHex } from "@lifeboat/pq-signer";
import { lifeboatVaultAbi } from "./abis.js";
import {
  ActionType,
  executeParamsHash,
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
  // spend policy
  dailyLimit: bigint;
  spentInWindow: bigint;
  // guardian
  guardianCount: bigint;
  guardianThreshold: bigint;
  // inheritance
  beneficiary: Address;
  inactivityPeriod: bigint;
  lastActivity: bigint;
  inheritanceUnlock: bigint;
  // emergency freeze
  frozen: boolean;
  freezer: Address;
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

  /** Read that tolerates older vault deployments missing newer functions. */
  private async safeRead<T>(functionName: string, fallback: T, args: readonly unknown[] = []): Promise<T> {
    try {
      return await this.read<T>(functionName, args);
    } catch {
      return fallback;
    }
  }

  // --------------------------------- reads ---------------------------------

  async getState(): Promise<VaultState> {
    const [
      hotKey, pqRoot, pqPubSeed, timelock, pqEpoch, hotNonce, withdrawalCount, balance,
      dailyLimit, spentInWindow, guardianCount, guardianThreshold,
      beneficiary, inactivityPeriod, lastActivity, inheritanceUnlock, frozen, freezer,
    ] = await Promise.all([
      this.read<Address>("hotKey"),
      this.read<Hex>("pqRoot"),
      this.read<Hex>("pqPubSeed"),
      this.read<bigint>("timelock"),
      this.read<number>("pqEpoch"),
      this.read<bigint>("hotNonce"),
      this.read<bigint>("withdrawalCount"),
      this.publicClient.getBalance({ address: this.address }),
      // newer fields — tolerate vaults deployed before these existed
      this.safeRead<bigint>("dailyLimit", 0n),
      this.safeRead<bigint>("spentInWindow", 0n),
      this.safeRead<bigint>("guardianCount", 0n),
      this.safeRead<bigint>("guardianThreshold", 0n),
      this.safeRead<Address>("beneficiary", "0x0000000000000000000000000000000000000000"),
      this.safeRead<bigint>("inactivityPeriod", 0n),
      this.safeRead<bigint>("lastActivity", 0n),
      this.safeRead<bigint>("inheritanceUnlock", 0n),
      this.safeRead<boolean>("frozen", false),
      this.safeRead<Address>("freezer", "0x0000000000000000000000000000000000000000"),
    ]);
    return {
      hotKey, pqRoot, pqPubSeed, timelock, pqEpoch, hotNonce, withdrawalCount, balance,
      dailyLimit, spentInWindow, guardianCount, guardianThreshold,
      beneficiary, inactivityPeriod, lastActivity, inheritanceUnlock, frozen, freezer,
    };
  }

  isAllowed(dest: Address): Promise<boolean> {
    return this.read<boolean>("allowlist", [dest]);
  }

  isGuardian(addr: Address): Promise<boolean> {
    return this.read<boolean>("isGuardian", [addr]);
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

  /** PQ-authorized arbitrary call from the vault (e.g. drive an ENSv2 registry). */
  pqExecute(target: Address, value: bigint, data: Hex, signer: LifeboatSigner) {
    return this.submitPQ(ActionType.EXECUTE, executeParamsHash(target, value, data), signer, (sig) =>
      this.walletClient!.writeContract({
        chain: this.walletClient!.chain,
        account: this.account,
        address: this.address,
        abi: lifeboatVaultAbi,
        functionName: "pqExecute",
        args: [target, value, data, sig as never],
      }),
    );
  }

  // ---------------- config (strong-key only, via a pqExecute self-call) ----------------

  /** Encode a call to one of the vault's own onlySelf setters and run it via pqExecute. */
  private pqSelfCall(functionName: string, args: readonly unknown[], signer: LifeboatSigner) {
    const data = encodeFunctionData({ abi: lifeboatVaultAbi, functionName: functionName as never, args: args as never });
    return this.pqExecute(this.address, 0n, data, signer);
  }

  setDailyLimit(limit: bigint, signer: LifeboatSigner) {
    return this.pqSelfCall("setDailyLimit", [limit], signer);
  }
  setAllowed(dest: Address, allowed: boolean, signer: LifeboatSigner) {
    return this.pqSelfCall("setAllowed", [dest, allowed], signer);
  }
  addGuardian(g: Address, signer: LifeboatSigner) {
    return this.pqSelfCall("addGuardian", [g], signer);
  }
  removeGuardian(g: Address, signer: LifeboatSigner) {
    return this.pqSelfCall("removeGuardian", [g], signer);
  }
  setGuardianThreshold(t: bigint, signer: LifeboatSigner) {
    return this.pqSelfCall("setGuardianThreshold", [t], signer);
  }
  setBeneficiary(who: Address, signer: LifeboatSigner) {
    return this.pqSelfCall("setBeneficiary", [who], signer);
  }
  setInactivityPeriod(period: bigint, signer: LifeboatSigner) {
    return this.pqSelfCall("setInactivityPeriod", [period], signer);
  }

  // ------------------------------ guardian (M-of-N) ------------------------------

  /** Sign `digest` with each guardian and order by signer address (contract requires asc). */
  private async guardianSigs(digest: Hex, guardians: LocalAccount[]): Promise<Hex[]> {
    const sorted = [...guardians].sort((a, b) =>
      a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
    );
    const sigs: Hex[] = [];
    for (const g of sorted) sigs.push(await g.sign!({ hash: digest }));
    return sigs;
  }

  async guardianVeto(id: bigint, guardians: LocalAccount[]): Promise<Hex> {
    const digest = await this.read<Hex>("guardianDigest", [ActionType.VETO, vetoParamsHash(id)]);
    const sigs = await this.guardianSigs(digest, guardians);
    return this.walletClient!.writeContract({
      chain: this.walletClient!.chain,
      account: this.account,
      address: this.address,
      abi: lifeboatVaultAbi,
      functionName: "guardianVeto",
      args: [id, sigs],
    });
  }

  async guardianExecute(
    target: Address,
    value: bigint,
    data: Hex,
    guardians: LocalAccount[],
  ): Promise<Hex> {
    const digest = await this.read<Hex>("guardianDigest", [
      ActionType.EXECUTE,
      executeParamsHash(target, value, data),
    ]);
    const sigs = await this.guardianSigs(digest, guardians);
    return this.walletClient!.writeContract({
      chain: this.walletClient!.chain,
      account: this.account,
      address: this.address,
      abi: lifeboatVaultAbi,
      functionName: "guardianExecute",
      args: [target, value, data, sigs],
    });
  }

  // ------------------------------ inheritance ------------------------------

  heartbeat(): Promise<Hex> {
    return this.walletClient!.writeContract({
      chain: this.walletClient!.chain,
      account: this.account,
      address: this.address,
      abi: lifeboatVaultAbi,
      functionName: "heartbeat",
      args: [],
    });
  }

  /** Beneficiary actions are sent FROM the beneficiary wallet (msg.sender == beneficiary). */
  startInheritanceClaim(fromWallet?: WalletClient): Promise<Hex> {
    const wc = fromWallet ?? this.walletClient!;
    return wc.writeContract({
      chain: wc.chain,
      account: wc.account!,
      address: this.address,
      abi: lifeboatVaultAbi,
      functionName: "startInheritanceClaim",
      args: [],
    });
  }

  claimInheritance(fromWallet?: WalletClient): Promise<Hex> {
    const wc = fromWallet ?? this.walletClient!;
    return wc.writeContract({
      chain: wc.chain,
      account: wc.account!,
      address: this.address,
      abi: lifeboatVaultAbi,
      functionName: "claimInheritance",
      args: [],
    });
  }

  // ------------------------------ emergency freeze ------------------------------

  /** Pause all hot-path outflow. Callable by the freezer role (e.g. a watcher bot). */
  freeze(): Promise<Hex> {
    return this.walletClient!.writeContract({
      chain: this.walletClient!.chain,
      account: this.account,
      address: this.address,
      abi: lifeboatVaultAbi,
      functionName: "freeze",
      args: [],
    });
  }

  /** Lift the freeze — strong-key only. */
  unfreeze(signer: LifeboatSigner) {
    return this.pqSelfCall("unfreeze", [], signer);
  }

  /** Designate the low-power freezer address (strong-key only). */
  setFreezer(who: Address, signer: LifeboatSigner) {
    return this.pqSelfCall("setFreezer", [who], signer);
  }
}
