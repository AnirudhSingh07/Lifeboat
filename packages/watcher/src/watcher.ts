/**
 * Lifeboat watcher + auto-responder.
 *
 * Watches WithdrawalRequested and (optionally) responds automatically. Both response powers
 * are NON-CUSTODIAL — they can only delay or cancel a withdrawal, never move funds — so it
 * is safe to run this unattended. If the bot's keys leak, the worst case is griefing
 * (freeze/veto spam), not theft. This takes the human off the critical "veto in time" path.
 *
 * Responses, in order of preference:
 *   - GUARDIAN_PKS set  → auto-veto the specific withdrawal (cancels just that drain)
 *   - FREEZER_PK set    → freeze the whole vault (pauses all outflow until a strong key lifts it)
 *   - neither           → alert only
 *
 * Policy: act only on withdrawals NOT in AUTO_ALLOW and at/above AUTO_MIN_ETH.
 *
 * Env: RPC_URL, VAULT_ADDRESS, [CHAIN_ID], [WEBHOOK_URL], [POLL_MS],
 *      [GUARDIAN_PKS=0x..,0x..], [FREEZER_PK=0x..], [AUTO_ALLOW=0x..,0x..], [AUTO_MIN_ETH]
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil, sepolia } from "viem/chains";
import { LifeboatClient, lifeboatVaultAbi } from "@lifeboat/sdk";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const VAULT = process.env.VAULT_ADDRESS as Address | undefined;
const CHAIN = Number(process.env.CHAIN_ID ?? 31337) === sepolia.id ? sepolia : anvil;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const GUARDIAN_PKS = (process.env.GUARDIAN_PKS ?? "").split(",").map((s) => s.trim()).filter(Boolean) as Hex[];
const FREEZER_PK = process.env.FREEZER_PK as Hex | undefined;
const AUTO_ALLOW = new Set((process.env.AUTO_ALLOW ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean));
const AUTO_MIN_WEI = parseEther(process.env.AUTO_MIN_ETH ?? "0");

if (!VAULT) {
  console.error("Set VAULT_ADDRESS to the deployed Lifeboat vault.");
  process.exit(1);
}

const transport = http(RPC_URL);
const publicClient = createPublicClient({ chain: CHAIN, transport });

const guardianAccounts = GUARDIAN_PKS.map((pk) => privateKeyToAccount(pk));
const freezerAccount = FREEZER_PK ? privateKeyToAccount(FREEZER_PK) : undefined;
let didFreeze = false;

async function alert(message: string, data: Record<string, unknown>) {
  console.log(`\x1b[33m🔔 [${new Date().toISOString()}] ${message}\x1b[0m`);
  for (const [k, v] of Object.entries(data)) console.log(`     ${k}: ${v}`);
  if (WEBHOOK_URL) {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, ...data }),
    }).catch((e) => console.error("  webhook failed:", (e as Error).message));
  }
}

async function respond(id: bigint, to: Address, amount: bigint) {
  if (AUTO_ALLOW.has(to.toLowerCase())) {
    console.log(`  ↳ ${to} is allowlisted — no action.`);
    return;
  }
  if (amount < AUTO_MIN_WEI) {
    console.log(`  ↳ ${formatEther(amount)} ETH is below AUTO_MIN_ETH — no action.`);
    return;
  }
  try {
    const lead = guardianAccounts[0];
    if (lead) {
      const wallet = createWalletClient({ account: lead, chain: CHAIN, transport });
      const client = new LifeboatClient(VAULT!, publicClient, wallet);
      const hash = await client.guardianVeto(id, guardianAccounts);
      console.log(`  \x1b[32m🛡 auto-vetoed withdrawal #${id} (guardian quorum) — ${hash}\x1b[0m`);
    } else if (freezerAccount) {
      if (didFreeze) return;
      const wallet = createWalletClient({ account: freezerAccount, chain: CHAIN, transport });
      const client = new LifeboatClient(VAULT!, publicClient, wallet);
      const hash = await client.freeze();
      didFreeze = true;
      console.log(`  \x1b[36m🧊 froze the vault (no funds can leave until a strong key unfreezes) — ${hash}\x1b[0m`);
    } else {
      console.log("  ↳ no responder configured (set GUARDIAN_PKS or FREEZER_PK) — alert only.");
    }
  } catch (e) {
    console.error(`  auto-response failed: ${(e as Error).message.split("\n")[0]}`);
  }
}

async function main() {
  const vault = new LifeboatClient(VAULT!, publicClient);
  const s = await vault.getState();
  const responder = guardianAccounts.length
    ? `auto-veto (${guardianAccounts.length} guardian key(s))`
    : freezerAccount
      ? "auto-freeze"
      : "alert only";
  console.log("\x1b[36mLifeboat watcher online\x1b[0m");
  console.log(`  vault:     ${VAULT}  (${CHAIN.name})`);
  console.log(`  hotKey:    ${s.hotKey}`);
  console.log(`  responder: ${responder}`);
  console.log(`  policy:    act on sends not in AUTO_ALLOW and ≥ ${formatEther(AUTO_MIN_WEI)} ETH`);
  console.log("  watching WithdrawalRequested…\n");

  publicClient.watchContractEvent({
    address: VAULT!,
    abi: lifeboatVaultAbi,
    eventName: "WithdrawalRequested",
    pollingInterval: Number(process.env.POLL_MS ?? 1000),
    onLogs: async (logs) => {
      for (const l of logs) {
        const a = l.args as { id?: bigint; to?: Address; amount?: bigint; unlockTime?: bigint };
        if (a.id === undefined || a.to === undefined || a.amount === undefined) continue;
        await alert("Withdrawal requested", {
          id: a.id.toString(),
          to: a.to,
          amount: `${formatEther(a.amount)} ETH`,
          tx: l.transactionHash,
        });
        await respond(a.id, a.to, a.amount);
      }
    },
    onError: (e) => console.error("watch error:", e.message),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
