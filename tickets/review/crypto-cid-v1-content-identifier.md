description: New SQL/JS functions in the crypto plugin produce real, self-describing content identifiers (the CIDv1 format IPFS understands) so that columns named "Cid" can hold genuine interoperable addresses instead of bare hashes.
prereq: none
files:
  - packages/quereus-plugin-crypto/src/cid.ts        (new — cid/cidV1/cidDecode)
  - packages/quereus-plugin-crypto/src/plugin.ts      (cid/cid_v1/cid_decode SQL UDFs + toContentBytes)
  - packages/quereus-plugin-crypto/src/index.ts        (re-exports)
  - packages/quereus-plugin-crypto/package.json        (multiformats dep, provides, keywords)
  - packages/quereus-plugin-crypto/test/cid.spec.ts   (new — 19 tests)
  - packages/quereus-plugin-crypto/README.md
  - packages/quereus-plugin-crypto/docs/crypto.md
difficulty: medium
----

## What was built

A self-describing CIDv1 layer on top of the existing bare-hash `digest`, delivered as
both JS exports and SQL UDFs. All framing/parsing is delegated to the audited
`multiformats` library (newly added dep, `^14.0.0`); the hashing reuses the plugin's
existing synchronous `@noble/hashes` functions via `resolveHasher`.

```
CIDv1     = multibase( version ‖ multicodec(content-type) ‖ multihash )
multihash = hashFnCode ‖ digestLength ‖ digestBytes
```

JS API (`src/cid.ts`, re-exported from `index.ts`):

```ts
cid(data: Uint8Array, codec?='raw', hash?='sha2-256', base?='base32'): string   // hash then frame
cidV1(digest: Uint8Array, hash, codec?='raw', base?='base32'): string           // frame a given digest, no re-hash
cidDecode(cid: string): { version, codec, hashCode, digest: Uint8Array }        // parse / validate
```

SQL surface (`src/plugin.ts`, all `replicable: true` + `DETERMINISTIC_FLAGS`, same bar as `digest`):

```
cid(data BLOB|b64url-TEXT, codec? TEXT, hash? TEXT, base? TEXT) -> TEXT
cid_v1(digest BLOB|b64url-TEXT, hash TEXT, codec? TEXT, base? TEXT) -> TEXT
cid_decode(cid TEXT) -> JSON TEXT  { version, codec, hashCode, digest(base64url) }
```

Selectable: `codec` ∈ {`raw` 0x55, `dag-cbor` 0x71}; `hash` ∈ {`sha2-256` 0x12,
`sha2-512` 0x13, `blake3` 0x1e}; `base` ∈ {`base32` (default), `base58btc`,
`base64url`, `base16`}.

## How the open questions were resolved (please sanity-check these decisions)

1. **`cid_decode` return shape → single JSON object** (per the ticket's "JSON is the
   leaner default"). Digest is projected as base64url TEXT inside the JSON, matching the
   plugin's canonical text encoding. Codec/hash are friendly names when recognized, else
   the raw numeric code.

2. **`digest` was NOT given a SQL `'bytes'`/BLOB output path.** The ticket's open
   question and its `cid(digest(col_a, col_b, col_c, 'bytes'))` example are both
   problematic: SQL `digest` is variadic-over-data with no per-call encoding arg (a
   trailing `'bytes'` would be parsed as a *data field*), and `cid(x)` *hashes* `x`, so
   `cid(digest(...))` would hash-the-hash (double hashing). **Resolution:** `cid`/`cid_v1`
   accept the data/digest argument as a BLOB **or** a base64url-TEXT string (the plugin's
   canonical encoding — exactly what SQL `digest` returns). The intended multi-field
   composition is therefore:

   ```sql
   cid_v1(digest(col_a, col_b, col_c), 'sha2-256')   -- wrap the digest, don't re-hash it
   ```

   `digest` does the canonical multi-field framing + hashing; `cid_v1` adds the
   multihash/CIDv1/multibase envelope around that exact digest (no double hash, no
   `digest` change). The asserted hash (`'sha2-256'`) must match the algorithm `digest`
   was configured with at load time. **Reviewer: confirm this is the intended semantics
   for `Cid` columns — i.e. that the CID's multihash digest equals the field-tuple digest,
   not a hash of it.**

3. **Module placement:** functions live in a new `src/cid.ts` rather than appended to
   `crypto.ts` (which the ticket listed). Rationale: `crypto.ts` is already ~540 lines and
   AGENTS.md favors small, single-purpose modules; this also isolates the `multiformats`
   import. `cid.ts` depends one-way on `crypto.ts` (`resolveHasher`). Flag if you want it
   folded back into `crypto.ts`.

## Key correctness facts to verify

- **Interop is real, not approximate.** `cid(utf8('hello world'))` ==
  `bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e` — the publicly
  verifiable IPFS CID for raw "hello world". The composed path (noble digest →
  `Digest.create(code, bytes)` → `CID.createV1`) was checked byte-identical to
  multiformats' own (async) `sha256.digest()` hasher path. This golden vector is locked
  in a test, so a silent framing change fails loudly.
- **blake3 is handled without a `MultihashHasher` wrapper.** Because every digest is
  computed with `@noble/hashes` and only *framed* by multiformats (`Digest.create` with
  the blake3 code `0x1e`), the "multiformats has no blake3 hasher" caveat never bites.
  blake3 digests are pinned to 32 bytes for replicability.
- **Length-assertion guard.** `cid_v1` rejects a digest whose length doesn't match the
  asserted hash (sha2-256/blake3 = 32, sha2-512 = 64).
- **Clean failure on garbage.** `cidDecode` / `cid_decode` throw (delegated to
  `multiformats` `CID.parse`) rather than silently mis-framing.
- **Determinism/replicability.** No `Date`/random/branching in the value path; `cid` /
  `cid_v1` registered `replicable: true`, same as `digest`.

## Test coverage (test/cid.spec.ts — 19 tests; full suite 80 passing)

JS: golden interop vector; determinism; default raw/sha2-256/base32; all four bases
(prefix + decode round-trip); raw vs dag-cbor; all three hashes with correct digest
lengths; unsupported codec/hash/base throw; `cidV1` frames-without-rehash; `cidV1`
composition with `digest(...,'bytes')`; length-mismatch rejection; `cidDecode` shape,
multi-base decode, garbage rejection.

SQL: registration flags (`replicable`); `cid` BLOB == base64url-TEXT path; `cid_v1`
composes with the base64url string `digest` returns; `cid_v1` requires `hash`;
`cid_decode` returns parseable JSON of the expected shape; `cid_decode` rejects garbage.

## Validation commands

```
cd packages/quereus-plugin-crypto
yarn build        # tsup — regenerates dist (tests import from dist/)
yarn typecheck    # tsc --noEmit, clean
yarn test         # 80 passing
```

## Known gaps / things the reviewer should treat as a floor, not a ceiling

- **Clean `yarn install` currently fails at the LINK step** (not resolution, not tests):
  yarn 4 refuses to write `multiformats` into `C:/projects/Fret/packages/fret/node_modules`
  — the external portal `packages/substrate-simulator` wires in via
  `p2p-fret: portal:../../../Fret/packages/fret` (added by the recent
  `simulator-fret-cohort-model` work). The target is **outside the project root**, so the
  relink my new dep triggers is rejected ("Writing attempt prevented … outside project
  root"). This is an **environmental** constraint, not a defect in this change: the
  lockfile is correctly updated (multiformats listed under the crypto-plugin workspace
  entry), the already-hoisted `multiformats@14.0.0` resolves fine, and build/typecheck/all
  80 tests pass against it. Did **not** file `.pre-existing-error.md` (that channel is for
  test failures; there are none). Reviewer/maintainer may want a separate infra ticket to
  make the Fret portal install-safe (e.g. vendor it into the workspace or relax the
  out-of-root write), but it should not block this feature.
- **`dag-cbor` codec is a label only.** `cid(blob, 'dag-cbor')` does not verify the bytes
  are valid DAG-CBOR — it just records the content-type code. Same contract as any CID
  producer; documented, but worth a reviewer eye if a stricter guarantee is wanted.
- **`toContentBytes` base64url-TEXT path** relies on `uint8arrays` base64url decoding; a
  non-base64url TEXT argument may decode leniently rather than throwing. Not exercised by a
  negative test — consider adding one if strictness matters.
- **`numArgs: -1`** on `cid`/`cid_v1` means surplus trailing args are silently ignored
  (consistent with the plugin's other functions, but not arity-strict).
- **CIDv0 input to `cid_decode`** returns `version: 0` and is parsed (multiformats handles
  the `Qm…` form) but is not explicitly tested.
- **No live end-to-end SQL test through a real Quereus `Database`** — the SQL layer is
  tested at the registration/implementation level (calling `schema.implementation(...)`
  directly), mirroring the existing `digest` plugin tests. An integration test that loads
  the plugin and runs `select cid(...)` would be stronger.
- **Downstream `Cid` column migration is out of scope** (a VoteTorrent/sereus schema
  decision, per the ticket); this delivers only the primitive.
