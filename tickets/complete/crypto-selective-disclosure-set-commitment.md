description: New crypto-plugin functions let an authority commit to a person's whole set of registration fields with one signed value, then later reveal only a chosen few of those fields with proof they are genuine — without exposing the rest.
prereq: none
files:
  - packages/quereus-plugin-crypto/src/sd.ts            (leafDigest/setCommit/setDisclose/setVerify)
  - packages/quereus-plugin-crypto/src/plugin.ts        (set_commit/set_verify SQL UDFs + leafFromJson/parseLeaves)
  - packages/quereus-plugin-crypto/src/index.ts         (re-exports + header)
  - packages/quereus-plugin-crypto/package.json         (quereus.provides.functions manifest)
  - packages/quereus-plugin-crypto/test/sd.spec.ts      (40 tests; +4 added in review)
  - packages/quereus-plugin-crypto/README.md            (Selective disclosure section + JS API)
  - packages/quereus-plugin-crypto/docs/crypto.md       (reference section + SQL signatures)
difficulty: medium
----

## What shipped

A **flat salted-leaf set commitment** for per-attribute selective disclosure, layered on
the existing `digest`/`encodeFields` framing (no Merkle tree). Both JS exports and SQL UDFs.

```
leafDigest = digest([SD_LEAF_DOMAIN_V1, name, value, salt])           // raw digest bytes
root       = digest([SD_SET_DOMAIN_V1, sortedLeaf_0, sorted_1, ...])  // sort by raw leaf-digest bytes
```

- JS: `leafDigest`, `setCommit`, `setDisclose` (engine-only generator), `setVerify`.
- SQL: `set_commit(leaves_json) → TEXT` (`replicable`), `set_verify(root, disclosed_json, hidden_json) → BOOLEAN` (deterministic, not replicable — pure, like `verify`).
- Recommended persisted column shape (documented, not wired into any schema): `CHECK (SelectiveCid = cid(set_commit(SelectiveDetails)))`.

Construction, invariants, and design rationale are unchanged from the implement handoff —
see `src/sd.ts` and `docs/crypto.md`. The review confirmed those invariants hold.

## Review findings

Adversarial pass over commit `cc81607`. Read the full diff (sd.ts, plugin.ts, index.ts,
crypto.ts framing it builds on, both docs, package.json) before the handoff summary.

### Verification performed
- `yarn build` — clean (tsup esm + dts).
- `yarn typecheck` (`tsc --noEmit`, includes `test/`) — clean. (No real lint exists in the
  repo: root `lint` is a no-op `echo`; `tsc` is the effective static check.)
- `yarn test` — **122 passing** (was 118; +4 added this pass).
- Out-of-band probe (`node` against `dist/`) of four untested paths — all sound (below).

### Correctness / soundness — checked, no bugs found
Probed the holder-controlled forgery surface directly, since this is a security primitive:
- **Duplicate disclosed leaf** (same genuine leaf presented twice) → `false`. The full-root
  reconstruction binds the multiset *and* count, so N+1 digests never match an N-leaf root.
- **Disclosed leaf also re-listed in `hidden`** (double-count) → `false`, same reason.
- **Name-binding replay**, changed value/salt, tampered hidden digest, add/drop leaf, wrong
  root — all `false` (implementer's tamper matrix re-confirmed).
- **Domain separation** (leaf hash can never equal a root hash) holds, incl. the crafted-leaf
  case where the value mimics the set framing.
- These three invariants (duplicate-disclosed, disclosed-also-hidden) were *relied on* but
  never *asserted* — now locked by new tests in `sd.spec.ts`.

### Fixed inline (minor)
- **Object-form leaf validation asymmetry** (`src/plugin.ts` `leafFromJson`): the array form
  required all three positions (`length < 3` throws), but the object form silently committed
  `value = NULL` when the `value` key was absent — masking a malformed leaf. Made the object
  form require an explicit `value` key (throws otherwise; pass `value: null` for a genuine
  null attribute). Symmetric with the array form, strictly safer (only rejects previously-
  silent malformed input — no valid use regresses). Docs (README + crypto.md ×2) updated.

### Coverage gaps closed (minor)
- **`set_verify` under a non-default (`hex`) encoding config** was untested — verified by
  probe that it round-trips (root is hex, hidden digests stay base64url internally), then
  added a SQL-surface regression test asserting both true and tamper-false paths.
- Added the duplicate-disclosed and disclosed-also-hidden soundness tests noted above, and a
  test for the new object-form `value`-key guard.

### Accepted as-is (documented, not defects)
- **Self-generated golden vectors.** The pinned set-commitment vectors were computed from
  this implementation (no external standard reference — not SD-JWT wire-compatible by
  design). They lock the wire format against drift; they do not independently prove the
  construction. The construction was reviewed and is sound, so freezing them is appropriate.
- **No live end-to-end SQL through a real Quereus `Database`.** Tests call the registered
  `implementation` directly. Verified this is the **package-wide convention** —
  `cid.spec.ts` and `crypto.spec.ts` do the same; no spec in the package instantiates a
  `Database`. Not a regression in this ticket. A future integration-harness ticket could
  exercise an actual `CHECK`-rejected INSERT; out of scope here.
- **`setDisclose` silently ignores reveal names matching no leaf** (under-discloses rather
  than throwing). Documented; not a soundness hole — the recipient's application must still
  confirm the field it wanted appears in `disclosed`. Left as-is (changing to throw is a
  behavior decision for the consumer, not a review fix).
- **Schema wiring absent / `cid` prereq soft / BLOB-via-SQL committed as base64url TEXT /
  privacy correlation across audiences / framing coupling to a future `DIGEST_FORMAT_V1`
  bump** — all out of scope and accurately documented by the implementer; no action.

### Empty categories
- **No major findings** → no new fix/plan/backlog tickets filed. The primitive is sound, the
  tamper matrix is real, and the remaining gaps are downstream (schema consumer) or
  documented design choices, not defects.
- **No pre-existing failures** → `yarn test` was clean before and after; no
  `.pre-existing-error.md` filed.

## How to validate

```
cd packages/quereus-plugin-crypto
yarn build && yarn typecheck && yarn test    # clean; 122 passing
```
