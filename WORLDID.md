# World ID integration — Lifeboat

## What we gate, and why

Lifeboat gates exactly one action behind World ID: **`rotatePQRoot`**, which replaces the
account's post-quantum key tree. This is the single irreversible admin action — if an
attacker could rotate the PQ root, they would own the account; if a user loses the PQ key,
rotation is their recovery path. World's own track names "recovery or protection of an
important account action" as a prime use case, which is exactly this.

Every other action is already protected cryptographically:
- `requestWithdrawal` — ECDSA, timelocked, cannot move funds.
- `veto` / `instantMove` / `revokeHotKey` — the post-quantum signature alone.

World ID is layered **on top of** the PQ signature for rotation, **never instead of it**.

## Minimum sufficient credential

We require **Proof of Human — "same unique human"** matched by **nullifier hash**, and nothing
more. We do **not** request Orb-level identity, passport data, or any PII.

- The property we need is "the person rotating the key is the same person who set the vault
  up." For a fixed action (`rotate-pq-root`), World ID's nullifier hash is deterministic per
  human, so comparing it to the enrolled nullifier proves same-human without revealing who
  they are.
- We default to `verification_level: "device"` (Proof of Human) because unique-human is
  sufficient; an integrator who wants stronger sybil-resistance can raise it to `"orb"`
  without any contract change.

## Honest framing

**World ID is not post-quantum.** Its proofs rely on classical cryptography, so it can never
be the quantum-safety layer. In Lifeboat it is a *human-recovery factor only*: rotation always
requires the PQ signature too (and could additionally require a long timelock). World ID never
gates fund movement and is never the sole security layer.

## How it's built (two verification paths)

1. **Server-side (runs locally today).** The browser runs the real IDKit widget, gets a proof,
   and POSTs it to `apps/web/app/api/verify-worldid/route.ts`, which verifies it against the
   World Developer Portal v2 API (`/api/v2/verify/{app_id}`) and enforces the enrolled-nullifier
   match. This is the track's "verify result server-side" path and needs no special chain.
2. **On-chain (production-ready).** `packages/contracts/src/adapters/WorldIDRouterGate.sol`
   implements `IWorldIDGate` by calling the World ID Router's `verifyProof` and enforcing the
   same-human nullifier on-chain. Unit-tested against a mock router
   (`test/WorldIDGate.t.sol`, 4 passing tests). Deploy this instead of `MockWorldIDGate` on a
   chain where the Router is available.

Locally, the vault uses `MockWorldIDGate`, driven by the real server-side verification result,
so the full flow is demoable without a World-ID-enabled chain.

### Success path
Enrolled human → IDKit proof → Portal verify succeeds → nullifier matches enrolled →
`rotatePQRoot` executes → `PQRootRotated` event, epoch bumped, new tree live.

### Failure path (both shown)
- **Server-side:** a different human (or cancelled/invalid proof) → Portal verify fails or the
  nullifier doesn't match → the UI shows the rejection and `rotatePQRoot` is never submitted.
- **On-chain:** with `MockWorldIDGate.setShouldPass(false)` (or a failing Router), `rotatePQRoot`
  **reverts** (`WorldIDCheckFailed` / Router revert) — the contract itself refuses the rotation.

The DApp exposes both outcomes: with an app id configured it uses the live IDKit widget; without
one it runs a clearly-labelled simulated gate with explicit "enrolled human ✓ / different human ✗"
buttons that exercise the on-chain pass/fail.

## Configuration

```
# apps/web/.env.local
NEXT_PUBLIC_WORLD_APP_ID=app_xxxxxxxxxxxxxxxxxxxxx   # from developer.worldcoin.org
NEXT_PUBLIC_WORLD_ACTION=rotate-pq-root             # create this action in the portal
WORLD_APP_ID=app_xxxxxxxxxxxxxxxxxxxxx              # server-side (same id)
```
Without these, the UI falls back to the simulated gate. With them, use the
[Worldcoin Simulator](https://simulator.worldcoin.org) to produce staging proofs.

## Integration debrief

> We implemented the full integration (widget + server verify + on-chain gate + both paths).
> The real end-to-end proof run is pending a Developer-Portal app id; numbers marked ⏱ are to be
> captured on-site with the simulator.

- **Time to first success:** ⏱ _to be measured with a staging app id + simulator._ Build time
  for the integration code (widget, verify route, on-chain gate, tests): ~2 hours.
- **Friction we hit:**
  - **v1 vs v2 API drift.** Older guides use `credential_types`; the current API uses
    `verification_level` and a v2 verify endpoint. Mixing them silently fails. We standardised on
    v2 everywhere.
  - **SSR / `window`.** `IDKitWidget` touches browser globals, so it must be loaded with
    `next/dynamic({ ssr: false })` in the Next App Router; a plain import breaks the build.
  - **Optional peer dep noise.** IDKit → framer-motion emits a `@emotion/is-prop-valid`
    "module not found" warning; harmless, but we added the dep to keep the build clean.
  - **Signal hashing.** Matching the on-chain `signalHash` to IDKit's `ByteHasher`
    (`keccak256(signal) >> 8`) is easy to get subtly wrong; the server-side path sidesteps it,
    which is why we lead with it for the demo.
- **Missing / unclear docs:** a single canonical "App Router + server verify + on-chain gate"
  end-to-end example would have saved the most time; the pieces exist but are spread across v1/v2
  docs. The exact `signal_hash` encoding expected by the v2 verify endpoint for a `bytes32`
  signal was the least obvious part.
- **Top improvement:** ship a maintained `@worldcoin/idkit-next` adapter (dynamic-safe widget +
  a typed `verifyCloudProof` route helper) so integrators don't each re-discover the SSR and
  v1/v2 pitfalls.
