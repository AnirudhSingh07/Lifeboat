import { NextResponse } from "next/server";

/**
 * Server-side World ID verification for Lifeboat's PQ-root rotation.
 *
 * Verifies the IDKit proof against the World Developer Portal v2 API, then enforces the
 * "same unique human" rule: the first successful proof enrolls a nullifier; later
 * rotations must present the SAME nullifier (deterministic per person for a fixed action).
 *
 * World ID is a human-recovery factor only — the PQ signature is still required on-chain.
 *
 * Env: WORLD_APP_ID (or NEXT_PUBLIC_WORLD_APP_ID), WORLD_ACTION (default "rotate-pq-root").
 * If no app id is configured, responds { configured: false } so the UI falls back to a
 * clearly-labelled simulated gate for local demos.
 */

const APP_ID = process.env.WORLD_APP_ID ?? process.env.NEXT_PUBLIC_WORLD_APP_ID ?? "";
const DEFAULT_ACTION = process.env.WORLD_ACTION ?? "rotate-pq-root";

// Demo-grade enrollment store (resets on server restart). Production: persist per vault.
const enrolled = new Map<string, string>(); // action -> nullifier_hash

interface IDKitProof {
  merkle_root: string;
  nullifier_hash: string;
  proof: string;
  verification_level: string;
}

export async function POST(req: Request) {
  if (!APP_ID) {
    return NextResponse.json({ configured: false });
  }

  let body: { payload?: IDKitProof; action?: string; signal?: string; mode?: "enroll" | "rotate" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, detail: "bad request body" }, { status: 400 });
  }

  const { payload, signal, mode = "rotate" } = body;
  const action = body.action ?? DEFAULT_ACTION;
  if (!payload) {
    return NextResponse.json({ success: false, detail: "missing proof payload" }, { status: 400 });
  }

  // 1. Verify the proof with the Developer Portal.
  const res = await fetch(`https://developer.worldcoin.org/api/v2/verify/${APP_ID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nullifier_hash: payload.nullifier_hash,
      merkle_root: payload.merkle_root,
      proof: payload.proof,
      verification_level: payload.verification_level,
      action,
      signal_hash: signal,
    }),
  });

  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    return NextResponse.json(
      { success: false, detail: detail?.detail ?? "World ID verification failed", code: detail?.code },
      { status: 200 },
    );
  }

  const nullifier = payload.nullifier_hash;

  // 2. Enforce "same unique human".
  if (mode === "enroll") {
    enrolled.set(action, nullifier);
    return NextResponse.json({ success: true, enrolled: true, nullifier_hash: nullifier });
  }

  const known = enrolled.get(action);
  if (known && known !== nullifier) {
    return NextResponse.json(
      { success: false, detail: "not the enrolled human (nullifier mismatch)" },
      { status: 200 },
    );
  }
  if (!known) enrolled.set(action, nullifier); // first rotate also enrolls

  return NextResponse.json({ success: true, nullifier_hash: nullifier });
}

export async function GET() {
  return NextResponse.json({ configured: Boolean(APP_ID), action: DEFAULT_ACTION });
}
