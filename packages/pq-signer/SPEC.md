# Lifeboat PQ signature scheme — v1

A keccak-based **WOTS+** one-time signature with an **XMSS**-style Merkle tree.
This document is the single source of truth: the TypeScript signer
(`packages/pq-signer`) and the Solidity verifier (`packages/contracts`) MUST agree
byte-for-byte with everything below.

> **Why keccak256?** Real XMSS (RFC 8391) uses SHA-256. We use `keccak256` because
> it is a native EVM opcode and ~1–2 orders of magnitude cheaper on-chain. keccak256
> is a strong cryptographic hash, so the hash-based security argument is unchanged.
> Swapping in SHA-256 (via a precompile) or Falcon (EIP-8052) is future work.

## Parameters

| symbol | value | meaning |
|--------|-------|---------|
| `n`    | 32    | hash output length in bytes (keccak256) |
| `w`    | 16    | Winternitz parameter |
| `logw` | 4     | log2(w), bits per base-w digit |
| `len1` | 64    | message digits = ceil(8n / logw) = 256/4 |
| `len2` | 3     | checksum digits (max checksum 64·15 = 960 = 0x3C0 fits in 3 nibbles) |
| `len`  | 67    | total WOTS chains = len1 + len2 |
| `h`    | 10    | Merkle tree height → 2^10 = 1024 one-time keys |

`H(x) = keccak256(x)`.

## 1. Chaining function

Keys and bitmasks are derived from a public, per-tree 32-byte `pubSeed` and a
compact address `(chainIndex, hashIndex)`:

```
PRF(domain, chainIndex, hashIndex) =
    keccak256( pubSeed(32) ‖ domain(1 byte) ‖ chainIndex(1 byte) ‖ hashIndex(1 byte) )

chainStep(x, chainIndex, hashIndex):
    key = PRF(0x00, chainIndex, hashIndex)
    bm  = PRF(0x01, chainIndex, hashIndex)
    return keccak256( key(32) ‖ (x XOR bm)(32) )     // 64-byte preimage
```

`chain(x, start, steps, chainIndex)` applies `chainStep` `steps` times, using
`hashIndex = start, start+1, …, start+steps-1`:

```
chain(x, start, steps, chainIndex):
    for j in [0, steps):
        x = chainStep(x, chainIndex, start + j)
    return x
```

`chainIndex` ranges 0..66 (fits one byte). `hashIndex` ranges 0..14 (fits one byte).

## 2. Message → base-w digits (with checksum)

Given a 32-byte `digest`:

1. `msgDigits[0..63]`: for each byte `digest[k]`, emit high nibble then low nibble
   (MSB-first): `msgDigits[2k] = digest[k] >> 4`, `msgDigits[2k+1] = digest[k] & 0xF`.
2. `C = Σ (w-1 - msgDigits[i])` for i in 0..63   (0 ≤ C ≤ 960).
3. `csumDigits[0..2]` = C as 3 base-16 digits, **MSB-first**:
   `[ (C >> 8) & 0xF, (C >> 4) & 0xF, C & 0xF ]`.
4. `d[0..66] = msgDigits ‖ csumDigits`.

(We deliberately use a plain MSB-first base-16 encoding rather than RFC 8391's
left-shift; both sides use the identical convention, so the checksum's forgery
protection is preserved.)

## 3. WOTS+ keys, signature, leaf

- Secret: `sk[i]` = 32 random bytes, i in 0..66.
- Public chain end: `pk[i] = chain(sk[i], 0, w-1, i)`  (15 steps, hashIndex 0..14).
- **Leaf** (WOTS+ public key commitment):
  `L = keccak256( pubSeed(32) ‖ pk[0] ‖ pk[1] ‖ … ‖ pk[66] )`.
- **Signature** for digit vector `d`: `sig[i] = chain(sk[i], 0, d[i], i)`.

### Verification of a WOTS+ signature
```
for i in 0..66:
    pk'[i] = chain(sig[i], d[i], (w-1) - d[i], i)   // continue chain to the top
L' = keccak256( pubSeed ‖ pk'[0] ‖ … ‖ pk'[66] )
```
`L'` is then checked against the Merkle root (section 4).

## 4. XMSS Merkle tree

- Leaves `L[0..2^h-1]`, one per one-time key.
- Internal node: `parent = keccak256( left(32) ‖ right(32) )` (index-based, **not**
  sorted pairs).
- Authentication path `authPath[0..h-1]` = sibling at each level, bottom-up.

### Merkle verification
```
node = L'
idx  = leafIndex
for level in 0..h-1:
    sib = authPath[level]
    node = (idx & 1 == 0) ? keccak256(node ‖ sib) : keccak256(sib ‖ node)
    idx >>= 1
require(node == root)   // root == vault.pqRoot
```

## 5. On-chain action binding & one-time-key enforcement

The 32-byte `digest` that gets signed is computed by the vault from the action, so
that a signature authorizing one action cannot be replayed for another:

```
digest = keccak256(abi.encode(
    DOMAIN,            // bytes32 domain separator, fixed per deployment
    block.chainid,     // uint256
    address(this),     // vault address
    actionType,        // uint8 (VETO=1, INSTANT_MOVE=2, REVOKE_HOT=3, ROTATE_ROOT=4)
    actionParamsHash,  // keccak256 of the ABI-encoded action params
    leafIndex          // uint32 — binds the sig to exactly one one-time key
))
```

The vault keeps a used-leaf bitmap. A PQ action:
1. recomputes `digest` from the submitted action + `leafIndex`,
2. runs WOTS+ + Merkle verification against `(pqRoot, pqPubSeed)`,
3. requires `leafIndex` unused, then marks it used,
4. executes the action.

Reusing a leaf, a bad signature, or a signature bound to a different action all fail.

## 6. Serialized signature layout (ABI)

`PQSignature` passed to the vault / verifier:

| field      | type        | notes |
|------------|-------------|-------|
| leafIndex  | `uint32`    | which one-time key |
| sig        | `bytes32[67]` | WOTS+ chain values |
| authPath   | `bytes32[10]` | Merkle siblings bottom-up |

`pubSeed` and `pqRoot` live in vault storage (set at setup / rotation), so they are
not part of the transmitted signature.
