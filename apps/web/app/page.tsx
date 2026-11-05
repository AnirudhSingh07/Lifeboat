"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatEther, parseEther, type Address } from "viem";
import { LifeboatSigner, toHex } from "@lifeboat/pq-signer";
import {
  LifeboatClient,
  deployLifeboatVault,
  deployMockWorldIDGate,
  type PendingWithdrawal,
  type VaultState,
} from "@lifeboat/sdk";
import {
  ATTACKER_DEST,
  DEMO_TREE_HEIGHT,
  hotAccount,
  publicClient,
  testClient,
  walletClient,
} from "../lib/chain";
import { RotatePanel } from "../components/RotatePanel";

type LogKind = "info" | "ok" | "bad" | "";
interface LogLine {
  t: string;
  kind: LogKind;
  msg: string;
}

const short = (s?: string, n = 8) => (s ? `${s.slice(0, n + 2)}…${s.slice(-4)}` : "—");

export default function Page() {
  const signerRef = useRef<LifeboatSigner | null>(null);
  const clientRef = useRef<LifeboatClient | null>(null);

  const [phase, setPhase] = useState<"idle" | "launching" | "ready">("idle");
  const [vaultAddr, setVaultAddr] = useState<Address | null>(null);
  const [gateAddr, setGateAddr] = useState<Address | null>(null);
  const [state, setState] = useState<VaultState | null>(null);
  const [pending, setPending] = useState<PendingWithdrawal[]>([]);
  const [remaining, setRemaining] = useState(0);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [drainAmount, setDrainAmount] = useState("100");

  const addLog = useCallback((msg: string, kind: LogKind = "") => {
    const t = new Date().toLocaleTimeString();
    setLog((l) => [{ t, kind, msg }, ...l].slice(0, 60));
  }, []);

  const refresh = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const [s, p] = await Promise.all([c.getState(), c.listPending()]);
    setState(s);
    setPending(p);
    if (signerRef.current) setRemaining(signerRef.current.remaining);
  }, []);

  // countdown tick + state polling
  useEffect(() => {
    const tick = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    const poll = setInterval(() => void refresh(), 2500);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [refresh]);

  const launch = useCallback(async () => {
    try {
      setPhase("launching");
      addLog(`Generating XMSS tree (2^${DEMO_TREE_HEIGHT} one-time keys)…`, "info");
      await new Promise((r) => setTimeout(r, 60)); // let the spinner paint
      const signer = LifeboatSigner.generate(DEMO_TREE_HEIGHT);
      signerRef.current = signer;

      addLog("Deploying World ID gate + Lifeboat vault…", "info");
      const gate = await deployMockWorldIDGate(walletClient, publicClient, hotAccount, true);
      setGateAddr(gate);
      const addr = await deployLifeboatVault(walletClient, publicClient, hotAccount, {
        hotKey: hotAccount.address,
        pqRoot: toHex(signer.root),
        pqPubSeed: toHex(signer.pubSeed),
        timelockSeconds: 60n, // 60s timelock keeps the live demo snappy
        worldIdGate: gate,
      });

      addLog("Funding vault with 100 ETH…", "info");
      const h = await walletClient.sendTransaction({
        account: hotAccount,
        chain: walletClient.chain,
        to: addr,
        value: parseEther("100"),
      });
      await publicClient.waitForTransactionReceipt({ hash: h });

      clientRef.current = new LifeboatClient(addr, publicClient, walletClient);
      setVaultAddr(addr);
      setPhase("ready");
      addLog(`Vault live at ${addr}`, "ok");
      await refresh();
    } catch (e) {
      addLog(`launch failed: ${(e as Error).message}`, "bad");
      setPhase("idle");
    }
  }, [addLog, refresh]);

  const run = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setBusy(label);
      try {
        await fn();
      } catch (e) {
        addLog(`${label} failed: ${(e as Error).message.split("\n")[0]}`, "bad");
      } finally {
        setBusy(null);
        await refresh();
      }
    },
    [addLog, refresh],
  );

  const attackerDrain = () =>
    run("drain", async () => {
      const c = clientRef.current!;
      const s = await c.getState();
      const amount = parseEther(drainAmount || "0");
      addLog(`☠ attacker uses the STOLEN ECDSA key → requestWithdrawal(${drainAmount} ETH)`, "bad");
      const digest = await c.requestDigest(ATTACKER_DEST, amount, s.hotNonce);
      const sig = await hotAccount.sign({ hash: digest });
      const hash = await c.requestWithdrawal(ATTACKER_DEST, amount, sig);
      await publicClient.waitForTransactionReceipt({ hash });
      addLog(`…but it only enters a PENDING timelock. Funds have NOT moved.`, "info");
    });

  const veto = (id: bigint) =>
    run(`veto-${id}`, async () => {
      const c = clientRef.current!;
      const { leafIndex, hash } = await c.veto(id, signerRef.current!);
      await publicClient.waitForTransactionReceipt({ hash });
      addLog(`🛡 PQ VETO on #${id} with one-time leaf #${leafIndex} — withdrawal cancelled`, "ok");
    });

  const execute = (id: bigint) =>
    run(`exec-${id}`, async () => {
      const c = clientRef.current!;
      try {
        const hash = await c.executeWithdrawal(id);
        await publicClient.waitForTransactionReceipt({ hash });
        addLog(`#${id} executed — funds moved (this path is only reachable if NOT vetoed)`, "bad");
      } catch {
        addLog(`#${id} execution REVERTED — the drain is dead, funds stay put`, "ok");
      }
    });

  const advanceTime = () =>
    run("advance", async () => {
      await testClient.increaseTime({ seconds: 61 });
      await testClient.mine({ blocks: 1 });
      addLog("⏩ fast-forwarded past the timelock (dev only)", "info");
    });

  const cutCord = () =>
    run("revoke", async () => {
      const { leafIndex, hash } = await clientRef.current!.revokeHotKey(signerRef.current!);
      await publicClient.waitForTransactionReceipt({ hash });
      addLog(`✂ hot key revoked with leaf #${leafIndex} — the stolen key is now powerless`, "ok");
    });

  const revoked = state?.hotKey === "0x0000000000000000000000000000000000000000";

  return (
    <div className="wrap">
      <header className="masthead">
        <div className="logo">
          Life<span className="q">boat</span>
        </div>
        <div className="tagline">a quantum-veto vault for Ethereum</div>
      </header>
      <p className="sub">
        Your everyday ECDSA key can only <b>start</b> a timelocked withdrawal. A post-quantum
        WOTS+/XMSS key can <b>veto</b> it or move funds instantly. Play the quantum attacker below:
        steal the key, try to drain the vault — and watch the post-quantum key win.
      </p>

      {phase !== "ready" && (
        <div className="card span2">
          <h2>
            <span className="dot" /> Setup
          </h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Requires a local Anvil node on <span className="mono">127.0.0.1:8545</span> (
            <span className="mono">pnpm anvil</span>). This generates a post-quantum key tree in your
            browser, then deploys and funds a fresh Lifeboat vault.
          </p>
          <div className="btnrow">
            <button className="primary" onClick={launch} disabled={phase === "launching"}>
              {phase === "launching" ? (
                <>
                  <span className="spinner" />
                  Launching demo vault…
                </>
              ) : (
                "Launch demo vault"
              )}
            </button>
          </div>
        </div>
      )}

      {phase === "ready" && state && (
        <div className="grid">
          {/* Vault status */}
          <div className="card">
            <h2>
              <span className="dot" /> Vault
            </h2>
            <div className="big">
              {formatEther(state.balance)}
              <span className="unit">ETH secured</span>
            </div>
            <div style={{ marginTop: 14 }}>
              <div className="row">
                <span className="k">address</span>
                <span className="v">{short(vaultAddr ?? "", 10)}</span>
              </div>
              <div className="row">
                <span className="k">hot key (ECDSA)</span>
                <span className="v">
                  {revoked ? <span className="pill armed">REVOKED</span> : short(state.hotKey, 10)}
                </span>
              </div>
              <div className="row">
                <span className="k">PQ root (XMSS)</span>
                <span className="v">{short(state.pqRoot, 10)}</span>
              </div>
              <div className="row">
                <span className="k">one-time keys left</span>
                <span className="v">{remaining}</span>
              </div>
              <div className="row">
                <span className="k">timelock</span>
                <span className="v">{state.timelock.toString()}s</span>
              </div>
            </div>
          </div>

          {/* Attacker */}
          <div className="card danger">
            <h2>
              <span className="dot" /> Quantum attacker
            </h2>
            <div className="row">
              <span className="k">recovered private key</span>
              <span className="v">{short(hotAccount.address, 8)}</span>
            </div>
            <label>Drain amount (ETH)</label>
            <input value={drainAmount} onChange={(e) => setDrainAmount(e.target.value)} />
            <div className="btnrow" style={{ marginTop: 12 }}>
              <button className="danger" onClick={attackerDrain} disabled={!!busy || revoked}>
                {busy === "drain" ? <><span className="spinner" />Draining…</> : "Drain vault with stolen key"}
              </button>
            </div>
            <p className="hint">
              {revoked
                ? "The hot key has been revoked — requests now revert. The attacker is locked out."
                : "This holds the stolen everyday key. The best it can do is open a timelocked request — never move funds."}
            </p>
          </div>

          {/* Pending withdrawals */}
          <div className="card span2">
            <h2>
              <span className="dot" /> Pending withdrawals
            </h2>
            {pending.length === 0 && (
              <p className="hint" style={{ marginTop: 0 }}>
                No pending withdrawals. Run a drain from the attacker panel to create one.
              </p>
            )}
            {pending.map((p) => {
              const left = Number(p.unlockTime) - now;
              const done = left <= 0;
              return (
                <div key={p.id.toString()} className={`pending-item ${p.vetoed ? "vetoed" : ""}`}>
                  <div className="row" style={{ borderBottom: "none" }}>
                    <div>
                      <div className="mono" style={{ fontSize: 13 }}>
                        #{p.id.toString()} → {short(p.to, 8)} · {formatEther(p.amount)} ETH
                      </div>
                      <div style={{ marginTop: 6 }}>
                        {p.vetoed ? (
                          <span className="pill vetoed">VETOED · cancelled</span>
                        ) : (
                          <span className="pill pending">PENDING</span>
                        )}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      {!p.vetoed && (
                        <div className={`countdown ${done ? "done" : ""}`}>
                          {done ? "UNLOCKED" : `${left}s`}
                        </div>
                      )}
                      <div className="btnrow" style={{ justifyContent: "flex-end", marginTop: 8 }}>
                        {!p.vetoed && (
                          <button className="primary" onClick={() => veto(p.id)} disabled={!!busy}>
                            {busy === `veto-${p.id}` ? <><span className="spinner" />Signing…</> : "🛡 PQ Veto"}
                          </button>
                        )}
                        <button
                          className="ghost"
                          onClick={() => execute(p.id)}
                          disabled={!!busy || (!done && !p.vetoed)}
                        >
                          {busy === `exec-${p.id}` ? "…" : "Try execute"}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            <div className="btnrow" style={{ marginTop: 6 }}>
              <button className="ghost" onClick={advanceTime} disabled={!!busy}>
                ⏩ Skip timelock (dev)
              </button>
              <button className="ghost" onClick={cutCord} disabled={!!busy || revoked}>
                ✂ Cut the cord (revoke hot key)
              </button>
            </div>
          </div>

          {/* Rotate PQ key (World ID gated) */}
          {gateAddr && (
            <RotatePanel
              client={clientRef.current!}
              gateAddress={gateAddr}
              getSigner={() => signerRef.current!}
              onRotated={(next) => {
                signerRef.current = next;
                setRemaining(next.remaining);
                void refresh();
              }}
              addLog={addLog}
            />
          )}

          {/* Why it needs the alt mempool */}
          <div className="card">
            <h2>
              <span className="dot" /> Why the alt mempool
            </h2>
            <p className="hint" style={{ marginTop: 0 }}>
              Verifying a WOTS+/XMSS signature on-chain costs far more than the public mempool allows.
              EIP-8141 caps validation at 100k gas, so these transactions must use the EF alt mempool.
            </p>
            <div className="gasbar">
              <div className="fill" style={{ width: "100%" }} />
              <div className="cap" style={{ left: `${(100 / 564) * 100}%` }} />
              <div className="label">PQ verify ≈ 564k gas · cap 100k</div>
            </div>
            <p className="hint">
              The veto you sign here runs the same verifier (measured in Foundry). On devnet it goes
              out as a frame transaction: rejected by the public mempool, admitted by the alt mempool.
            </p>
          </div>

          {/* Event log */}
          <div className="card">
            <h2>
              <span className="dot" /> Event log
            </h2>
            <div className="log">
              {log.length === 0 && <div className="line">waiting for actions…</div>}
              {log.map((l, i) => (
                <div key={i} className={`line ${l.kind}`}>
                  <span className="t">{l.t}</span>
                  {l.msg}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <p className="hint" style={{ marginTop: 28, textAlign: "center" }}>
        ETHGlobal Mumbai · post-quantum security · EIP-8141 frame transactions · the keys in this
        local demo are public Anvil dev keys — never real funds.
      </p>
    </div>
  );
}
