"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { LifeboatSigner, toHex } from "@lifeboat/pq-signer";
import { LifeboatClient, mockWorldIDGateAbi } from "@lifeboat/sdk";
import { DEMO_TREE_HEIGHT, hotAccount, publicClient, walletClient } from "../lib/chain";

// IDKit touches browser APIs — load it only on the client, only when configured.
const IDKitWidget = dynamic(() => import("@worldcoin/idkit").then((m) => m.IDKitWidget), {
  ssr: false,
});

const APP_ID = process.env.NEXT_PUBLIC_WORLD_APP_ID ?? "";
const ACTION = process.env.NEXT_PUBLIC_WORLD_ACTION ?? "rotate-pq-root";

type LogKind = "info" | "ok" | "bad" | "";

interface Props {
  client: LifeboatClient;
  gateAddress: Address;
  getSigner: () => LifeboatSigner;
  onRotated: (s: LifeboatSigner) => void;
  addLog: (msg: string, kind?: LogKind) => void;
}

export function RotatePanel({ client, gateAddress, getSigner, onRotated, addLog }: Props) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Ask the server whether a World ID app id is wired up.
    fetch("/api/verify-worldid")
      .then((r) => r.json())
      .then((d) => setConfigured(Boolean(d.configured) && Boolean(APP_ID)))
      .catch(() => setConfigured(false));
  }, []);

  async function setGatePass(pass: boolean) {
    const hash = await walletClient.writeContract({
      account: hotAccount,
      chain: walletClient.chain,
      address: gateAddress,
      abi: mockWorldIDGateAbi,
      functionName: "setShouldPass",
      args: [pass],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  /** Generate a fresh tree and rotate the vault to it (signed by the CURRENT PQ key). */
  async function doRotate(): Promise<LifeboatSigner> {
    setStatus("Generating a fresh post-quantum tree…");
    await new Promise((r) => setTimeout(r, 60));
    const next = LifeboatSigner.generate(DEMO_TREE_HEIGHT);
    setStatus("Submitting rotation (signed by your current PQ key)…");
    const { hash, leafIndex } = await client.rotatePQRoot(
      toHex(next.root),
      toHex(next.pubSeed),
      getSigner(),
      "0x" as Hex,
    );
    await publicClient.waitForTransactionReceipt({ hash });
    addLog(`🔑 PQ root rotated (signed with leaf #${leafIndex}) — new tree is live`, "ok");
    return next;
  }

  // --- Simulated path (no app id): demonstrate both on-chain gate outcomes locally ---
  async function simulate(valid: boolean) {
    setBusy(true);
    try {
      await setGatePass(valid);
      if (valid) {
        addLog("World ID (simulated): enrolled human verified ✓", "info");
        const next = await doRotate();
        onRotated(next);
        setStatus("Rotated.");
      } else {
        addLog("World ID (simulated): different human — expect on-chain rejection", "info");
        try {
          await doRotate();
          setStatus("Unexpectedly succeeded.");
        } catch {
          addLog("🚫 rotatePQRoot reverted (WorldIDCheckFailed) — rotation blocked", "bad");
          setStatus("Rejected by the World ID gate, as expected.");
        }
        await setGatePass(true); // restore for the next attempt
      }
    } catch (e) {
      addLog(`rotation error: ${(e as Error).message.split("\n")[0]}`, "bad");
    } finally {
      setBusy(false);
    }
  }

  // --- Real path (app id configured): IDKit proof → server verify → rotate ---
  async function onIDKitSuccess(payload: unknown) {
    setBusy(true);
    try {
      setStatus("Verifying World ID proof server-side…");
      const res = await fetch("/api/verify-worldid", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload, action: ACTION, mode: "rotate" }),
      }).then((r) => r.json());

      if (!res.success) {
        addLog(`🚫 World ID rejected: ${res.detail ?? "verification failed"}`, "bad");
        setStatus(`Rejected: ${res.detail ?? "verification failed"}`);
        return;
      }
      addLog(`World ID verified (nullifier ${String(res.nullifier_hash).slice(0, 10)}…) ✓`, "info");
      const next = await doRotate();
      onRotated(next);
      setStatus("Rotated.");
    } catch (e) {
      addLog(`rotation error: ${(e as Error).message.split("\n")[0]}`, "bad");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>
        <span className="dot" /> Rotate PQ key · World ID gated
      </h2>
      <p className="hint" style={{ marginTop: 0 }}>
        The one irreversible admin action. Gated by a fresh World ID proof (same unique human)
        <b> on top of</b> the PQ signature — never World ID alone.
      </p>

      {configured === null && <p className="hint">checking World ID configuration…</p>}

      {configured === true && (
        <div className="btnrow">
          <IDKitWidget
            app_id={APP_ID as `app_${string}`}
            action={ACTION}
            verification_level={"device" as never}
            onSuccess={onIDKitSuccess}
          >
            {({ open }: { open: () => void }) => (
              <button className="primary" onClick={open} disabled={busy}>
                {busy ? <><span className="spinner" />Working…</> : "Verify with World ID & rotate"}
              </button>
            )}
          </IDKitWidget>
        </div>
      )}

      {configured === false && (
        <>
          <div className="pill armed" style={{ marginBottom: 10 }}>
            World ID not configured — simulated gate
          </div>
          <p className="hint" style={{ marginTop: 0 }}>
            Set <span className="mono">NEXT_PUBLIC_WORLD_APP_ID</span> +{" "}
            <span className="mono">WORLD_APP_ID</span> to use the real IDKit widget and the
            Developer Portal verify. Meanwhile, exercise both on-chain gate outcomes:
          </p>
          <div className="btnrow">
            <button className="primary" onClick={() => simulate(true)} disabled={busy}>
              {busy ? "…" : "Rotate as enrolled human ✓"}
            </button>
            <button className="danger" onClick={() => simulate(false)} disabled={busy}>
              Rotate as different human ✗
            </button>
          </div>
        </>
      )}

      {status && <p className="hint">{status}</p>}
    </div>
  );
}
