description: Columns named "Cid" across downstream apps store a bare hash, not a real interoperable content identifier; add SQL/JS functions that produce self-describing CIDs (the format IPFS and other content-addressed stores understand) so those columns can hold genuine, upgrade-safe addresses.
prereq: none
files:
  - packages/quereus-plugin-crypto/src/crypto.ts
  - packages/quereus-plugin-crypto/src/plugin.ts
  - packages/quereus-plugin-crypto/src/index.ts
  - packages/quereus-plugin-crypto/README.md
  - packages/quereus-plugin-crypto/docs/crypto.md
  - packages/db-core/src/utility/hash-string.ts
  - packages/db-core/src/utility/block-id-to-bytes.ts
difficulty: medium
----

## Problem

`digest()` (`crypto.ts` — `digest` / `digestFields`) returns a **bare hash**: the raw
digest bytes of a framed field-tuple, encoded as base64url (or hex/base64). It carries:

- **no multibase prefix** — the consumer cannot tell from the value which base it is in;
- **no multicodec** — nothing says whether the addressed bytes are `raw`, `dag-cbor`, etc.;
- **no multihash framing** (`hashFnCode ‖ digestLength ‖ digestBytes`) — the hash algorithm
  is bound at plugin-registration time (`plugin.ts` `configAlgorithm`), so it is *not* recorded
  in the value. There is no algorithm agility: a value cannot be unambiguously migrated from
  sha2-256 to another hash because nothing in it identifies sha2-256.

Note the existing `0x01` `DIGEST_FORMAT_V1` byte is domain separation prepended to the
**input before hashing**; it is not a self-describing prefix on the **output**.

Consequence: downstream schemas that name columns `Cid` (per the proposal, VoteTorrent has
~29 such columns) are not storing IPFS/IPLD CIDs. The stored value will not match the CID any
content-addressed store computes for the same bytes, and it is not interoperable or
upgrade-safe. This is most cheaply corrected **before more signed records commit to the bare
form**, since signed/persisted records freeze the chosen representation.

## Request

Add a SQL UDF (and matching JS export) that produces a self-describing CIDv1:

```
CIDv1     = multibase( version ‖ multicodec(content-type) ‖ multihash )
multihash = hashFnCode ‖ digestLength ‖ digestBytes
```

with selectable multicodec (e.g. `raw`, `dag-cbor`), multihash code
(`sha2-256` / `sha2-512` / `blake3`), and multibase (default `base32`), plus round-trip
decode helpers so schemas can validate and migrate.

The input is a **single blob**. Combining multiple fields into that blob stays the caller's
job — exactly the contract `digest()` already owns. The CID layer is purely the
multihash + CIDv1 framing on top of one already-decided byte string.

## Desirable shape (interfaces — settle exact names/return shapes in plan)

JS exports (`crypto.ts` / re-exported from `index.ts`):

```ts
type Multicodec   = 'raw' | 'dag-cbor';            // extensible
type MultihashCode = 'sha2-256' | 'sha2-512' | 'blake3';
type Multibase    = 'base32' | 'base58btc' | 'base64url' | 'base16';

// Hash `data`, wrap the digest in a multihash, frame as CIDv1, encode in `base`.
function cid(
  data: Uint8Array,
  codec?: Multicodec,        // default 'raw'
  hash?: MultihashCode,      // default 'sha2-256'
  base?: Multibase,          // default 'base32'
): string;

// Lower-level: wrap an ALREADY-computed digest (caller asserts which `hash` produced it).
function cidV1(
  digest: Uint8Array,
  hash: MultihashCode,
  codec?: Multicodec,
  base?: Multibase,
): string;

// Round-trip: parse a CID string back to its parts (for schema validation / migration).
function cidDecode(cid: string): {
  version: number;            // 1
  codec: Multicodec | number;
  hashCode: MultihashCode | number;
  digest: Uint8Array;
};
```

SQL surface (registered in `plugin.ts`, same `replicable: true` + deterministic flags as
`digest`):

```
cid(data BLOB, codec? TEXT, hash? TEXT, base? TEXT) -> TEXT          -- hash then frame
cid_v1(digest BLOB, hash TEXT, codec? TEXT, base? TEXT) -> TEXT      -- frame a given digest
cid_decode(cid TEXT) -> JSON                                         -- { version, codec, hashCode, digest }
```

Composition with the existing digest framing — a `Cid` column over several fields becomes:

```sql
-- one self-describing, interoperable content address over a field tuple
cid(digest(col_a, col_b, col_c, 'bytes'))   -- digest must expose a BLOB/'bytes' output for SQL
```

## Reuse, don't hand-roll (key constraint)

`multiformats@^13.4.2` is **already a workspace dependency** (`packages/db-core`,
`packages/db-p2p`) and is the canonical, audited implementation of `CID`, multihash,
multibase, and multicodec. The crypto plugin does not depend on it yet, but should — adding
the dep is trivial and per AGENTS.md ("no half-baked janky parsers; use a full-fledged
parser") the framing/parsing must come from `multiformats`, not bespoke byte-pushing.
`CID.create` / `CID.decode`, `multiformats/hashes/sha2`, and `multiformats/bases/*` cover
almost the whole surface.

**blake3 caveat:** core `multiformats` ships sha2-256/512 hashers and base32/base58/base64
bases but **not blake3**. The plugin already imports `blake3` from `@noble/hashes`; supporting
`blake3` as a multihash code means wrapping it as a `MultihashHasher` with the registered
blake3 multicodec (`0x1e`) — call this out so the implementer doesn't assume it is built in.

## Open questions (resolve in plan, or escalate the first one)

- **Default multibase.** The proposal defaults to `base32` (IPFS/IPLD convention). Optimystic's
  own content addressing deliberately uses bare **base64url** (`hash-string.ts`,
  `block-id-to-bytes.ts`, `BlockId`). These functions are a *downstream interop* surface, not
  Optimystic's internal block IDs, so `base32` is defensible — but the divergence from the
  in-repo convention is a deliberate choice that wants sign-off, and it interacts with the
  VoteTorrent "Option B" decision referenced in the proposal. This is the question most likely
  to need human/downstream coordination before implementation.
- **`cid_decode` return shape.** A single JSON object (Quereus has native JSON) vs. separate
  scalar accessors (`cid_version` / `cid_codec` / `cid_hash_code` / `cid_digest`). JSON is the
  leaner default; confirm in plan.
- **`digest` BLOB output for SQL.** Today the SQL `digest` only emits text encodings
  (`plugin.ts` `DIGEST_TEXT_ENCODINGS`). For `cid(digest(...))` to compose without a base64
  round-trip, SQL `digest` likely needs a `'bytes'`/BLOB output path, or `cid` needs to accept
  a base64url-text digest. Decide which.
- **Scope of column migration.** Whether/how existing `Cid` columns migrate is a downstream
  (VoteTorrent / sereus) schema decision, not owned here; this ticket only delivers the
  primitive that makes the migration possible.

## Relationship to other work

Adjacent to but distinct from `crypto-digest-variadic-breaks-downstream-callers` (also
backlog): that ticket is about the breaking change to `digest()`'s *call signature* and the
downstream migration it forces; this one adds a *new* CID primitive layered on top of (not
replacing) `digest`. They share the same published package and the same downstream consumers,
so a plan pass may want to sequence them together when coordinating the downstream migration —
but neither hard-depends on the other.

## Use cases

- A `Cid` column whose value is the real, interoperable CIDv1 an external content-addressed
  store (IPFS/IPLD) would compute for the same bytes.
- Schema validation: `cid_decode(value)` confirms a stored value is a well-formed CIDv1 with an
  expected codec/hash before trusting it.
- Algorithm migration: because the multihash code is in the value, a future re-address from
  sha2-256 to another hash is unambiguous and detectable rather than a silent reinterpretation.

## Edge cases & interactions

- Determinism / replicability: `cid` / `cid_v1` must be `replicable: true` and byte-identical
  across peers and platforms — these values are signed and persisted, same bar as `digest`.
- Unknown/garbage input to `cid_decode` must error cleanly (not silently mis-frame), consistent
  with the plugin's existing "exceptions should be exceptional" stance.
- `cid_v1(digest, hash, …)` trusts the caller's asserted `hash` and `digestLength`; a mismatch
  between the asserted code and the actual digest length should be rejected.
- Cross-platform: must work under Node, browser, and React Native (the plugin's existing
  constraint) — confirm `multiformats` bases/hashers used carry no Node-only assumptions.
