description: New SQL/JS functions in the crypto plugin produce real, self-describing content identifiers (the CIDv1 format IPFS understands) so that columns named "Cid" can hold genuine interoperable addresses instead of bare hashes.
prereq: none
files:
  - packages/quereus-plugin-crypto/src/cid.ts        (new — cid/cidV1/cidDecode)
  - packages/quereus-plugin-crypto/src/plugin.ts      (cid/cid_v1/cid_decode SQL UDFs + toContentBytes)
  - packages/quereus-plugin-crypto/src/index.ts        (re-exports)
  - packages/quereus-plugin-crypto/package.json        (multiformats dep, provides, keywords)
  - packages/quereus-plugin-crypto/test/cid.spec.ts   (21 tests)
  - packages/quereus-plugin-crypto/README.md
  - packages/quereus-plugin-crypto/docs/crypto.md
difficulty: medium
----

## What shipped

A self-describing CIDv1 layer on top of the existing bare-hash `digest`, as both JS
exports and SQL UDFs. All framing/parsing is delegated to the audited `multiformats`
library; hashing reuses the plugin's synchronous `@noble/hashes` functions.

```
CIDv1     = multibase( version ‖ multicodec(content-type) ‖ multihash )
multihash = hashFnCode ‖ digestLength ‖ digestBytes
```

JS API (`src/cid.ts`): `cid(data, codec?, hash?, base?)`, `cidV1(digest, hash, codec?, base?)`,
`cidDecode(cid) → { version, codec, hashCode, digest }`.

SQL surface (`src/plugin.ts`, all `replicable: true` + deterministic): `cid`, `cid_v1`,
`cid_decode` (returns JSON TEXT). Selectable `codec` ∈ {raw, dag-cbor}, `hash` ∈
{sha2-256, sha2-512, blake3}, `base` ∈ {base32 (default), base58btc, base64url, base16}.

Intended composition for a multi-field `Cid` column (no double-hash):

```sql
cid_v1(digest(col_a, col_b, col_c), 'sha2-256')   -- digest frames+hashes; cid_v1 wraps that exact digest
```

## Review findings

**Verdict: solid implementation, accepted with minor fixes applied in this pass.** The
golden interop vector (`cid(utf8('hello world')) == bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e`)
is locked in a test, error handling is clean, and determinism/replicability are correct.
No major findings; no new tickets filed.

### What was checked

- **Implement diff read first**, with fresh eyes, before the handoff summary.
- **Correctness / interop**: golden CID vector verified; codec/hash/base selection;
  multihash framing via `Digest.create`; blake3 handled by framing (no `MultihashHasher`
  wrapper needed); length-assertion guard in `cidV1`.
- **Error handling**: garbage input to `cidDecode`/`cid_decode` throws (delegated to
  `CID.parse`); invalid codec/hash/base throw; NULL / non-BLOB-non-TEXT args throw.
- **Type safety / SPP / DRY / modularity**: `cid.ts` is a focused single-purpose module
  depending one-way on `crypto.ts` (`resolveHasher`); reverse code↔name maps; no bespoke
  byte-pushing. Casts at the SQL boundary funnel through validating lookups, so a bad
  cast surfaces as a clean throw, not a mis-frame.
- **Determinism / replicability**: no Date/random/branching in the value path; JSON key
  order in `cid_decode` is deterministic; all three functions registered `replicable: true`.
- **Docs**: re-read README.md, docs/crypto.md, docs/architecture.md, package.json — all
  reflect the new reality (one stale version line fixed, see below).
- **Lint/typecheck/tests**: `yarn build`, `yarn typecheck` (clean), `yarn test` — **82
  passing** (was 80; +2 added this pass).

### Findings & disposition

- **[minor — FIXED] Dependency version divergence.** Implement added
  `multiformats@^14.0.0` as a direct dep while the sibling workspace packages
  (`db-core`, `db-p2p`) — and the ticket's explicit recommendation — use `^13.4.2`.
  Aligned the crypto plugin to `^13.4.2`, reinstalled (deduped onto db-core's instance),
  and updated the docs/crypto.md dependency table. Verified API-compatible: build clean,
  typecheck clean, all tests pass including the golden vector (framing is byte-identical
  across the two majors). Note: `multiformats@14.0.0` still resolves in the tree
  *transitively* via libp2p v3 — that is outside this package's control and unaffected.
- **[minor — FIXED] Test gaps.** Added (1) a CIDv0 (`Qm…`) decode regression guard —
  `cid_decode` is a validation/migration surface and a legacy CIDv0 is a realistic stored
  value; it now asserts version 0, dag-pb (0x70) surfaced as a raw number, sha2-256 by
  name, 32-byte digest; and (2) a SQL negative test that `cid`/`cid_v1` reject a
  non-base64url TEXT argument and a non-BLOB/non-TEXT (INTEGER) argument.
- **[non-issue] "Lenient base64url decode" (handoff caveat).** Investigated: `toContentBytes`
  actually **throws** on invalid base64url ("Non-base64url character") via `uint8arrays`.
  The handoff's worry was unfounded; now covered by the negative test above.
- **[non-issue] blake3 vs sha2-256 length collision.** Both digests are 32 bytes, so
  `cidV1`'s length guard cannot distinguish a wrong `hash` assertion between them. This is
  **inherent to the documented "caller asserts the hash" contract** and matches the
  ticket's stated semantics (the multihash *code* is still recorded in the value, so the
  two produce *different* CIDs). Not a defect; left as-is, documented.
- **[non-issue] Clean-install LINK failure (handoff caveat).** The handoff reported
  `yarn install` failing at the link step because the new dep triggered a relink that hit
  the out-of-root Fret portal (`packages/substrate-simulator → portal:../../../Fret/...`).
  Aligning to the already-resolved `^13.4.2` avoided the relink: `yarn install` now
  **succeeds** (link completes; only benign portal/peer warnings). No infra ticket needed
  for this feature; the Fret-portal out-of-root concern, if real, belongs to the
  simulator-fret work, not here.
- **[accepted, documented] `numArgs: -1`** silently ignores surplus trailing args, and
  the SQL TEXT path interprets a TEXT argument as base64url (not raw UTF-8 content).
  Both are consistent with the plugin's existing conventions (`digest`/`sign`/`verify`)
  and documented in README/crypto.md. No change.
- **[out of scope]** Live end-to-end SQL test through a real Quereus `Database` (the SQL
  layer is tested at the registration/implementation level, mirroring the existing
  `digest` tests); and downstream `Cid` column migration (a VoteTorrent/sereus schema
  decision). Both explicitly out of this ticket's scope.

### Empty categories

- **Major findings: none.** No new fix/plan/backlog tickets filed.
- **Security: nothing found.** No eval/injection; all parsing delegated to `multiformats`.
- **Resource cleanup: N/A.** Pure value-path functions; nothing to release.

## Validation

```
cd packages/quereus-plugin-crypto
yarn build        # clean
yarn typecheck    # clean
yarn test         # 82 passing
```
