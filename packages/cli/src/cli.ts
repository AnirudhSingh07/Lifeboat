#!/usr/bin/env node
import { parseArgs } from "node:util";
import { formatEther, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { LifeboatSigner, toHex } from "@lifeboat/pq-signer";
import { LifeboatClient, deployLifeboatVault, deployMockWorldIDGate } from "@lifeboat/sdk";
import {
  DEFAULT_PK,
  DEFAULT_RPC,
  die,
  eth,
  getClients,
  loadDeployment,
  loadSigner,
  saveDeployment,
  saveSigner,
} from "./util.js";

const HELP = `lifeboat — quantum-veto vault devtool

Usage: lifeboat <command> [options]

Commands:
  keygen        Generate a post-quantum key tree and save a keyfile
  deploy        Deploy a World ID gate + Lifeboat vault (and optionally fund it)
  status        Show vault state, pending withdrawals, and timelock countdowns
  request       Start a timelocked withdrawal (ECDSA hot key)        [hot-pk]
  veto          Cancel a pending withdrawal (post-quantum key)        [key]
  instant-move  Move funds immediately (post-quantum key)            [key]
  revoke        Permanently disable the ECDSA hot key (PQ key)        [key]
  rotate        Rotate to a fresh PQ tree (PQ key; World ID on-chain) [key]
  exec          PQ-authorized arbitrary call, e.g. drive an ENSv2 registry [key]

 Spend policy (strong-key, via keyfile):
  set-limit     Set the instant daily limit        --amount <eth>        [key]
  allow         Allow/deny an instant destination  --dest <addr> [--off] [key]
 Guardian (M-of-N ECDSA):
  add-guardian  Add a guardian                     --dest <addr>         [key]
  set-threshold Set guardian threshold             --threshold <n>       [key]
  guardian-veto Veto with a guardian quorum        --id <n> --guardian-pks <pk,pk>
 Inheritance / dead-man's switch:
  set-beneficiary  --dest <addr>                                         [key]
  set-inactivity   --seconds <n>                                        [key]
  heartbeat     Prove you're alive (hot key)
 Emergency freeze (delay-only):
  set-freezer   Designate the freezer bot          --dest <addr>         [key]
  freeze        Pause all outflow (freezer role)   --pk <freezer key>
  unfreeze      Lift the freeze (strong key)                             [key]
  claim-start   Beneficiary opens a claim          --beneficiary-pk <pk>
  claim         Beneficiary sweeps after grace     --beneficiary-pk <pk>

Common options:
  --rpc <url>          RPC endpoint            (default ${DEFAULT_RPC})
  --pk <hex>           submitter/payer key     (default: Anvil #0 dev key)
  --key <path>         PQ keyfile              (default vault.key.json)
  --deployment <path>  deployment record       (default deployment.json)
  --vault <address>    vault address           (default: from deployment record)

Examples:
  lifeboat keygen --height 10 --key vault.key.json
  lifeboat deploy --key vault.key.json --hot 0xf39F...2266 --fund 100
  lifeboat status
  lifeboat request --to 0xabc... --amount 5 --hot-pk 0xac09...ff80
  lifeboat veto --id 1 --key vault.key.json
`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rpc: { type: "string" },
    pk: { type: "string" },
    key: { type: "string" },
    deployment: { type: "string" },
    vault: { type: "string" },
    height: { type: "string" },
    hot: { type: "string" },
    "hot-pk": { type: "string" },
    timelock: { type: "string" },
    fund: { type: "string" },
    to: { type: "string" },
    amount: { type: "string" },
    id: { type: "string" },
    out: { type: "string" },
    target: { type: "string" },
    data: { type: "string" },
    value: { type: "string" },
    dest: { type: "string" },
    off: { type: "boolean" },
    seconds: { type: "string" },
    threshold: { type: "string" },
    "guardian-pks": { type: "string" },
    "beneficiary-pk": { type: "string" },
    help: { type: "boolean" },
  },
});

const cmd = positionals[0];
const rpc = o.rpc ?? DEFAULT_RPC;
const pk = (o.pk as Hex) ?? DEFAULT_PK;
const keyPath = o.key ?? "vault.key.json";
const deploymentPath = o.deployment ?? "deployment.json";
const need = (v: string | undefined, name: string): string => v ?? die(`missing --${name}`);
const vaultAddr = (): Address =>
  (o.vault as Address) ?? (loadDeployment(deploymentPath).vault as Address);

async function clientFor(write: boolean): Promise<LifeboatClient> {
  const c = await getClients(rpc, pk);
  return new LifeboatClient(vaultAddr(), c.publicClient, write ? c.walletClient : undefined);
}

/** Wait for a PQ action to confirm, then persist the advanced leaf counter. */
async function confirmAndSave(hash: Hex, signer: LifeboatSigner, label: string) {
  const c = await getClients(rpc, pk);
  const r = await c.publicClient.waitForTransactionReceipt({ hash });
  if (r.status !== "success") die(`${label} reverted on-chain (tx ${hash})`);
  saveSigner(keyPath, signer); // persist leaf advance only on success
  console.log(`✓ ${label} confirmed — tx ${hash}`);
  console.log(`  keyfile updated: ${signer.remaining} one-time keys remaining`);
}

async function main() {
  if (o.help || !cmd || cmd === "help") {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case "keygen": {
      const height = Number(o.height ?? 10);
      const out = o.out ?? keyPath;
      process.stdout.write(`generating XMSS tree (2^${height} one-time keys)… `);
      const signer = LifeboatSigner.generate(height);
      saveSigner(out, signer);
      console.log("done");
      console.log(`  keyfile:  ${out}`);
      console.log(`  pqRoot:   ${toHex(signer.root)}`);
      console.log(`  pqPubSeed:${toHex(signer.pubSeed)}`);
      console.log(`  keys:     ${signer.numLeaves} (height ${height})`);
      console.log("\nKeep this file secret — it holds your post-quantum master seed.");
      break;
    }

    case "deploy": {
      const signer = loadSigner(keyPath);
      const hot = need(o.hot, "hot") as Address;
      const timelock = BigInt(o.timelock ?? "86400");
      const c = await getClients(rpc, pk);
      console.log("deploying World ID gate…");
      const gate = await deployMockWorldIDGate(c.walletClient, c.publicClient, c.account, true);
      console.log("deploying LifeboatVault…");
      const vault = await deployLifeboatVault(c.walletClient, c.publicClient, c.account, {
        hotKey: hot,
        pqRoot: toHex(signer.root),
        pqPubSeed: toHex(signer.pubSeed),
        timelockSeconds: timelock,
        worldIdGate: gate,
      });
      if (o.fund) {
        const h = await c.walletClient.sendTransaction({
          account: c.account,
          chain: c.chain,
          to: vault,
          value: parseEther(o.fund),
        });
        await c.publicClient.waitForTransactionReceipt({ hash: h });
        console.log(`funded vault with ${o.fund} ETH`);
      }
      saveDeployment(deploymentPath, {
        chainId: c.chain.id,
        vault,
        gate,
        hotKey: hot,
        timelock: Number(timelock),
      });
      console.log(`\n✓ deployed`);
      console.log(`  vault: ${vault}`);
      console.log(`  gate:  ${gate}`);
      console.log(`  saved: ${deploymentPath}`);
      break;
    }

    case "status": {
      const client = await clientFor(false);
      const [s, pending] = await Promise.all([client.getState(), client.listPending()]);
      const revoked = s.hotKey === "0x0000000000000000000000000000000000000000";
      console.log(`Vault ${client.address}`);
      console.log(`  balance:   ${eth(s.balance)}`);
      console.log(`  hotKey:    ${revoked ? "REVOKED" : s.hotKey}`);
      console.log(`  pqRoot:    ${s.pqRoot}`);
      console.log(`  pqEpoch:   ${s.pqEpoch}`);
      console.log(`  timelock:  ${s.timelock}s`);
      console.log(`  pending:   ${pending.length}`);
      // countdown must be relative to CHAIN time, not wall-clock (devnets manipulate time)
      const now = Number((await client.publicClient.getBlock({ blockTag: "latest" })).timestamp);
      for (const p of pending) {
        const left = Number(p.unlockTime) - now;
        const st = p.vetoed ? "VETOED" : left > 0 ? `${left}s left` : "UNLOCKED";
        console.log(`   #${p.id} → ${p.to} · ${formatEther(p.amount)} ETH · ${st}`);
      }
      break;
    }

    case "request": {
      const to = need(o.to, "to") as Address;
      const amount = parseEther(need(o.amount, "amount"));
      const hotPk = need(o["hot-pk"], "hot-pk") as Hex;
      const client = await clientFor(true);
      const before = await client.getState();
      const digest = await client.requestDigest(to, amount, before.hotNonce);
      const sig = await privateKeyToAccount(hotPk).sign({ hash: digest });
      const hash = await client.requestWithdrawal(to, amount, sig);
      const c = await getClients(rpc, pk);
      await c.publicClient.waitForTransactionReceipt({ hash });
      const countAfter = (await client.getState()).withdrawalCount;
      if (countAfter > before.withdrawalCount) {
        console.log(`✓ withdrawal requested (pending id #${countAfter}) — tx ${hash}`);
        console.log(`  timelocked; funds have NOT moved — veto before it unlocks.`);
      } else {
        console.log(`✓ INSTANT withdrawal of ${o.amount} ETH sent — tx ${hash}`);
        console.log(`  permitted by the spend policy (allowlisted or under the daily limit).`);
      }
      break;
    }

    case "veto": {
      const id = BigInt(need(o.id, "id"));
      const signer = loadSigner(keyPath);
      const client = await clientFor(true);
      const { leafIndex, hash } = await client.veto(id, signer);
      console.log(`veto #${id} signed with one-time leaf #${leafIndex}`);
      await confirmAndSave(hash, signer, `veto #${id}`);
      break;
    }

    case "instant-move": {
      const to = need(o.to, "to") as Address;
      const amount = parseEther(need(o.amount, "amount"));
      const signer = loadSigner(keyPath);
      const client = await clientFor(true);
      const { leafIndex, hash } = await client.instantMove(to, amount, signer);
      console.log(`instant-move ${formatEther(amount)} ETH → ${to} (leaf #${leafIndex})`);
      await confirmAndSave(hash, signer, "instant-move");
      break;
    }

    case "revoke": {
      const signer = loadSigner(keyPath);
      const client = await clientFor(true);
      const { leafIndex, hash } = await client.revokeHotKey(signer);
      console.log(`revoke hot key signed with leaf #${leafIndex}`);
      await confirmAndSave(hash, signer, "revokeHotKey");
      break;
    }

    case "rotate": {
      const current = loadSigner(keyPath);
      const height = Number(o.height ?? current.height);
      const out = o.out ?? keyPath;
      console.log(`generating a fresh tree (2^${height})…`);
      const next = LifeboatSigner.generate(height);
      const client = await clientFor(true);
      const { leafIndex, hash } = await client.rotatePQRoot(
        toHex(next.root),
        toHex(next.pubSeed),
        current,
        "0x",
      );
      console.log(`rotate signed with current leaf #${leafIndex}`);
      const c = await getClients(rpc, pk);
      const r = await c.publicClient.waitForTransactionReceipt({ hash });
      if (r.status !== "success") die(`rotate reverted (tx ${hash}) — is the World ID gate passing?`);
      saveSigner(out, next); // the new tree is now the active key
      console.log(`✓ rotated — tx ${hash}`);
      console.log(`  new keyfile: ${out} (${next.numLeaves} fresh keys)`);
      break;
    }

    case "exec": {
      const target = need(o.target, "target") as Address;
      const data = need(o.data, "data") as Hex;
      const value = o.value ? parseEther(o.value) : 0n;
      const signer = loadSigner(keyPath);
      const client = await clientFor(true);
      const { leafIndex, hash } = await client.pqExecute(target, value, data, signer);
      console.log(`pqExecute → ${target} (leaf #${leafIndex})`);
      await confirmAndSave(hash, signer, "pqExecute");
      break;
    }

    case "set-limit": {
      const signer = loadSigner(keyPath);
      const client = await clientFor(true);
      const { hash } = await client.setDailyLimit(parseEther(need(o.amount, "amount")), signer);
      await confirmAndSave(hash, signer, "setDailyLimit");
      break;
    }

    case "allow": {
      const dest = need(o.dest, "dest") as Address;
      const signer = loadSigner(keyPath);
      const client = await clientFor(true);
      const { hash } = await client.setAllowed(dest, !o.off, signer);
      await confirmAndSave(hash, signer, `setAllowed(${o.off ? "deny" : "allow"})`);
      break;
    }

    case "add-guardian": {
      const dest = need(o.dest, "dest") as Address;
      const signer = loadSigner(keyPath);
      const client = await clientFor(true);
      const { hash } = await client.addGuardian(dest, signer);
      await confirmAndSave(hash, signer, "addGuardian");
      break;
    }

    case "set-threshold": {
      const signer = loadSigner(keyPath);
      const client = await clientFor(true);
      const { hash } = await client.setGuardianThreshold(BigInt(need(o.threshold, "threshold")), signer);
      await confirmAndSave(hash, signer, "setGuardianThreshold");
      break;
    }

    case "guardian-veto": {
      const id = BigInt(need(o.id, "id"));
      const pks = need(o["guardian-pks"], "guardian-pks").split(",");
      const guardians = pks.map((p) => privateKeyToAccount(p.trim() as Hex));
      const client = await clientFor(true);
      const hash = await client.guardianVeto(id, guardians);
      const c = await getClients(rpc, pk);
      await c.publicClient.waitForTransactionReceipt({ hash });
      console.log(`✓ guardian quorum vetoed #${id} — tx ${hash}`);
      break;
    }

    case "set-beneficiary": {
      const dest = need(o.dest, "dest") as Address;
      const signer = loadSigner(keyPath);
      const client = await clientFor(true);
      const { hash } = await client.setBeneficiary(dest, signer);
      await confirmAndSave(hash, signer, "setBeneficiary");
      break;
    }

    case "set-inactivity": {
      const signer = loadSigner(keyPath);
      const client = await clientFor(true);
      const { hash } = await client.setInactivityPeriod(BigInt(need(o.seconds, "seconds")), signer);
      await confirmAndSave(hash, signer, "setInactivityPeriod");
      break;
    }

    case "heartbeat": {
      const client = await clientFor(true);
      const hash = await client.heartbeat();
      const c = await getClients(rpc, pk);
      await c.publicClient.waitForTransactionReceipt({ hash });
      console.log(`✓ heartbeat — tx ${hash}`);
      break;
    }

    case "set-freezer": {
      const signer = loadSigner(keyPath);
      const client = await clientFor(true);
      const { hash } = await client.setFreezer(need(o.dest, "dest") as Address, signer);
      await confirmAndSave(hash, signer, "setFreezer");
      break;
    }

    case "freeze": {
      const client = await clientFor(true); // --pk must be the freezer role
      const hash = await client.freeze();
      const c = await getClients(rpc, pk);
      await c.publicClient.waitForTransactionReceipt({ hash });
      console.log(`✓ vault frozen — no funds can leave until a strong key unfreezes. tx ${hash}`);
      break;
    }

    case "unfreeze": {
      const signer = loadSigner(keyPath);
      const client = await clientFor(true);
      const { hash } = await client.unfreeze(signer);
      await confirmAndSave(hash, signer, "unfreeze");
      break;
    }

    case "claim-start":
    case "claim": {
      const bPk = need(o["beneficiary-pk"], "beneficiary-pk") as Hex;
      const bc = await getClients(rpc, bPk); // send from the beneficiary
      const client = new LifeboatClient(vaultAddr(), bc.publicClient, bc.walletClient);
      const hash = cmd === "claim-start"
        ? await client.startInheritanceClaim()
        : await client.claimInheritance();
      await bc.publicClient.waitForTransactionReceipt({ hash });
      console.log(`✓ ${cmd} — tx ${hash}`);
      break;
    }

    default:
      die(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

main().catch((e) => die((e as Error).message.split("\n")[0] ?? "unknown error"));
