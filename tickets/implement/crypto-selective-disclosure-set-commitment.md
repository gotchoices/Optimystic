description: Let an authority commit to a person's whole set of registration fields with one signed value, then later reveal only a chosen few of those fields to someone — with proof the revealed values are genuine — without exposing any of the rest.
prereq: crypto-cid-v1-content-identifier
files:
  - packages/quereus-plugin-crypto/src/crypto.ts
  - packages/quereus-plugin-crypto/src/plugin.ts
  - packages/quereus-plugin-crypto/src/index.ts
  - packages/quereus-plugin-crypto/package.json (quereus.provides.functions manifest)
  - packages/quereus-plugin-crypto/src/sd.ts (new)
  - packages/quereus-plugin-crypto/test/sd.spec.ts (new)
  - packages/quereus-plugin-crypto/README.md
  - packages/quereus-plugin-crypto/docs/crypto.md
difficulty: medium
----

## Problem

VoteTorrent voter registration needs **per-attribute selective disclosure**: an
authority commits to a registrant's selective-disclosure field set as a single value
(`Registrant.SelectiveCid`, covered by the authority's signature), then later reveals a
*subset* of those fields to a permitted audience — with a proof that the revealed values
are genuinely the ones that were committed — **without leaking the values of the
undisclosed fields**.

A flat `digest(whole set)` cannot do this: verifying any one field requires the whole
pre-image, so it is all-or-nothing. The need is a commitment that supports *partial
opening*.

The same canonical implementation must back three call sites so they cannot drift on leaf
encoding or commitment shape:

- the **DB**, so a schema `CHECK` can enforce `SelectiveCid = set_commit(SelectiveDetails)`
  at insert (a forged/incorrect root becomes impossible to store — the "invalid states
  impossible by design" posture of the rest of the schema);
- the **engine**, which generates disclosures;
- the **recipient**, who verifies a disclosure (and is typically *not* running the DB).

## Design decision: salted-leaf set commitment, not a Merkle tree

The submitted issue proposed a Merkle tree. We are deliberately **not** building a tree.
A Merkle tree's only advantage over a flat construction is O(log n) proof size; voter
selective-disclosure field sets are small (a handful to a few dozen fields), so the log
saving is marginal while the tree drags in real footguns we would have to hand-roll and
pin: arity, odd-node handling (the CVE-2012-2459 duplicate-leaf forgery class), and
mandatory leaf-vs-internal domain separation, plus a separate audit-path proof format.

Instead we use a **flat salted-leaf set commitment**, composed on the *existing* `digest`
primitive — the same layering the CID work uses (`cid(digest(...))`). This also dissolves
the issue's "generic vs. selective-specific" dichotomy: because the leaf is built by
`digest`/`encodeFields` (already canonical, injective, type-tagged, domain-separated, and
`replicable`), a **generic** salted-set primitive is simultaneously reusable *and* fully
DB-enforceable — every crypto-bearing layer lives in the plugin.

This is the same shape the IETF SD-JWT selective-disclosure standard
(`draft-ietf-oauth-selective-disclosure-jwt`) settled on — flat salted hashes of
`(salt, name, value)`, not a tree — which is good external evidence the smaller
construction is the right one. We are *not* wire-compatible with SD-JWT (we reuse
Optimystic's own `encodeFields` framing for cross-peer replicability); SD-JWT is cited only
as conceptual precedent.

## How it works

Each disclosable attribute becomes a **salted leaf**:

```
leafDigest = digest([SD_LEAF_DOMAIN_V1, name, value, salt])   // raw digest bytes
```

- **`name` is hashed into the leaf** so a disclosed `(value, salt)` proof cannot be replayed
  against a different attribute slot (e.g. presenting an `over18=true` proof as the
  `citizen` field). This binding is free given `encodeFields`' injective framing.
- **`salt` is per-leaf and mandatory** — low-entropy attributes (DOB, booleans, ZIP) are
  brute-forceable from a bare hash, and independent salts also defeat cross-registrant
  equality correlation. Salts come from `random_bytes` (recommend ≥128 bits; default 256).

The **set commitment** (the root) is the digest of all leaf digests in canonical order:

```
root = digest([SD_SET_DOMAIN_V1, sortedLeafDigest_0, sortedLeafDigest_1, ...])
```

**Canonical order is by raw leaf-digest bytes (lexicographic), and this is forced, not a
preference.** In a disclosure the verifier learns the *names* of only the disclosed leaves;
the undisclosed leaves arrive as opaque digests with no name. So the verifier can only
re-derive the root if the ordering key is something it holds for *every* leaf — the leaf
digest itself. Sorting by name would be unverifiable for hidden leaves. Document this
rationale at the call site so it is never "tidied" into a name sort.

`SD_LEAF_DOMAIN_V1` and `SD_SET_DOMAIN_V1` are fixed domain-separation constants (leading
string fields), pinned exactly like `DIGEST_FORMAT_V1` — they keep a leaf hash from ever
equaling a root hash, and they must never change without a deliberate, breaking version
bump (which would change every committed root and every signature over it).

### Disclosure and verification

- **Disclose** (engine, JS only): given the full leaf set and the names to reveal, return
  the revealed `(name, value, salt)` triples plus the opaque leaf *digests* of the
  withheld leaves. Undisclosed `value`/`salt` never appear in the output.
- **Verify** (recipient, JS primary; SQL secondary): recompute the disclosed leaves'
  digests, union with the supplied hidden digests, sort by bytes, recompute `root`, and
  compare to the signed root. This reconstructs the **entire** root, so it proves the
  disclosed leaves belong to *exactly this committed set* — the holder cannot add, drop, or
  swap a leaf. Verification mismatch (or unparseable proof) returns `false`, mirroring
  `verify`'s forgiving contract rather than throwing.

## Interfaces

New module `packages/quereus-plugin-crypto/src/sd.ts`, layered on `crypto.ts`
(`encodeFields` / `digestFields` / `resolveHasher` / `resolveOutputEncoder`), so the digest
hot path's "resolve once, no per-call branching" discipline is preserved.

```ts
/** One disclosable attribute. `value` spans the SQL value space (DigestField). */
export interface SaltedLeaf {
  readonly name: string;
  readonly value: DigestField;
  readonly salt: string | Uint8Array;   // base64url text (from random_bytes) or raw bytes
}

/** A disclosure payload sent to a recipient. */
export interface SetDisclosure {
  readonly disclosed: readonly SaltedLeaf[];  // opened (name, value, salt) triples
  readonly hidden: readonly string[];          // opaque leaf digests of withheld leaves
}

/** Raw leaf digest bytes for one salted leaf (domain-separated, name-bound). */
export function leafDigest(leaf: SaltedLeaf, hasher: DigestHasher): Uint8Array;

/**
 * Commit to a SET of salted leaves -> single root (the signed/persisted value).
 * Sorts leaves by raw leaf-digest bytes, then digests them under SD_SET_DOMAIN_V1.
 * THROWS on a duplicate `name` or an empty/missing `salt` (invalid states impossible).
 */
export function setCommit(
  leaves: readonly SaltedLeaf[],
  hasher?: DigestHasher,
  encode?: OutputEncoder,
): string | Uint8Array;

/** Split a leaf set into the revealed triples + opaque digests of the rest. */
export function setDisclose(
  leaves: readonly SaltedLeaf[],
  revealNames: readonly string[],
  hasher?: DigestHasher,
): SetDisclosure;

/**
 * Verify a disclosure against a signed root. Reconstructs the full root from the
 * disclosed leaves + hidden digests. Returns false on mismatch or malformed input.
 */
export function setVerify(
  root: string | Uint8Array,
  disclosure: SetDisclosure,
  hasher?: DigestHasher,
  decodeRoot?: ...,   // root encoding to compare against; default base64url text
): boolean;
```

SQL surface (registered in `plugin.ts`, reusing the load-time-resolved `digestHasher` /
`digestEncoder`, same `replicable: true` + `DETERMINISTIC` discipline as `digest`):

```
set_commit(leaves_json TEXT) -> TEXT      -- root over a JSON array of [name, value, salt] leaves
set_verify(root TEXT, disclosed_json TEXT, hidden_json TEXT) -> BOOLEAN
```

- `leaves_json` is a JSON array; each element is a leaf `[name, value, salt]` (or
  `{ "name", "value", "salt" }`). Values map to `encodeFields` rules as parsed from JSON
  (INTEGER vs REAL by JS value, TEXT, BOOL, null, nested object/array → TAG_JSON). A
  BLOB-valued attribute is passed as its base64url text and committed as TEXT (callers
  needing true BLOB values use the JS API with `Uint8Array`); document this limitation.
- `set_commit` is `replicable: true` (its output is signed and persisted, same bar as
  `digest`); `set_verify` is `DETERMINISTIC` (pure, not persisted), matching `verify`.

### Composition with the schema and the CID layer

```sql
-- SelectiveDetails stores the [name, value, salt] triples; the CHECK recomputes the root
-- from the stored record, so a forged SelectiveCid cannot be inserted.
CHECK (SelectiveCid = cid(set_commit(SelectiveDetails)))
```

The `Cid`-suffixed column should hold the **CID-framed** value `cid(set_commit(...))`, not a
bare `set_commit(...)` hash — per `crypto-cid-v1-content-identifier`, signed/persisted
records freeze their representation, so the root should adopt the self-describing CIDv1
framing from the start rather than freezing a bare hash. `set_commit` itself emits a bare
digest (exactly like `digest`); the CID framing is applied on top, keeping each primitive
single-purpose.

## Edge cases & interactions

- **Empty set** — `set_commit([])` must be deterministic, not an error: it is the digest of
  `[SD_SET_DOMAIN_V1]` (a well-defined empty-set commitment). Single-leaf sets work normally.
- **Duplicate attribute names** — rejected by `setCommit`/`set_commit` (throw). Two leaves
  with the same name would let a holder selectively present whichever value suits them; the
  authority side, which holds all names, is the only place uniqueness can be enforced (the
  verifier never sees hidden names). The schema also enforces uniqueness, but the primitive
  must fail-fast too.
- **Empty/missing salt** — rejected (throw). An unsalted leaf is brute-forceable.
- **Name-binding replay** — a disclosed `(value, salt)` from attribute A presented as
  attribute B must verify `false` (covered by the leaf domain + name field). Explicit test.
- **Leaf-vs-root domain collision** — a leaf digest must never be constructible such that it
  equals a root digest; the two distinct domain constants guarantee this. Test a crafted case.
- **Tamper** — changing any disclosed value, salt, or any supplied hidden digest must verify
  `false`. Dropping or adding a leaf must verify `false` (full-root reconstruction binds the
  exact set, including count).
- **Ordering independence** — the same logical set presented in any input order yields the
  same root and verifies identically (sort-by-leaf-digest-bytes). Test shuffled inputs.
- **Determinism / replicability** — sort over **raw digest bytes** (`Uint8Array`
  lexicographic compare), never over encoded strings (encoding-dependent ordering would
  break cross-peer agreement); output encoding applies only to the final root. Pin
  known-answer (golden) vectors so the format cannot silently drift, mirroring the digest
  stability tests.
- **NULL value** — allowed and distinguished from absent (TAG_NULL); a disclosed leaf may
  carry a null value.
- **Privacy note (document, do not fix)** — a fixed commitment disclosed to two audiences
  exposes the same hidden digests and the same field count to both, so they can correlate
  that it is the same record. Re-randomizing per disclosure would require fresh salts → a new
  root → a new signature, which is out of scope.
- **Malformed SQL JSON** — `set_commit` on unparseable/!array JSON errors cleanly (consistent
  with the plugin's "exceptions should be exceptional" stance); `set_verify` returns `false`.
- **Cross-platform** — pure JS over `@noble/*` + existing `crypto.ts` helpers; no Node-only
  assumptions (Node, browser, React Native), same constraint as the rest of the plugin.
- **Framing coupling** — leaf/root reuse `encodeFields`, so a future `DIGEST_FORMAT_V1` bump
  (see `crypto-digest-variadic-breaks-downstream-callers`) changes `set_commit` output too;
  this coupling is intentional (one canonical framing) and should be noted in the README.

## Relationship to other work

- **`crypto-cid-v1-content-identifier`** (prereq, currently in `implement/`): listed as a
  prereq so docs/examples can reference the real `cid()` function and the recommended column
  shape is `cid(set_commit(...))`. The dependency is *soft at the code level* — `set_commit`
  builds only on `digest`/`encodeFields` and does not call `cid()` — so if scheduling
  demands it, the two can proceed in parallel; the prereq exists to keep the persisted
  representation decision (CIDv1, not bare hash) consistent before signed records commit.
- **`crypto-digest-variadic-breaks-downstream-callers`** (backlog): shares the `encodeFields`
  framing; no hard dependency, but a framing version bump must bump set-commitment vectors too.

## TODO

### Phase 1 — core primitive (`src/sd.ts` + tests)
- Add `SD_LEAF_DOMAIN_V1` / `SD_SET_DOMAIN_V1` constants (pinned; document the no-drift rule).
- Implement `leafDigest`, `setCommit` (sort-by-bytes, dup-name + empty-salt rejection),
  `setDisclose`, `setVerify` (full-root reconstruction; mismatch/malformed → false).
- Reuse `resolveHasher`/`resolveOutputEncoder`/`encodeFields`/`digestFields`; no per-call
  algorithm/encoding branching.
- `test/sd.spec.ts`: round-trip; tamper (value/salt/hidden); name-binding replay;
  leaf-vs-root domain collision; drop/add leaf; shuffled-input determinism; duplicate-name
  throw; empty-salt throw; empty set; NULL value; pinned golden vectors.

### Phase 2 — SQL surface (`plugin.ts`)
- Register `set_commit` (`replicable: true`, DETERMINISTIC) and `set_verify` (DETERMINISTIC),
  reusing the registration-time `digestHasher` / `digestEncoder`.
- Add `set_commit` / `set_verify` to `package.json` → `quereus.provides.functions` (the
  plugin manifest), alongside the existing `digest` / `cid` / … entries.
- JSON leaf parsing + value→`DigestField` mapping; document BLOB-value limitation.
- Plugin-level tests: `CHECK (SelectiveCid = cid(set_commit(SelectiveDetails)))` accepts a
  correct root and rejects a forged one; `set_verify` true/false paths in SQL.

### Phase 3 — exports + docs
- Re-export the `sd.ts` surface and types from `src/index.ts`.
- README: a "Selective disclosure" section (leaf framing, domain constants, sort rationale,
  salt requirement, `cid(set_commit(...))` column pattern, SD-JWT precedent note,
  recipient-side JS verify example) + the framing-coupling note.
- `docs/crypto.md`: same, at reference depth.

### Validation
- `yarn workspace @optimystic/quereus-plugin-crypto build && yarn workspace @optimystic/quereus-plugin-crypto test 2>&1 | tee /tmp/sd-test.log`
  (stream output; do not silently redirect).
