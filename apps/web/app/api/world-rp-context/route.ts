import { NextResponse } from "next/server";
import { signRequest } from "@worldcoin/idkit-server";

/**
 * World ID v4: the client needs a signed "rp_context" (relying-party context) to build a
 * proof request. We sign it here with the RP private key — it never reaches the browser.
 *
 * Env: WORLD_RP_ID (or NEXT_PUBLIC_WORLD_RP_ID), WORLD_RP_PRIVATE_KEY, [WORLD_ACTION].
 */
const RP_ID = process.env.WORLD_RP_ID ?? process.env.NEXT_PUBLIC_WORLD_RP_ID ?? "";
const RP_KEY = process.env.WORLD_RP_PRIVATE_KEY ?? "";
const DEFAULT_ACTION = process.env.WORLD_ACTION ?? process.env.NEXT_PUBLIC_WORLD_ACTION ?? "rotate-pq-root";

export async function GET(req: Request) {
  if (!RP_ID || !RP_KEY) {
    return NextResponse.json({ configured: false });
  }
  const action = new URL(req.url).searchParams.get("action") ?? DEFAULT_ACTION;
  try {
    const { sig, nonce, createdAt, expiresAt } = signRequest({
      signingKeyHex: RP_KEY,
      action,
      ttl: 300,
    });
    return NextResponse.json({
      rp_id: RP_ID,
      nonce,
      created_at: createdAt,
      expires_at: expiresAt,
      signature: sig,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
