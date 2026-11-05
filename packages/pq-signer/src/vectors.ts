/**
 * Generates deterministic cross-check vectors for the Solidity verifier.
 * Run: `pnpm --filter @lifeboat/pq-signer vectors`
 * Output: packages/contracts/test/vectors/wots_vectors.json
 *
 * Height defaults to 10 (the production tree). Override with VECTOR_HEIGHT for a
 * faster dev loop, but the committed vectors should be regenerated at height 10.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { keccak, toHex, fromHex } from "./bytes.js";
import { LifeboatSigner, sigToHex } from "./signer.js";

const HEIGHT = Number(process.env.VECTOR_HEIGHT ?? 10);

const masterSeed = toHex(keccak(new TextEncoder().encode("lifeboat-vector-master-v1")));
const pubSeed = toHex(keccak(new TextEncoder().encode("lifeboat-vector-pub-v1")));

const signer = LifeboatSigner.fromSerialized({
  version: 1,
  height: HEIGHT,
  masterSeed,
  pubSeed,
  root: "0x",
  nextLeafIndex: 0,
});

function vector(label: string, digestLabel: string, leafIndex: number) {
  const digest = keccak(new TextEncoder().encode(digestLabel));
  const s = sigToHex(signer.signWithLeaf(digest, leafIndex));
  return { label, digest: toHex(digest), ...s };
}

const good = [
  vector("leaf0", "lifeboat demo veto #1", 0),
  vector("leaf7", "lifeboat instant move to rescue", 7),
  vector("leafMax", "lifeboat edge leaf", (1 << HEIGHT) - 1),
];

// Negative vector: a valid signature with one corrupted chain value.
const tampered = (() => {
  const v = structuredClone(good[0]!);
  const bad = fromHex(v.sig[0]!);
  bad[0] ^= 0xff;
  v.sig[0] = toHex(bad);
  v.label = "tampered";
  return v;
})();

const out = {
  spec: "lifeboat-pq-v1",
  height: HEIGHT,
  pubSeed,
  root: toHex(signer.root),
  good,
  tampered,
};

const target = resolve(process.cwd(), "../contracts/test/vectors/wots_vectors.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${good.length} good + 1 tampered vector(s) at height ${HEIGHT} → ${target}`);
console.log(`root: ${out.root}`);
