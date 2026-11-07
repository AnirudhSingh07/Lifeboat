import { NextResponse } from "next/server";

/**
 * World ID v4 server-side verification for Lifeboat PQ-root rotation.
 *
 * The client (IDKitRequestWidget) returns an IDKitResultV4 payload; we forward it as-is to
 * the v4 verify endpoint keyed by the RP id, then enforce "same unique human" via the
 * RP-scoped nullifier (responses[0].nullifier). World ID is a human-recovery factor only —
 * the PQ signature is still required on-chain.
 *
 * Env: WORLD_RP_ID (or NEXT_PUBLIC_WORLD_RP_ID), WORLD_RP_PRIVATE_KEY (enables the flow).
 */
const RP_ID = process.env.WORLD_RP_ID ?? process.env.NEXT_PUBLIC_WORLD_RP_ID ?? "";
const CONFIGURED = Boolean(RP_ID && process.env.WORLD_RP_PRIVATE_KEY);
const DEFAULT_ACTION = process.env.WORLD_ACTION ?? process.env.NEXT_PUBLIC_WORLD_ACTION ?? "rotate-pq-root";

// Demo-grade enrollment store (resets on restart). Production: persist per vault.
const enrolled = new Map<string, string>(); // action -> nullifier

export async function GET() {
  return NextResponse.json({ configured: CONFIGURED, action: DEFAULT_ACTION, version: "v4" });
}

export async function POST(req: Request) {
  if (!CONFIGURED) return NextResponse.json({ configured: false });

  let body: { payload?: unknown; action?: string; mode?: "enroll" | "rotate" };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, detail: "bad request body" }, { status: 400 });
  }
  const payload = body.payload as
    | { responses?: Array<{ nullifier?: string }>; action?: string }
    | undefined;
  if (!payload) {
    return NextResponse.json({ success: false, detail: "missing proof payload" }, { status: 400 });
  }
  const action = body.action ?? payload.action ?? DEFAULT_ACTION;

  // 1. Verify the proof against the World ID v4 endpoint (forward the payload as-is).
  const res = await fetch(`https://developer.world.org/api/v4/verify/${RP_ID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    return NextResponse.json(
      { success: false, detail: detail?.detail ?? "World ID verification failed", code: detail?.code },
      { status: 200 },
    );
  }

  // 2. Enforce "same unique human" via the RP-scoped nullifier.
  const nullifier = payload.responses?.[0]?.nullifier;
  if (!nullifier) {
    return NextResponse.json({ success: false, detail: "no nullifier in proof" }, { status: 200 });
  }
  if (body.mode === "enroll") {
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
  if (!known) enrolled.set(action, nullifier);

  return NextResponse.json({ success: true, nullifier_hash: nullifier });
}
