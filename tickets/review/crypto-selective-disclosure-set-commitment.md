description: New crypto-plugin functions let an authority commit to a person's whole set of registration fields with one signed value, then later reveal only a chosen few of those fields with proof they are genuine — without exposing the rest.
prereq: none
files:
  - packages/quereus-plugin-crypto/src/sd.ts            (new — leafDigest/setCommit/setDisclose/setVerify)
  - packages/quereus-plugin-crypto/src/plugin.ts        (set_commit/set_verify SQL UDFs + leafFromJson/parseLeaves)
  - packages/quereus-plugin-crypto/src/index.ts         (re-exports + header)
  - packages/quereus-plugin-crypto/package.json         (quereus.provides.functions manifest)
  - packages/quereus-plugin-crypto/test/sd.spec.ts      (new — 36 tests)
  - packages/quereus-plugin-crypto/README.md            (Selective disclosure section + JS API)
  - packages/quereus-plugin-crypto/docs/crypto.md       (reference section + SQL signatures)
difficulty: medium
----

## What shipped

A **flat salted-leaf set commitment** for per-attribute selective disclosure, layered on
the existing `digest`/`encodeFields` framing (no Merkle tree — see the design rationale
in `src/sd.ts` and `docs/crypto.md`). Both JS exports and SQL UDFs.

```
leafDigest = digest([SD_LEAF_DOMAIN_V1, name, value, salt])     // raw digest bytes
root       = digest([SD_SET_DOMAIN_V1, sortedLeaf_0, sorted_1, ...])   // sort by raw leaf-digest bytes
```

JS API (`src/sd.ts`):
- `leafDigest(leaf, hasher)` → raw leaf digest bytes (low-level building block).
- `setCommit(leaves, hasher?, encode?)` → root (bare digest; pair with `cid()` for the column).
- `setDisclose(leaves, revealNames, hasher?)` → `{ disclosed, hidden }` (engine-only generator).
- `setVerify(root, disclosure, hasher?, encode?)` → boolean (full-root reconstruction; false on mismatch/malformed).

SQL surface (`src/plugin.ts`, reusing the load-time `digestHasher`/`digestEncoder`):
- `set_commit(leaves_json) → TEXT` — `replicable: true` + deterministic (signed/persisted root).
- `set_verify(root, disclosed_json, hidden_json) → BOOLEAN` — deterministic, **not** replicable (pure, like `verify`).

Intended column composition (documented, **not** wired into any schema here):

```sql
CHECK (SelectiveCid = cid(set_commit(SelectiveDetails)))   -- forged root becomes unstorable
```

### Key invariants enforced (and tested)
- Duplicate leaf `name` → **throws** (`setCommit`/`setDisclose`/`set_commit`).
- Missing/empty `salt` → **throws** (unsalted leaves are brute-forceable).
- `name` hashed into the leaf → a `(value, salt)` proof can't be replayed under another name.
- Two distinct domain constants → a leaf hash can never equal a root hash.
- Sort by **raw digest bytes** (not name, not encoded strings) — forced, because the verifier
  has no name for hidden leaves; only the leaf digest is a key it holds for every leaf.
- Full-root reconstruction binds the exact set incl. count → add/drop/swap a leaf all → false.
- Empty set is well-defined (`digest([SD_SET_DOMAIN_V1])`), not an error.
- `set_commit` throws on malformed JSON; `set_verify` returns `false` (forgiving).

## How to validate

```
cd packages/quereus-plugin-crypto
yarn build        # clean (tsup esm + dts)
yarn typecheck    # clean (tsc --noEmit, includes test/)
yarn test         # 118 passing (was 82; +36 in sd.spec.ts)
```

### Use cases the reviewer should exercise / sanity-check
- **Round trip**: commit a field set → disclose a subset → `setVerify` true; withheld
  values/salts must never appear in the disclosure (there is a leak-check test, but eyeball
  `setDisclose`'s output shape).
- **Tamper matrix**: changed disclosed value, changed disclosed salt, tampered hidden digest,
  dropped leaf, added leaf, name-binding replay, wrong root → all must be `false`.
- **Order independence**: same logical set in any input order → same root.
- **SQL parity**: `set_commit(JSON)` equals the JS `setCommit` for the same leaves; both
  `[name,value,salt]` array and `{name,value,salt}` object leaf forms accepted.
- **Golden vectors**: sha256/hex leaf + empty/single/three-leaf roots are pinned in the spec.

## Honest gaps / things to scrutinize (treat tests as a floor)

- **Golden vectors are self-generated, not externally verifiable.** Unlike the CID
  `hello world` vector (a public IPFS value), these set-commitment vectors were computed
  from *this* implementation, then pinned. They lock the wire format against silent drift
  but do **not** independently prove the construction against an external reference (there
  is no standard one — we are not SD-JWT wire-compatible by design). Reviewer should confirm
  the construction is what we want *before* trusting the frozen vectors, since once roots are
  signed in the wild these become breaking to change.
- **No live end-to-end SQL through a real Quereus `Database`.** The SQL surface is tested at
  the registration/implementation level (calling the registered `implementation` directly),
  mirroring the existing `digest`/`cid` tests. The actual `CHECK (SelectiveCid =
  cid(set_commit(...)))` is only *modeled* (string equality of recomputed roots), never run
  through Quereus DDL + INSERT. If an integration test harness exists, exercising a real
  CHECK-rejected insert would strengthen this.
- **Schema wiring is out of scope and absent.** No `Registrant`/`SelectiveCid`/
  `SelectiveDetails` table exists anywhere in the repo yet (grep confirms only this package +
  docs reference the names). This ticket delivers the primitive + SQL functions only; the
  VoteTorrent schema that consumes them is downstream work.
- **`cid` prereq is soft.** `set_commit` builds only on `digest`/`encodeFields`; it does
  *not* call `cid()`. The `cid(set_commit(...))` column shape is documented as the
  recommended persisted form but not enforced by the primitive. `cid` has already landed
  (in `complete/`), so docs/examples reference a real function.
- **`setDisclose` silently ignores reveal names that match no leaf** (they are simply not
  disclosed; the rest become hidden). This is documented but unguarded — reviewer may decide
  whether a typo'd reveal name should throw instead of silently under-disclosing.
- **BLOB-valued attributes via SQL** are committed as their base64url TEXT (JSON has no blob
  type); a true `TAG_BLOB` leaf requires the JS API with a `Uint8Array`. Documented limitation.
- **Privacy correlation (documented, not fixed):** a fixed commitment shown to two audiences
  exposes the same hidden digests + field count to both, so they can correlate it is the same
  record. Per-disclosure re-randomization (fresh salts → new root → new signature) is out of scope.
- **Framing coupling:** leaf/root reuse `encodeFields`, so a future `DIGEST_FORMAT_V1` bump
  (`crypto-digest-variadic-breaks-downstream-callers`, backlog) changes `set_commit` output and
  must bump these golden vectors in lockstep.

## Pre-existing failures
None observed — `yarn test` was clean (118 passing) before and after; no `.pre-existing-error.md` filed.
