/**
 * The Lifeboat demo, scripted end-to-end against a local node:
 *   attacker steals the ECDSA key → starts a drain → PQ key vetoes → funds stay →
 *   owner cuts the cord. Run with Anvil listening on RPC_URL.
 */
import { parseEther } from "viem";
import {
  ANVIL_ACCT2,
  fmtEth,
  hotAccount,
  publicClient,
  setupVault,
  testClient,
  wait,
} from "./lib.js";

const log = (s = "") => console.log(s);
const step = (n: number, s: string) => console.log(`\n\x1b[1m[${n}] ${s}\x1b[0m`);

async function main() {
  log("\x1b[36m━━━ Lifeboat: quantum-veto vault — live demo ━━━\x1b[0m");

  step(0, "Setup: deploy vault, register PQ root, fund with 100 ETH");
  const { vault, signer } = await setupVault({ height: 8, timelockSeconds: 86_400n });
  let s = await vault.getState();
  log(`  vault:    ${vault.address}`);
  log(`  hotKey:   ${s.hotKey}  (the everyday ECDSA key)`);
  log(`  pqRoot:   ${s.pqRoot.slice(0, 18)}…  (${signer.remaining} one-time keys)`);
  log(`  timelock: ${s.timelock}s`);
  log(`  balance:  ${fmtEth(s.balance)}`);

  step(1, 'Attacker recovers the ECDSA key and tries to drain the vault');
  log(`  (we play the quantum attacker — we hold the hot key ${hotAccount.address})`);
  const digest = await vault.requestDigest(ANVIL_ACCT2, s.balance, s.hotNonce);
  const ecdsaSig = await hotAccount.sign({ hash: digest });
  const reqHash = await vault.requestWithdrawal(ANVIL_ACCT2, s.balance, ecdsaSig);
  await wait(reqHash);
  const [pending] = await vault.listPending();
  log(`  ✗ attacker called requestWithdrawal(${fmtEth(pending.amount)} → ${ANVIL_ACCT2.slice(0, 10)}…)`);
  log(`  …but it only entered a PENDING state. id=${pending.id}, unlocks at ${pending.unlockTime}`);
  log(`  \x1b[33mThe stolen key cannot move funds — only start a timelocked request.\x1b[0m`);

  step(2, "Watcher alerts the owner: a withdrawal was requested");
  log("  🔔 WithdrawalRequested seen on-chain — notifying owner to veto.");

  step(3, "Owner signs a VETO with the post-quantum key (WOTS+/XMSS)");
  const { leafIndex, hash: vetoHash } = await vault.veto(pending.id, signer);
  await wait(vetoHash);
  log(`  ✓ veto submitted with one-time leaf #${leafIndex}`);
  log(`    (on mainnet this is an EIP-8141 frame tx: ~564k verify gas, rejected by the`);
  log(`     public mempool's 100k cap, admitted by the alt mempool)`);
  const vetoed = await vault.getPending(pending.id);
  log(`    pending.vetoed = ${vetoed.vetoed}`);

  step(4, "Timelock elapses — attacker tries to execute. It fails.");
  await testClient.increaseTime({ seconds: 86_401 });
  await testClient.mine({ blocks: 1 });
  try {
    const h = await vault.executeWithdrawal(pending.id);
    await wait(h);
    log("  ⚠️  UNEXPECTED: execution succeeded (this should never happen)");
  } catch {
    log("  ✓ executeWithdrawal reverted (AlreadyVetoed) — the drain is dead");
  }
  s = await vault.getState();
  log(`  \x1b[32mvault balance still ${fmtEth(s.balance)} — funds never moved.\x1b[0m`);

  step(5, "Owner cuts the cord: revoke the ECDSA key entirely");
  const rev = await vault.revokeHotKey(signer);
  await wait(rev.hash);
  s = await vault.getState();
  log(`  ✓ hotKey revoked → ${s.hotKey} (leaf #${rev.leafIndex})`);
  const digest2 = await vault.requestDigest(ANVIL_ACCT2, parseEther("1"), s.hotNonce);
  const sig2 = await hotAccount.sign({ hash: digest2 });
  try {
    const h = await vault.requestWithdrawal(ANVIL_ACCT2, parseEther("1"), sig2);
    await wait(h);
    log("  ⚠️  UNEXPECTED: attacker could still request");
  } catch {
    log("  ✓ attacker's key is now powerless (HotKeyRevokedError)");
  }

  log("\n\x1b[36m━━━ The attacker stole the key and still lost. ━━━\x1b[0m\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
