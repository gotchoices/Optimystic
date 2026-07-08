description: The group of nodes responsible for a piece of data is now baked into what those nodes cryptographically sign, so if two nodes disagree about who is responsible they produce visibly different (competing) transactions instead of silently agreeing on the same one.
prereq:
files:
  - packages/db-core/src/cluster/membership.ts (NEW — shared digest + version-dispatched hash helpers)
  - packages/db-core/src/cluster/structs.ts (ClusterRecord: +membershipVersion, +membershipDigest)
  - packages/db-core/src/cluster/index.ts (export membership.js)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (executeClusterTransaction, makeRecord, createMessageHash)
  - packages/db-p2p/src/cluster/cluster-repo.ts (validateRecord, computeMessageHash/PromiseHash/CommitHash, mergeRecords)
  - packages/db-p2p/src/dispute/dispute-service.ts (computePromiseHash version dispatch)
  - packages/db-p2p/test/cluster-membership-binding.spec.ts (NEW — 14 tests)
  - docs/correctness.md (§2 Cluster/Membership binding, Theorem 1, Theorem 2, Theorem 12)
difficulty: hard
----

## What was built

The responsible peer set for a cluster transaction is now **bound into the transaction's signed
identity**. Before this change the peer set (`ClusterRecord.peers`) was never covered by any of the
three hashes members sign (`messageHash`, `promiseHash`, `commitHash`), so two coordinators could
produce the *same* `messageHash` while disagreeing on membership — and honest members reconciling those
two views hit a hard `throw new Error('Peers mismatch')`.

### Mechanism

- **Membership digest** (`packages/db-core/src/cluster/membership.ts`):
  `membershipDigest(peers) = base64url(SHA256(canonicalJson(Object.keys(peers).sort())))`.
  Over the **sorted peer-id list only** — not multiaddrs or public keys.
- **Record versioning** — `ClusterRecord` gains `membershipVersion?: 1 | 2` and `membershipDigest?: string`.
  New coordinators always emit `2`. Absent/`1` = legacy unbound.
- **Version-dispatched hashing** — the three hash helpers take an optional digest. `undefined` ⇒ the
  legacy v1 preimage (empty-string concat is a no-op ⇒ **byte-identical** to before). Passing the digest
  folds it in per the table below. All three call sites (coordinator, member, dispute-service) route
  through the shared db-core helpers, so there is one implementation, not three copies.

  | hash | v1 preimage | v2 preimage |
  |------|-------------|-------------|
  | `messageHash` | `message` | `message + digest` |
  | `promiseHash` | `messageHash + message` | `messageHash + message + digest` |
  | `commitHash`  | `messageHash + message + promises` | `messageHash + message + digest + promises` |

- **Coordinator** — `executeClusterTransaction` computes the digest from `peers` *before* the messageHash
  (the hash now depends on it); `makeRecord` stamps `membershipVersion: 2` + `membershipDigest`.
- **Member `validateRecord`** — rejects an unknown `membershipVersion`; for v2, rejects if
  `membershipDigest(record.peers) !== record.membershipDigest` (declared digest must match its own peers),
  then the messageHash check binds the whole thing together.
- **Member `mergeRecords`** — the `'Peers mismatch'` branch is now version-aware. For v2 it compares
  `membershipVersion` + `membershipDigest` (equal `messageHash` ⇒ equal membership on honest paths; a
  mismatch is logged loudly as an invariant violation and rejected). Crucially it **no longer rejects on
  multiaddr/pubkey churn within the same id set** (that keeps the same digest/hash). v1 keeps the old
  full-peers-object comparison.
- **Dispute path** — `DisputeService.computePromiseHash` is version-dispatched too, so approvals in a v2
  `originalRecord` still re-verify (otherwise challenger-wins would silently fail to penalize false
  approvers on v2 records).
- **State store** — `membershipVersion`/`membershipDigest` are plain fields on `record`; the JSON-backed
  `PersistentTransactionStateStore` round-trips them automatically (confirmed by test).

## Use cases to validate (reviewer's checklist)

**Migration / already-committed history (highest priority).**
- A v1 record (no `membershipVersion`) hashes byte-identically to the pre-change implementation. Test
  `v1 (legacy) hashing is byte-identical…` asserts message/promise/commit hashes against a verbatim copy
  of the old algorithm. A stored v1 commit signature still verifies under the version-dispatched path
  (test `v1 commit cert remains verifiable…`). **Reviewer: confirm no old record is ever rewritten/upgraded.**
- A new (v2) member accepts an old (v1) record; an old (v1) member receiving a v2 record throws
  `Message hash mismatch` and rejects it — see the mixed-fleet note below.

**Binding.**
- v2 `messageHash` differs when the peer-id set differs but the message is identical (two sets ⇒ two hashes).
- v2 message/promise/commit hashes are **stable** under multiaddr churn and peer-map key reordering.

**Malformed / adversarial.**
- v2 record whose `membershipDigest` ≠ `membershipDigest(peers)` is rejected (`Membership digest mismatch`).
- Unknown `membershipVersion` (e.g. 3) is rejected.
- `mergeRecords` on two v2 records forced to share a `messageHash` but with different membership rejects
  loudly (defensive invariant — cannot arise on honest paths because `validateRecord` gates it first).

**Determinism / edge cases.**
- `membershipDigest` independent of multiaddr contents and insertion order; changes on add/remove of an id.
- `membershipDigest({})` (empty set) and single-peer sets are well-defined constants.

**Round-trip.** A v2 record persisted through the real JSON store recovers with fields intact and
re-verifies on a fresh member.

## How to run

```
cd packages/db-core && yarn build            # must build first — db-p2p consumes its dist
cd packages/db-p2p && yarn build             # tsc typechecks src + test
node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/cluster-membership-binding.spec.ts" "test/cluster-repo.spec.ts" \
  "test/cluster-coordinator.spec.ts" "test/transaction-state-store.spec.ts" \
  "test/dispute.spec.ts" --reporter spec
```

Verified green: `db-core` build clean; `db-p2p` build clean (EXIT=0); 128 passing across the five suites
above (14 new); plus 135 passing across `signature-validation-integration`, `cluster-consensus-divergence`,
`cluster-invalidation`, `cluster-error-propagation`, `cascade`, `invalidation`, `byzantine-fault-injection`,
`quorum-restore`. No pre-existing failures encountered.

## Known gaps / things a reviewer should probe

- **This is the binding half only.** It does NOT decide whether a *declared* peer set is a legitimate
  cluster for the block. A coordinator can still declare any set it likes and self-consistently sign it;
  the member-side admission check (partition / self-shrink defense) is the follow-up
  `cluster-membership-admission-gate`. Theorems 1/2 in `docs/correctness.md` are annotated to say this
  ticket establishes the binding and the admission gate completes agreement-on-legitimacy.
- **Mixed-version fleet is out of scope and asymmetric.** New members accept old v1 records (migration
  safety); **old members reject new v2 records** with `Message hash mismatch`. So during a partial
  rollout, a v2 coordinator's transactions are rejected by not-yet-upgraded members and can miss
  super-majority. This is the intended "cluster consensus code is a single deployable unit — upgrade all
  members together" posture, but it is an **operational contract** the reviewer/operator should be aware
  of. Not enforced in code beyond the rejection.
- **The `mergeRecords` invariant test forces a hash collision by hand** (sets two records' `messageHash`
  equal). A real SHA256 collision won't occur; the branch exists as a defensive assertion. Honest paths
  cannot reach it because `validateRecord` proves each record's digest matches its own peers first.
- **Tripwire (parked, not a ticket):** `validateRecord` recomputes `membershipDigest` (one SHA256 over the
  sorted id list) on every incoming v2 record. Fine now. If a hot cluster ever shows it as a cost, memoize
  per `messageHash → digest`. Recorded as a `NOTE:` at the exact site in `cluster-repo.ts` `validateRecord`.
- **Not exercised end-to-end over real libp2p.** All new tests are unit/in-process. The multi-coordinator
  and real-libp2p integration suites (`*.integration.spec.ts`) were not run here (they are gated/slow); a
  reviewer wanting cross-node confidence should run `yarn test:integration` in `db-p2p`.
