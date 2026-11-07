"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createPublicClient,
  formatEther,
  http,
  parseEther,
  type Address,
  type Chain,
  type PublicClient,
} from "viem";
import { anvil, sepolia } from "viem/chains";
import { useAccount, useConnect, useDisconnect, useSwitchChain, useWalletClient } from "wagmi";
import { LifeboatSigner, toHex } from "@lifeboat/pq-signer";
import {
  LifeboatClient,
  deployLifeboatVault,
  deployMockWorldIDGate,
  type PendingWithdrawal,
  type VaultState,
} from "@lifeboat/sdk";
import { LIVE_RPC, LOCAL_RPC } from "../../lib/config";
import dynamic from "next/dynamic";
import {
  addVault,
  cacheKey,
  downloadKeyfile,
  listVaults,
  loadKey,
  type VaultRef,
} from "../../lib/store";

// IDKit (World ID v4) touches browser globals — load it only on the client.
// Typed loosely: props come from idkit-core and we pass them through verbatim.
const IDKitRequestWidget = dynamic(
  () => import("@worldcoin/idkit").then((m) => m.IDKitRequestWidget),
  { ssr: false },
) as unknown as (props: Record<string, unknown>) => JSX.Element | null;
const WORLD_APP_ID = process.env.NEXT_PUBLIC_WORLD_APP_ID ?? "";
const WORLD_ACTION = process.env.NEXT_PUBLIC_WORLD_ACTION ?? "rotate-pq-root";
const WORLD_ENV = (process.env.NEXT_PUBLIC_WORLD_ENV ?? "staging") as "staging" | "production" | "sandbox";

const short = (s?: string, n = 8) => (s ? `${s.slice(0, n + 2)}…${s.slice(-4)}` : "—");
const eth = (wei?: bigint) =>
  wei === undefined ? "—" : Number(formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 6 });
const CHAINS: Record<number, { chain: Chain; rpc: string }> = {
  [sepolia.id]: { chain: sepolia, rpc: LIVE_RPC },
  [anvil.id]: { chain: anvil, rpc: LOCAL_RPC },
};
const publicClientFor = (chainId: number): PublicClient | null => {
  const c = CHAINS[chainId];
  return c ? createPublicClient({ chain: c.chain, transport: http(c.rpc) }) : null;
};

type View = "vaults" | "create" | "dashboard";
type Section = "overview" | "deposit" | "send" | "activity" | "security" | "recovery";
const NAV: { id: Section; label: string; ico: string }[] = [
  { id: "overview", label: "Overview", ico: "◆" },
  { id: "deposit", label: "Deposit", ico: "↓" },
  { id: "send", label: "Send", ico: "↑" },
  { id: "activity", label: "Activity", ico: "≡" },
  { id: "security", label: "Security", ico: "⬡" },
  { id: "recovery", label: "Recovery", ico: "⟳" },
];

export default function AppPage() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { data: walletClient } = useWalletClient();

  const [view, setView] = useState<View>("vaults");
  const [section, setSection] = useState<Section>("overview");
  const [vaults, setVaults] = useState<VaultRef[]>([]);
  const [selected, setSelected] = useState<VaultRef | null>(null);
  const signerRef = useRef<LifeboatSigner | null>(null);
  const [keyLoaded, setKeyLoaded] = useState(false);

  const [label, setLabel] = useState("My Lifeboat");
  const [timelockHours, setTimelockHours] = useState("1");
  const [status, setStatus] = useState("");

  const [state, setState] = useState<VaultState | null>(null);
  const [pending, setPending] = useState<PendingWithdrawal[]>([]);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("0.001");
  const [deposit, setDeposit] = useState("0.01");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [limitInput, setLimitInput] = useState("0.01");
  const [allowInput, setAllowInput] = useState("");
  const [imTo, setImTo] = useState("");
  const [imAmt, setImAmt] = useState("0.001");
  const [beneInput, setBeneInput] = useState("");
  const [inactInput, setInactInput] = useState("2592000");
  const [guardInput, setGuardInput] = useState("");
  const [freezerInput, setFreezerInput] = useState("");
  const [worldAction, setWorldAction] = useState(WORLD_ACTION);
  const [worldOpen, setWorldOpen] = useState(false);
  const [rpContext, setRpContext] = useState<unknown>(null);
  const [worldPreset, setWorldPreset] = useState<unknown>(null);
  const [keyText, setKeyText] = useState("");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => setVaults(listVaults()), []);
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const supported = chainId !== undefined && !!CHAINS[chainId];
  const chainName = chainId ? CHAINS[chainId]?.chain.name ?? `chain ${chainId}` : "";
  const publicClient = useMemo(() => (chainId ? publicClientFor(chainId) : null), [chainId]);

  const readClient = useMemo(
    () => (selected && publicClient ? new LifeboatClient(selected.address, publicClient) : null),
    [selected, publicClient],
  );
  const writeClient = useMemo(
    () =>
      selected && publicClient && walletClient
        ? new LifeboatClient(selected.address, publicClient, walletClient)
        : null,
    [selected, publicClient, walletClient],
  );

  const refresh = useCallback(async () => {
    if (!readClient) return;
    try {
      const [s, p] = await Promise.all([readClient.getState(), readClient.listPending()]);
      setState(s);
      setPending(p);
    } catch (e) {
      setMsg(`Couldn't read the vault: ${(e as Error).message.split("\n")[0]}`);
    }
  }, [readClient]);

  useEffect(() => {
    if (view !== "dashboard") return;
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [view, refresh]);

  function openVault(v: VaultRef) {
    setSelected(v);
    const k = loadKey(v.address);
    signerRef.current = k ? LifeboatSigner.fromSerialized(k) : null;
    setKeyLoaded(!!k);
    setState(null);
    setPending([]);
    setSection("overview");
    setMsg(k ? "" : "No quantum key found for this vault on this device — import it to veto or rotate.");
    setView("dashboard");
  }

  async function createVault() {
    if (!walletClient?.account || !publicClient) return;
    setBusy("create");
    try {
      setStatus("Generating your quantum-safe key in this browser (a few seconds)…");
      await new Promise((r) => setTimeout(r, 60));
      const signer = LifeboatSigner.generate(8);
      setStatus("Confirm in your wallet (1 of 2): deploy the recovery gate…");
      const gate = await deployMockWorldIDGate(walletClient, publicClient, walletClient.account, true);
      setStatus("Confirm in your wallet (2 of 2): deploy your vault…");
      const vault = await deployLifeboatVault(walletClient, publicClient, walletClient.account, {
        hotKey: walletClient.account.address,
        pqRoot: toHex(signer.root),
        pqPubSeed: toHex(signer.pubSeed),
        timelockSeconds: BigInt(Math.round(Number(timelockHours) * 3600)),
        worldIdGate: gate,
      });
      const ref: VaultRef = { address: vault, chainId: chainId!, label: label || "Lifeboat" };
      setVaults(addVault(ref));
      cacheKey(vault, signer.serialize());
      downloadKeyfile(vault, signer.serialize());
      signerRef.current = signer;
      setKeyLoaded(true);
      setSelected(ref);
      setStatus("");
      setSection("overview");
      setView("dashboard");
      setMsg("Vault created. Your recovery file was downloaded — store it safely.");
    } catch (e) {
      setStatus("");
      setMsg(`Create failed: ${(e as Error).message.split("\n")[0]}`);
    } finally {
      setBusy(null);
    }
  }

  const run = (lbl: string, fn: () => Promise<void>) => async () => {
    setBusy(lbl);
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setMsg(`${lbl} failed: ${(e as Error).message.split("\n")[0]}`);
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const persistSigner = () => {
    if (selected && signerRef.current) cacheKey(selected.address, signerRef.current.serialize());
  };
  const needKey = () => {
    if (!signerRef.current) throw new Error("Load your quantum key first");
    return signerRef.current;
  };

  const doDeposit = run("Deposit", async () => {
    const hash = await walletClient!.sendTransaction({
      account: walletClient!.account!,
      chain: walletClient!.chain,
      to: selected!.address,
      value: parseEther(deposit),
    });
    await publicClient!.waitForTransactionReceipt({ hash });
    setMsg(`Deposited ${deposit} ETH`);
  });

  const doRequest = run("Request", async () => {
    const before = await writeClient!.getState();
    const hash = await writeClient!.requestWithdrawal(to as Address, parseEther(amount), "0x");
    await publicClient!.waitForTransactionReceipt({ hash });
    const after = await writeClient!.getState();
    setMsg(
      after.withdrawalCount > before.withdrawalCount
        ? "Withdrawal started — it's timelocked and can be vetoed."
        : `Sent instantly (within your spend policy).`,
    );
  });

  const doVeto = (id: bigint) =>
    run(`Veto`, async () => {
      const { hash } = await writeClient!.veto(id, needKey());
      await publicClient!.waitForTransactionReceipt({ hash });
      persistSigner();
      setMsg(`Vetoed withdrawal #${id}`);
    })();

  const doExecute = (id: bigint) =>
    run(`Execute`, async () => {
      const hash = await writeClient!.executeWithdrawal(id);
      await publicClient!.waitForTransactionReceipt({ hash });
      setMsg(`Completed withdrawal #${id}`);
    })();

  const doInstantMove = run("Instant move", async () => {
    const { hash } = await writeClient!.instantMove(imTo as Address, parseEther(imAmt), needKey());
    await publicClient!.waitForTransactionReceipt({ hash });
    persistSigner();
    setMsg("Funds moved instantly with your quantum key.");
  });
  const doRevoke = run("Revoke", async () => {
    const { hash } = await writeClient!.revokeHotKey(needKey());
    await publicClient!.waitForTransactionReceipt({ hash });
    persistSigner();
    setMsg("Everyday key revoked — it can no longer start withdrawals.");
  });
  const doSetLimit = run("Set limit", async () => {
    const { hash } = await writeClient!.setDailyLimit(parseEther(limitInput), needKey());
    await publicClient!.waitForTransactionReceipt({ hash });
    persistSigner();
    setMsg(`Daily instant limit set to ${limitInput} ETH`);
  });
  const doAllow = run("Allowlist", async () => {
    const { hash } = await writeClient!.setAllowed(allowInput as Address, true, needKey());
    await publicClient!.waitForTransactionReceipt({ hash });
    persistSigner();
    setMsg(`${short(allowInput)} can now receive instant sends`);
  });
  const doSetBeneficiary = run("Set beneficiary", async () => {
    const { hash } = await writeClient!.setBeneficiary(beneInput as Address, needKey());
    await publicClient!.waitForTransactionReceipt({ hash });
    persistSigner();
    setMsg("Beneficiary set");
  });
  const doSetInactivity = run("Set period", async () => {
    const { hash } = await writeClient!.setInactivityPeriod(BigInt(inactInput), needKey());
    await publicClient!.waitForTransactionReceipt({ hash });
    persistSigner();
    setMsg("Inactivity period set");
  });
  const doHeartbeat = run("Heartbeat", async () => {
    const hash = await writeClient!.heartbeat();
    await publicClient!.waitForTransactionReceipt({ hash });
    setMsg("Heartbeat recorded — the inactivity clock is reset.");
  });
  const doAddGuardian = run("Add guardian", async () => {
    const g = needKey();
    const a = await writeClient!.addGuardian(guardInput as Address, g);
    await publicClient!.waitForTransactionReceipt({ hash: a.hash });
    const t = await writeClient!.setGuardianThreshold(1n, g);
    await publicClient!.waitForTransactionReceipt({ hash: t.hash });
    persistSigner();
    setMsg(`Guardian ${short(guardInput)} added (1 signature needed)`);
  });
  const doRotate = run("Rotate", async () => {
    const current = needKey();
    const next = LifeboatSigner.generate(8);
    const { hash } = await writeClient!.rotatePQRoot(toHex(next.root), toHex(next.pubSeed), current, "0x");
    await publicClient!.waitForTransactionReceipt({ hash });
    signerRef.current = next;
    setKeyLoaded(true);
    if (selected) {
      cacheKey(selected.address, next.serialize());
      downloadKeyfile(selected.address, next.serialize());
    }
    setMsg("Quantum key rotated — a new recovery file was downloaded. The old one no longer works.");
  });

  const doSetFreezer = run("Set freezer", async () => {
    const { hash } = await writeClient!.setFreezer(freezerInput as Address, needKey());
    await publicClient!.waitForTransactionReceipt({ hash });
    persistSigner();
    setMsg(`Freezer set to ${short(freezerInput)}`);
  });
  const doUnfreeze = run("Unfreeze", async () => {
    const { hash } = await writeClient!.unfreeze(needKey());
    await publicClient!.waitForTransactionReceipt({ hash });
    persistSigner();
    setMsg("Vault unfrozen — withdrawals can resume.");
  });

  // World ID v4: ask the backend for a signed rp_context, build the proof-of-human preset,
  // then open the IDKit request widget.
  async function beginWorldRotate() {
    setMsg("");
    try {
      const rc = await fetch(`/api/world-rp-context?action=${encodeURIComponent(worldAction)}`).then((r) => r.json());
      if (rc.configured === false || rc.error) {
        setMsg(`World ID not configured: ${rc.error ?? "set WORLD_RP_ID + WORLD_RP_PRIVATE_KEY"}`);
        return;
      }
      const { proofOfHuman } = await import("@worldcoin/idkit");
      setWorldPreset(proofOfHuman({ signal: selected?.address }));
      setRpContext(rc);
      setWorldOpen(true);
    } catch (e) {
      setMsg(`World ID setup failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  // Verify the v4 proof server-side, then rotate.
  async function rotateWithWorldID(result: unknown) {
    setBusy("Rotate");
    setMsg("");
    try {
      const res = await fetch("/api/verify-worldid", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: result, action: worldAction, mode: "rotate" }),
      }).then((r) => r.json());
      if (!res.success) {
        setMsg(`World ID check failed: ${res.detail ?? "not verified"}`);
        return;
      }
      setMsg("World ID verified — rotating…");
    } catch (e) {
      setMsg(`World ID error: ${(e as Error).message.split("\n")[0]}`);
      return;
    } finally {
      setBusy(null);
    }
    await doRotate();
  }

  async function copyText(t: string) {
    try {
      await navigator.clipboard.writeText(t);
      setMsg("Copied");
    } catch {
      setMsg(t);
    }
  }
  function importKeyfile(text: string) {
    try {
      const k = JSON.parse(text);
      signerRef.current = LifeboatSigner.fromSerialized(k);
      setKeyLoaded(true);
      if (selected) cacheKey(selected.address, k);
      setKeyText("");
      setMsg("Quantum key loaded");
    } catch (e) {
      setMsg(`That doesn't look like a valid recovery file: ${(e as Error).message}`);
    }
  }

  const revoked = state?.hotKey === "0x0000000000000000000000000000000000000000";
  const toast = msg ? <div className="toast">{msg}</div> : null;

  // ---------------------------------- onboarding ----------------------------------

  if (!isConnected) {
    return (
      <div className="focused">
        <div className="inner hero">
          <div className="brand" style={{ marginBottom: 30 }}>
            <span className="mark">⬡</span> Lifeboat
          </div>
          <h1>Two keys.<br />One can only ask.<br />One can veto.</h1>
          <p className="lede">
            Your everyday wallet can start a slow, cancelable withdrawal — nothing more. A separate
            quantum-safe key can veto it or move funds instantly. Someone who steals your everyday
            key still can't take your money.
          </p>
          <div className="rule" />
          <div className="actions">
            {connectors.map((c) => (
              <button key={c.uid} className="btn btn-primary btn-lg" onClick={() => connect({ connector: c })} disabled={connecting}>
                {connecting ? <><span className="spinner" />Connecting…</> : `Connect ${c.name}`}
              </button>
            ))}
          </div>
          <p className="field help" style={{ marginTop: 18 }}>Your wallet is your sign-in. No account, no password.</p>
        </div>
        {toast}
      </div>
    );
  }

  if (!supported) {
    return (
      <div className="focused">
        <div className="inner">
          <div className="section-head">
            <h1>Switch network</h1>
            <p>Lifeboat runs on Sepolia (or a local Anvil for testing). Switch your wallet to continue.</p>
          </div>
          <div className="actions">
            <button className="btn btn-primary" onClick={() => switchChain({ chainId: sepolia.id })}>Switch to Sepolia</button>
            <button className="btn btn-quiet" onClick={() => disconnect()}>Disconnect</button>
          </div>
        </div>
        {toast}
      </div>
    );
  }

  const topbar = (
    <header className="topbar">
      <div className="brand"><span className="mark">⬡</span> Lifeboat</div>
      <div className="spacer" />
      <span className="netpill"><span className="led" />{chainName}</span>
      <span className="accountchip" onClick={() => disconnect()} title="Disconnect">{short(address, 6)}</span>
    </header>
  );

  // ---------------------------------- vaults / create ----------------------------------

  if (view !== "dashboard" || !selected) {
    const mine = vaults.filter((v) => v.chainId === chainId);
    return (
      <>
        {topbar}
        <div className="focused" style={{ minHeight: "calc(100vh - 69px)", alignItems: "flex-start", paddingTop: 56 }}>
          <div className="inner" style={{ maxWidth: 520 }}>
            {view === "create" ? (
              <>
                <div className="section-head">
                  <h1>Create a vault</h1>
                  <p>Your connected wallet becomes the everyday key. A quantum-safe key is generated here and saved as a recovery file.</p>
                </div>
                <div className="field">
                  <label htmlFor="name">Vault name</label>
                  <input id="name" value={label} onChange={(e) => setLabel(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="tl">Withdrawal timelock (hours)</label>
                  <input id="tl" value={timelockHours} onChange={(e) => setTimelockHours(e.target.value)} />
                  <div className="help">How long a withdrawal stays cancelable before it can complete.</div>
                </div>
                <div className="banner">Creating deploys your vault on-chain — your wallet will ask you to confirm two transactions.</div>
                <div className="actions">
                  <button className="btn btn-primary" onClick={createVault} disabled={busy === "create"}>
                    {busy === "create" ? <><span className="spinner" />Creating…</> : "Create vault"}
                  </button>
                  <button className="btn btn-quiet" onClick={() => setView("vaults")} disabled={busy === "create"}>Back</button>
                </div>
                {status && <p className="field help" style={{ marginTop: 16 }}>{status}</p>}
              </>
            ) : (
              <>
                <div className="section-head">
                  <h1>Your vaults</h1>
                  <p>Open a vault you control, or create a new one on {chainName}.</p>
                </div>
                {mine.length === 0 ? (
                  <div className="empty">No vaults here yet. Create your first one below.</div>
                ) : (
                  mine.map((v) => (
                    <div key={v.address} className="listrow" style={{ cursor: "pointer" }} onClick={() => openVault(v)}>
                      <div className="meta">
                        {v.label}
                        <div className="sub">{short(v.address, 12)}</div>
                      </div>
                      <span className="tag mute">Open</span>
                    </div>
                  ))
                )}
                <div className="actions" style={{ marginTop: 18 }}>
                  <button className="btn btn-primary" onClick={() => setView("create")}>Create new vault</button>
                  <button className="btn btn-quiet" onClick={() => {
                    const a = prompt("Vault address (0x…) on this network:");
                    if (a && a.startsWith("0x")) openVault({ address: a as Address, chainId: chainId!, label: "Imported vault" });
                  }}>Add existing</button>
                </div>
              </>
            )}
          </div>
        </div>
        {toast}
      </>
    );
  }

  // ---------------------------------- dashboard ----------------------------------

  const keyNeededNote = !keyLoaded && (
    <div className="banner">Load your quantum key (Overview) to veto, move instantly, or change security settings.</div>
  );

  return (
    <div className="shell">
      {topbar}
      <nav className="sidebar">
        {NAV.map((n) => (
          <button key={n.id} className="navitem" aria-current={section === n.id} onClick={() => setSection(n.id)}>
            <span className="ico">{n.ico}</span> {n.label}
          </button>
        ))}
        <div className="vaultswitch">
          <button className="navitem" onClick={() => setView("vaults")}>
            <span className="ico">⇄</span> Switch vault
          </button>
        </div>
      </nav>

      <main className="main">
        {state?.frozen && (
          <div className="banner" style={{ borderLeftColor: "var(--danger)", background: "var(--danger-tint)" }}>
            This vault is <b>frozen</b> — no funds can leave until you unfreeze it (Security → Emergency freeze).
          </div>
        )}
        {section === "overview" && (
          <div className="stack">
            <div className="section-head">
              <h1>{selected.label}</h1>
              <p>Your quantum-veto vault on {chainName}.</p>
            </div>
            <div className="balance">
              <div className="label">Balance</div>
              <div className="amt">{eth(state?.balance)}<span className="unit">ETH</span></div>
            </div>
            <div className="keys">
              <div className="keycard hot">
                <div className="role"><span className="pip" />Everyday key {revoked && <span className="tag danger">revoked</span>}</div>
                <div className="can">Can only start slow, cancelable withdrawals.</div>
                <div className="addr">{short(state?.hotKey, 12)}</div>
              </div>
              <div className="keycard pq">
                <div className="role"><span className="pip" />Quantum-safe key {keyLoaded ? <span className="tag safe">loaded</span> : <span className="tag warn">not loaded</span>}</div>
                <div className="can">Can veto a withdrawal, move funds instantly, or rotate itself.</div>
                <div className="addr">root {short(state?.pqRoot, 12)}</div>
              </div>
            </div>
            <div className="panel">
              <div className="kv"><span className="k">Vault address</span><span className="v copyable" onClick={() => copyText(selected.address)}>{short(selected.address, 12)} ⧉</span></div>
              <div className="kv"><span className="k">Withdrawal timelock</span><span className="v">{state ? `${state.timelock}s` : "—"}</span></div>
              <div className="kv"><span className="k">Instant daily limit</span><span className="v">{eth(state?.dailyLimit)} ETH</span></div>
              <div className="kv"><span className="k">Pending withdrawals</span><span className="v">{pending.length}</span></div>
            </div>
            {!keyLoaded && (
              <div className="panel">
                <h3>Load your quantum key</h3>
                <p className="sub">Paste the recovery file you downloaded when you created this vault. It stays in your browser.</p>
                <div className="field">
                  <input value={keyText} onChange={(e) => setKeyText(e.target.value)} placeholder='{"version":1,"masterSeed":"0x…",…}' />
                </div>
                <div className="actions"><button className="btn btn-primary" onClick={() => importKeyfile(keyText)} disabled={!keyText}>Load key</button></div>
              </div>
            )}
            <div className="actions">
              <button className="btn btn-primary" onClick={() => setSection("deposit")}>Deposit</button>
              <button className="btn" onClick={() => setSection("send")}>Send</button>
            </div>
          </div>
        )}

        {section === "deposit" && (
          <div className="stack">
            <div className="section-head">
              <h1>Deposit</h1>
              <p>Move ETH into the vault. You can also send to the address below from anywhere.</p>
            </div>
            <div className="panel">
              <div className="kv"><span className="k">Vault address</span><span className="v copyable" onClick={() => copyText(selected.address)}>{short(selected.address, 14)} ⧉</span></div>
            </div>
            <div className="panel">
              <h3>Deposit from your wallet</h3>
              <div className="field" style={{ marginTop: 14 }}>
                <label htmlFor="dep">Amount (ETH)</label>
                <input id="dep" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
              </div>
              <div className="actions"><button className="btn btn-primary" onClick={doDeposit} disabled={!!busy}>{busy === "Deposit" ? <><span className="spinner" />Depositing…</> : "Deposit"}</button></div>
            </div>
          </div>
        )}

        {section === "send" && (
          <div className="stack">
            <div className="section-head">
              <h1>Send</h1>
              <p>Start a withdrawal with your everyday key. It completes instantly if it fits your spend policy; otherwise it's timelocked and can be vetoed.</p>
            </div>
            <div className="panel">
              <div className="field">
                <label htmlFor="to">Recipient</label>
                <input id="to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" />
              </div>
              <div className="field">
                <label htmlFor="amt">Amount (ETH)</label>
                <input id="amt" value={amount} onChange={(e) => setAmount(e.target.value)} />
                <div className="help">Instant daily limit: {eth(state?.dailyLimit)} ETH. Above it, the withdrawal is timelocked.</div>
              </div>
              <div className="actions"><button className="btn btn-primary" onClick={doRequest} disabled={!!busy || !to || revoked}>{busy === "Request" ? <><span className="spinner" />Sending…</> : "Request withdrawal"}</button></div>
              {revoked && <p className="field help">The everyday key is revoked — use Instant move (Security) with your quantum key.</p>}
            </div>
          </div>
        )}

        {section === "activity" && (
          <div className="stack">
            <div className="section-head">
              <h1>Activity</h1>
              <p>Pending withdrawals. Veto anything you didn't intend before its timelock ends.</p>
            </div>
            {pending.length === 0 ? (
              <div className="empty">Nothing pending. Withdrawals you start will appear here.</div>
            ) : (
              pending.map((p) => {
                const left = Number(p.unlockTime) - now;
                const done = left <= 0;
                return (
                  <div key={p.id.toString()} className={`listrow ${p.vetoed ? "done" : ""}`}>
                    <div className="meta">
                      #{p.id.toString()} · {eth(p.amount)} ETH → {short(p.to, 8)}
                      <div className="sub">{p.vetoed ? "vetoed" : done ? "timelock elapsed" : "pending"}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      {!p.vetoed && !done && <span className="countdown">{left}s</span>}
                      {!p.vetoed && <button className="btn btn-primary" onClick={() => doVeto(p.id)} disabled={!!busy || !keyLoaded}>Veto</button>}
                      <button className="btn btn-quiet" onClick={() => doExecute(p.id)} disabled={!!busy}>Complete</button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {section === "security" && (
          <div className="stack">
            <div className="section-head">
              <h1>Security</h1>
              <p>Set spending limits, add a guardian, and use your quantum-safe key.</p>
            </div>
            {keyNeededNote}
            <div className="panel">
              <h3>Spend policy</h3>
              <p className="sub">Sends within the daily limit or to allowlisted addresses go through instantly. Everything else is timelocked and can be vetoed.</p>
              <div className="cols">
                <div className="field">
                  <label htmlFor="lim">Daily instant limit (ETH)</label>
                  <input id="lim" value={limitInput} onChange={(e) => setLimitInput(e.target.value)} />
                  <div className="actions" style={{ marginTop: 10 }}><button className="btn btn-primary" onClick={doSetLimit} disabled={!!busy || !keyLoaded}>Set limit</button></div>
                </div>
                <div className="field">
                  <label htmlFor="alw">Allowlist an address</label>
                  <input id="alw" value={allowInput} onChange={(e) => setAllowInput(e.target.value)} placeholder="0x…" />
                  <div className="actions" style={{ marginTop: 10 }}><button className="btn" onClick={doAllow} disabled={!!busy || !keyLoaded || !allowInput}>Allowlist</button></div>
                </div>
              </div>
            </div>
            <div className="panel">
              <h3>Guardian</h3>
              <p className="sub">A guardian (a hardware wallet or a trusted person) can veto withdrawals with an ordinary signature — no quantum key needed. Add more for M-of-N social recovery.</p>
              <div className="kv"><span className="k">Guardians</span><span className="v">{state?.guardianCount.toString() ?? "—"}</span></div>
              <div className="kv"><span className="k">Signatures required</span><span className="v">{state && state.guardianThreshold > 0n ? `${state.guardianThreshold} of ${state.guardianCount}` : "none"}</span></div>
              <div className="field" style={{ marginTop: 14 }}>
                <label htmlFor="g">Add a guardian</label>
                <input id="g" value={guardInput} onChange={(e) => setGuardInput(e.target.value)} placeholder="0x…" />
              </div>
              <div className="actions"><button className="btn btn-primary" onClick={doAddGuardian} disabled={!!busy || !keyLoaded || !guardInput}>Add guardian</button></div>
            </div>
            <div className="panel">
              <h3>Quantum-safe actions</h3>
              <p className="sub">These use your quantum key directly.</p>
              <div className="field">
                <label htmlFor="imt">Instant move — recipient</label>
                <input id="imt" value={imTo} onChange={(e) => setImTo(e.target.value)} placeholder="0x…" />
              </div>
              <div className="field">
                <label htmlFor="ima">Amount (ETH)</label>
                <input id="ima" value={imAmt} onChange={(e) => setImAmt(e.target.value)} />
              </div>
              <div className="actions">
                <button className="btn btn-primary" onClick={doInstantMove} disabled={!!busy || !keyLoaded || !imTo}>Move instantly</button>
                <button className="btn btn-danger" onClick={doRevoke} disabled={!!busy || !keyLoaded || revoked}>Revoke everyday key</button>
              </div>
            </div>
            <div className="panel">
              <h3>Emergency freeze</h3>
              <p className="sub">Designate a freezer bot (your watcher) that can pause all outflow the instant it sees a suspicious withdrawal — it can never move funds. Lifting a freeze needs your quantum key.</p>
              <div className="kv"><span className="k">Status</span><span className="v">{state?.frozen ? <span className="tag danger">frozen</span> : <span className="tag safe">active</span>}</span></div>
              <div className="kv"><span className="k">Freezer</span><span className="v">{state && state.freezer !== "0x0000000000000000000000000000000000000000" ? short(state.freezer, 10) : "none"}</span></div>
              <div className="field" style={{ marginTop: 14 }}>
                <label htmlFor="frz">Freezer address</label>
                <input id="frz" value={freezerInput} onChange={(e) => setFreezerInput(e.target.value)} placeholder="0x… (watcher bot)" />
              </div>
              <div className="actions">
                <button className="btn btn-primary" onClick={doSetFreezer} disabled={!!busy || !keyLoaded || !freezerInput}>Set freezer</button>
                {state?.frozen && <button className="btn" onClick={doUnfreeze} disabled={!!busy || !keyLoaded}>Unfreeze</button>}
              </div>
            </div>
          </div>
        )}

        {section === "recovery" && (() => {
          const armed = !!state && state.inactivityPeriod > 0n;
          const claimableAt = state ? Number(state.lastActivity) + Number(state.inactivityPeriod) : 0;
          const idleLeft = claimableAt - now;
          return (
            <div className="stack">
              <div className="section-head">
                <h1>Recovery</h1>
                <p>Rotate your quantum key, or set a beneficiary who can recover the vault if you go silent.</p>
              </div>
              {keyNeededNote}
              <div className="panel">
                <h3>Rotate quantum key</h3>
                <p className="sub">Generate a fresh quantum key and register it. You'll get a new recovery file; the old one stops working.{WORLD_APP_ID ? " Gated by a World ID human check." : ""}</p>
                {WORLD_APP_ID ? (
                  <>
                    <div className="field">
                      <label htmlFor="wact">World ID action id</label>
                      <input id="wact" value={worldAction} onChange={(e) => setWorldAction(e.target.value)} />
                      <div className="help">Must exactly match an action created in your World Developer Portal for this app.</div>
                    </div>
                    <div className="actions">
                      <button className="btn btn-primary" onClick={beginWorldRotate} disabled={!!busy || !keyLoaded}>
                        {busy === "Rotate" ? <><span className="spinner" />Rotating…</> : "Verify with World ID & rotate"}
                      </button>
                    </div>
                    {rpContext && worldPreset ? (
                      <IDKitRequestWidget
                        open={worldOpen}
                        onOpenChange={setWorldOpen}
                        app_id={WORLD_APP_ID}
                        action={worldAction}
                        rp_context={rpContext}
                        allow_legacy_proofs={false}
                        environment={WORLD_ENV}
                        preset={worldPreset}
                        onSuccess={rotateWithWorldID}
                      />
                    ) : null}
                    <p className="help">Requires the same unique human who set up the vault (matched by nullifier).</p>
                  </>
                ) : (
                  <>
                    <div className="actions"><button className="btn btn-primary" onClick={doRotate} disabled={!!busy || !keyLoaded}>{busy === "Rotate" ? <><span className="spinner" />Rotating…</> : "Rotate key"}</button></div>
                    <p className="help">World ID not configured — set NEXT_PUBLIC_WORLD_APP_ID to gate rotation with a real human check.</p>
                  </>
                )}
              </div>
              <div className="panel">
                <h3>Inheritance</h3>
                <p className="sub">If the vault is untouched for the inactivity period, the beneficiary can claim it. Any activity (including a heartbeat) cancels a pending claim.</p>
                <div className="kv"><span className="k">Beneficiary</span><span className="v">{armed ? short(state!.beneficiary, 10) : "none"}</span></div>
                {armed && <div className="kv"><span className="k">Status</span><span className="v">{idleLeft > 0 ? `claimable in ${idleLeft}s` : "claimable now"}</span></div>}
                <div className="cols" style={{ marginTop: 14 }}>
                  <div className="field">
                    <label htmlFor="ben">Beneficiary address</label>
                    <input id="ben" value={beneInput} onChange={(e) => setBeneInput(e.target.value)} placeholder="0x…" />
                    <div className="actions" style={{ marginTop: 10 }}><button className="btn btn-primary" onClick={doSetBeneficiary} disabled={!!busy || !keyLoaded || !beneInput}>Set beneficiary</button></div>
                  </div>
                  <div className="field">
                    <label htmlFor="ina">Inactivity period (seconds)</label>
                    <input id="ina" value={inactInput} onChange={(e) => setInactInput(e.target.value)} />
                    <div className="actions" style={{ marginTop: 10 }}>
                      <button className="btn" onClick={doSetInactivity} disabled={!!busy || !keyLoaded}>Set period</button>
                      <button className="btn btn-quiet" onClick={doHeartbeat} disabled={!!busy}>Heartbeat</button>
                    </div>
                  </div>
                </div>
                <p className="help">The beneficiary claims from their own wallet once the vault is idle long enough.</p>
              </div>
            </div>
          );
        })()}
      </main>
      {toast}
    </div>
  );
}
