# 🛟 Lifeboat — a quantum-veto vault for Ethereum

**Your everyday ECDSA key can only _start_ a timelocked withdrawal. A post-quantum
WOTS+/XMSS key can _veto_ it or move funds instantly. A quantum attacker who steals your
ECDSA key still can't take your money.**

> ETHGlobal Mumbai · post-quantum security · EIP-8141 frame transactions / alt mempool

---

## The problem

Every EOA that has ever sent a transaction has its public key on-chain. A sufficiently
powerful quantum computer running Shor's algorithm can recover the private key from that
public key — putting most of the ETH, tokens, and NFTs on Ethereum at risk.

"Migrating" to a PQ wallet doesn't fully help today: if you point your EOA at a PQ verifier
with EIP-7702, your old ECDSA key still works at the protocol level, so an attacker who
recovers it can still drain or re-delegate the account. And PQ signatures don't fit the
public mempool — EIP-8141 caps validation work at `MAX_VERIFY_GAS = 100,000`, far below
what a hash-based signature costs to verify.

**Our angle:** we can't kill the old ECDSA key, so we take away its power. It keeps
day-to-day convenience but loses the ability to move funds fast.

## How it works

Funds sit in a **`LifeboatVault`** smart account, not in the bare EOA. The vault answers to
two keys with very different powers:

| Action | Key | Effect |
|---|---|---|
| `requestWithdrawal` | ECDSA (hot) | opens a **timelocked, pending** withdrawal — nothing moves yet |
| `executeWithdrawal` | anyone | completes a withdrawal **after** its timelock |
| `veto` | **PQ** | cancels a pending withdrawal |
| `instantMove` | **PQ** | moves funds immediately, no timelock |
| `revokeHotKey` | **PQ** | permanently disables the ECDSA key ("cut the cord") |
| `rotatePQRoot` | **PQ + World ID** | rotate to a fresh PQ tree (human-recovery gated) |

### The attack story (which is also the demo)

1. The attacker recovers the ECDSA private key (we play the "quantum attacker" and paste it).
2. The attacker calls `requestWithdrawal` to drain the vault → it only enters a **pending** state with a timelock.
3. The watcher alerts the owner.
4. The owner signs a `veto` with the PQ key. On devnet this goes out as an **EIP-8141 frame transaction**: the public mempool rejects it (verification exceeds 100k gas), the **alt mempool** admits it.
5. The withdrawal is cancelled, funds stay put. Optionally the owner `revokeHotKey`s to neutralise the stolen key entirely.

> **Beyond the demo:** if Ethereum later hard-forks to disable ECDSA, every Lifeboat account
> already has a registered PQ key — those accounts are rescued for free, with no seed proofs.

---

## What's in this repo

```
packages/
  contracts/     Foundry — LifeboatVault + WOTS+/XMSS verifier (LifeboatPQ) + tests
  pq-signer/     TypeScript WOTS+/XMSS one-time signer (keys never leave the device)
  sdk/           viem client + deploy helpers + action encoding (the devtool foundation)
  watcher/       event watcher + alerting + optional pre-signed "panic freeze"
  demo/          scripted end-to-end attack→veto flow against a local node
apps/
  web/           Next.js DApp: live dashboard, attacker panel, one-click PQ veto
```

The crypto spec lives in [`packages/pq-signer/SPEC.md`](packages/pq-signer/SPEC.md) and is the
single source of truth the TS signer and the Solidity verifier both implement, byte-for-byte.

### The headline number

On-chain WOTS+/XMSS verification costs **≈ 564,000 gas** (measured in Foundry,
`PQGasTest`) — **5.6× over EIP-8141's 100k `MAX_VERIFY_GAS`**. That is precisely why these
transactions need the alt mempool, and it's the concrete justification for the EF frame-tx
track.

### The PQ scheme (v1)

- **WOTS+** one-time signatures over `keccak256` (`w=16`, 67 chains), with per-step
  key/bitmask derivation from a public seed — the real "+" construction.
- **XMSS**-style Merkle tree (height 10 → 1024 one-time keys) committing the WOTS+ leaves.
- One-time-key reuse is enforced on-chain via a per-epoch used-leaf map; rotation bumps the
  epoch. Every PQ action binds the vault address, chain id, action type, params, and leaf
  index into the signed digest, so a signature can't be replayed for a different action.

> We use `keccak256` (a native EVM opcode) instead of SHA-256 for a ~10–100× gas saving; the
> hash-based security argument is unchanged. Falcon via precompile (EIP-8052) is future work.

---

## Run it locally

Prereqs: Node ≥ 20, [pnpm](https://pnpm.io), [Foundry](https://getfoundry.sh).

```bash
pnpm install

# 1. contracts: 20 tests incl. the full attack/veto scenario + the gas benchmark
pnpm contracts:test
FOUNDRY_PROFILE=gas pnpm --filter @lifeboat/contracts gas   # prints the ~564k verify-gas number

# 2. the post-quantum signer: 12 unit tests
pnpm signer:test

# 3. regenerate the TS↔Solidity cross-check vectors (optional; committed)
pnpm vectors

# --- live demo ---
pnpm anvil                       # terminal A: local node on :8545

pnpm --filter @lifeboat/demo attack-veto   # terminal B: scripted end-to-end flow

# --- the DApp ---
pnpm --filter @lifeboat/sdk build          # build workspace deps the app imports
pnpm --filter @lifeboat/pq-signer build
pnpm web                          # terminal B: Next.js app on :3000 → click "Launch demo vault"

# --- the watcher ---
VAULT_ADDRESS=0x... pnpm watcher  # terminal C: point at the deployed vault
```

> The DApp is **local-first**: it deploys a fresh vault to Anvil and generates the PQ tree
> in your browser. The dev key it uses is a public Anvil account — never real funds.

---

## Where each sponsor fits

### EF — Frame Transaction / Alt Mempool _(core prize)_
The EF track asks for apps that need frame transactions with verification above 100k gas, and
names PQ-secure smart wallets as the example. Our `veto` / `instantMove` / `revokeHotKey`
paths do exactly that at **~564k verify gas**. The vault verifier and signer are built and
cross-checked; the alt-mempool submission is wired as an adapter to drop onto the EF devnet
on-site (endpoints + frame layout confirmed with the alt-mempool team). _Backup slot: Best
CROPS App (see below)._

### ENSv2 — Enhanced Access Control _(planned, adapter-ready)_
If your ECDSA key controls your ENS name, a quantum attacker can repoint `you.eth`. The plan:
put the critical roles (address record, name transfer) under the PQ-controlled vault and
leave only low-risk roles (avatar, description) with the hot key, then publish the vault
address + PQ commitment as records. Lives on Sepolia; a cross-chain gap with the alt-mempool
devnet is noted below.

### World — IDKit _(built)_
The PQ key is a single point of failure, so we gate the one irreversible admin action —
`rotatePQRoot` — behind a fresh World ID check (**same unique human**, matched by nullifier).
Built end-to-end:
- **Server-side verify** against the Developer Portal v2 API (`apps/web/app/api/verify-worldid`),
  with enrollment + same-human nullifier matching — runs locally today.
- **On-chain gate** `WorldIDRouterGate.sol` (wraps the World ID Router's `verifyProof`), unit-
  tested against a mock router — deploy it in place of `MockWorldIDGate` on a Router-enabled chain.
- The DApp shows both the **success and failure** paths; without an app id it runs a clearly-
  labelled simulated gate so the demo still works. Full write-up + the required integration
  debrief: **[WORLDID.md](WORLDID.md)**.

**World ID is a human-recovery factor, never the quantum-safety layer** — rotation always
requires the PQ signature too. Minimum sufficient credential: Proof of Human ("same unique
human"), no PII. Configure with `NEXT_PUBLIC_WORLD_APP_ID` / `WORLD_APP_ID` / `NEXT_PUBLIC_WORLD_ACTION`.

---

## CROPS

- **Censorship-resistance** — the PQ path pays its own gas and needs no ECDSA and no trusted
  relayer; any party can submit an admitted frame transaction.
- **Openness** — fully open-source; the signer, verifier, SDK, and watcher are reusable, and
  the scheme is specified in `SPEC.md`.
- **Privacy** — WOTS+ keys never leave the device; the watcher only ever holds a pre-signed
  action that can delay, never move, funds.
- **Security** — hash-based signatures (quantum-resistant), one-time-key enforcement on-chain,
  timelock + veto, and a human-recovery factor for the one irreversible admin action.

---

## Honest limitations

- Only funds **inside the vault** are protected; assets left in the bare EOA balance are not.
- Someone must notice a malicious withdrawal **within the timelock**. The watcher helps; a
  longer timelock trades convenience for safety.
- WOTS+ keys are **one-time**; the signer tracks leaf indices, and the tree size caps the
  number of PQ actions before a rotation is needed.
- An attacker with the hot key could **spam** withdrawal requests; mitigation is a single
  `revokeHotKey` from the PQ key.
- The alt mempool / EIP-8141 are **devnet-only** today; ENSv2 lives on Sepolia/mainnet, so
  there is a cross-chain gap in the demo.
- **World ID is not post-quantum** — it is used only as a human recovery factor, never the
  sole security layer.

## What's next

Falcon via precompile (EIP-8052) when available · readiness for an ECDSA-disabling hard fork
(Lifeboat accounts are rescued automatically) · upstreaming the signer/SDK to Kohaku and
other wallets.

---

MIT licensed. Built at ETHGlobal Mumbai.
