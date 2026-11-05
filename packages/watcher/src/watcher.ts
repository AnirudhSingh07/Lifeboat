/**
 * Lifeboat watcher. Subscribes to WithdrawalRequested and alerts the owner so they can
 * veto with the PQ key before the timelock elapses.
 *
 * Optional "panic freeze": if PANIC_FILE points to a pre-signed revokeHotKey signature
 * (see prepare-panic.ts) and RELAYER_PK is set, the watcher broadcasts it on the first
 * alert. That can only DISABLE the hot key — it can never move funds — so if the
 * watcher is compromised, the worst case is a griefing delay, not theft.
 *
 * Env: RPC_URL, VAULT_ADDRESS, [WEBHOOK_URL], [PANIC_FILE], [RELAYER_PK], [POLL_MS]
 */
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { LifeboatClient, lifeboatVaultAbi } from "@lifeboat/sdk";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const VAULT = process.env.VAULT_ADDRESS as Address | undefined;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PANIC_FILE = process.env.PANIC_FILE;
const RELAYER_PK = process.env.RELAYER_PK as Hex | undefined;

if (!VAULT) {
  console.error("Set VAULT_ADDRESS to the deployed Lifeboat vault address.");
  process.exit(1);
}

const publicClient = createPublicClient({ chain: anvil, transport: http(RPC_URL) });
const vault = new LifeboatClient(VAULT, publicClient);

let panicArmed = Boolean(PANIC_FILE && RELAYER_PK);
let panicFired = false;

async function alert(message: string, data: Record<string, unknown>) {
  const line = `🔔 [${new Date().toISOString()}] ${message}`;
  console.log(`\x1b[33m${line}\x1b[0m`);
  for (const [k, v] of Object.entries(data)) console.log(`     ${k}: ${v}`);
  if (WEBHOOK_URL) {
    try {
      await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, ...data }),
      });
    } catch (e) {
      console.error("  webhook failed:", (e as Error).message);
    }
  }
}

/** Broadcast the pre-signed revokeHotKey ("panic freeze"). Can only disable the hot key. */
async function firePanicFreeze() {
  if (!panicArmed || panicFired || !PANIC_FILE || !RELAYER_PK) return;
  panicFired = true;
  const sig = JSON.parse(readFileSync(PANIC_FILE, "utf8"));
  const relayer = privateKeyToAccount(RELAYER_PK);
  const wallet = createWalletClient({ account: relayer, chain: anvil, transport: http(RPC_URL) });
  console.log("  🧊 firing panic freeze (pre-signed revokeHotKey — cannot move funds)…");
  const hash = await wallet.writeContract({
    account: relayer,
    chain: anvil,
    address: VAULT!,
    abi: lifeboatVaultAbi,
    functionName: "revokeHotKey",
    args: [sig],
  });
  console.log(`  🧊 panic freeze tx: ${hash}`);
}

async function main() {
  const s = await vault.getState();
  console.log("\x1b[36mLifeboat watcher online\x1b[0m");
  console.log(`  vault:    ${VAULT}`);
  console.log(`  hotKey:   ${s.hotKey}`);
  console.log(`  timelock: ${s.timelock}s`);
  console.log(`  panic:    ${panicArmed ? "ARMED (pre-signed revokeHotKey)" : "disabled"}`);
  console.log("  watching for WithdrawalRequested…\n");

  publicClient.watchContractEvent({
    address: VAULT!,
    abi: lifeboatVaultAbi,
    eventName: "WithdrawalRequested",
    pollingInterval: Number(process.env.POLL_MS ?? 1000),
    onLogs: async (logs) => {
      for (const l of logs) {
        const a = l.args as { id?: bigint; to?: Address; amount?: bigint; unlockTime?: bigint };
        const secondsLeft = a.unlockTime ? Number(a.unlockTime) - Math.floor(Date.now() / 1000) : 0;
        await alert("WITHDRAWAL REQUESTED — veto with your PQ key before the timelock!", {
          id: a.id?.toString(),
          to: a.to,
          amount: a.amount ? `${formatEther(a.amount)} ETH` : "?",
          unlockTime: a.unlockTime?.toString(),
          secondsUntilExecutable: secondsLeft,
          tx: l.transactionHash,
        });
        await firePanicFreeze();
      }
    },
    onError: (e) => console.error("watch error:", e.message),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
