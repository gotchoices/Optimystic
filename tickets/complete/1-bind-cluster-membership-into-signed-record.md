description: The group of nodes responsible for a piece of data is now baked into what those nodes cryptographically sign, so if two nodes disagree about who is responsible they produce visibly different (competing) transactions instead of silently agreeing on the same one.
prereq:
files:
  - packages/db-core/src/cluster/membership.ts (shared digest + version-dispatched hash helpers)
  - packages/db-core/src/cluster/structs.ts (ClusterRecord: membershipVersion, membershipDigest)
  - packages/db-core/src/cluster/index.ts (export membership.js)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (executeClusterTransaction, makeRecord, createMessageHash)
  - packages/db-p2p/src/cluster/cluster-repo.ts (validateRecord, computeMessageHash/PromiseHash/CommitHash, mergeRecords)
  - packages/db-p2p/src/dispute/dispute-service.ts (computePromiseHash version dispatch)
  - packages/db-p2p/test/cluster-membership-binding.spec.ts (15 tests)
  - docs/correctness.md (§2 Membership binding, Theorem 1, Theorem 2, Theorem 12)
----

## What was built

The responsible peer set for a cluster transaction is now **bound into the transaction's signed
identity**. The peer-id set is digested (`membershipDigest = base64url(SHA256(canonicalJson(sorted
peer-ids)))`) and, for a version-2 record, that digest is folded into all three hashes members sign
(`messageHash`, `promiseHash`, `commitHash`). Two coordinators that disagree about who is responsible
now produce two *different* `messageHash`es — competing transactions the race machinery resolves —
rather than one hash they silently disagree about. Legacy (v1 / unversioned) records omit the digest
and hash byte-identically to before, so already-committed history and its stored commit certificates
keep verifying.

The implementation is sound: the coordinator (`makeRecord`) stamps `membershipVersion: 2` +
`membershipDigest`; the member (`validateRecord`) rejects unknown versions, rejects a v2 record whose
declared digest doesn't match its own peers, then binds the whole thing via the messageHash check;
`mergeRecords` is version-aware; and the dispute path's promise re-verification is version-dispatched
too. All three hash preimages route through one shared set of db-core helpers rather than three copies.

## Review findings

**Verdict: sound. Two minor items fixed inline; no major/blocking issues; one tripwire recorded.**

### Checked and clear

- **Wire serialization (highest-risk failure mode).** Verified the cluster RPC transport
  (`protocol-client.ts` `processMessage`) is plain `JSON.stringify` / `JSON.parse` with **no strict
  schema/codec** — so the new `membershipVersion` / `membershipDigest` fields survive in transit and a
  v2 record is not silently downgraded to v1 (which would have caused a `Message hash mismatch` at the
  receiving member). This was the most dangerous plausible defect; it does not occur.
- **Every hash producer/verifier routes through the shared helpers.** Confirmed the *only* record
  producer is `ClusterCoordinator.makeRecord` (`simple-cluster-coordinator.ts` produces no records;
  `reactivity-mesh-harness.ts` is test-only). Coordinator create, member validate/sign, and dispute
  promise re-verify all use the db-core helpers — no stray un-dispatched hash computation remains
  (`invalidation.ts` / `commit-cert.ts` consume an already-bound hash, they don't recompute a preimage).
- **validateRecord ordering.** version check → v2 digest check → messageHash check. The digest is
  validated against the record's own peers *before* it is used in the hash preimage. Correct.
- **v1 byte-identical regression oracle.** The test reproduces the pre-change algorithm verbatim and
  asserts the version-dispatched helpers (no digest) match it byte-for-byte for message/promise/commit,
  plus a stored v1 commit signature still verifies. Migration safety at the hash level is proven.
- **Dispute path completeness.** `challenger-wins` re-verifies *approve* promise signatures via the
  now-version-dispatched `computePromiseHash`, so v2 records still penalize false approvers. Commit
  hashes are not re-derived on the dispute path (correctly — nothing there needs them).
- **Build + lint + tests.** `db-core` and `db-p2p` build clean (tsc, EXIT=0); eslint clean on all
  changed files; **143 passing** across the six core/regression suites plus the eight further regression
  suites the handoff named (128 core incl. the new binding suite, + 135 regression), no failures. The
  new binding suite is now **15 passing** (was 14) after the added test below.

### Fixed inline (minor)

- **Missing end-to-end test for the headline migration claim.** The handoff's central guarantee — *a
  new v2 member accepts an old v1 record* — was asserted only at the hash-helper level, never through
  `member.update()`. Added `accepts a legacy v1 (unversioned) record and adds our promise — migration
  safety` to the `validateRecord (via update)` block, exercising the real member acceptance path on an
  unversioned record. Green.
- **Duplicate `canonicalJson`.** After this change two copies of the deterministic-JSON canonicalizer
  remain: db-core `membership.ts` (feeds the hash preimages) and `ClusterMember.canonicalJson` (feeds
  equality checks). They must stay byte-identical. Added a `NOTE:` at the `cluster-repo.ts` copy
  explaining the coupling (and that the equality check runs *after* a messageHash gate, so drift can't
  silently forge agreement) and a "promote to one exported helper if a third caller appears" instruction.
  Not promoted now — the second copy has multiple call sites and the system is green; churn wasn't
  warranted.

### Tripwire (recorded, not a ticket)

- The duplicate-`canonicalJson` coupling above is parked as the `NOTE:` in `cluster-repo.ts`
  `canonicalJson`. The implementer's earlier tripwire — `validateRecord` recomputes `membershipDigest`
  (one SHA256) per incoming v2 record; memoize per `messageHash → digest` only if a hot cluster shows it
  as a cost — remains valid and is already a `NOTE:` at that site. Neither is work today.

### Not addressed here (correctly out of scope — follow-up already exists)

- **This is the binding half only.** It does not decide whether a *declared* peer set is a *legitimate*
  cluster for the block; a coordinator can still declare any set and self-consistently sign it. The
  member-side admission check (partition / self-shrink defense) is the follow-up
  `cluster-membership-admission-gate` (referenced by the plan-stage design and annotated in
  `docs/correctness.md` Theorems 1/2). No ticket filed here — it is already planned.
- **Mixed-version fleet asymmetry is an operational contract, not a code defect.** New members accept
  old v1 records; old members reject new v2 records (`Message hash mismatch`). During a partial rollout a
  v2 coordinator's transactions are rejected by not-yet-upgraded members. This is the intended "cluster
  consensus is a single deployable unit — upgrade all members together" posture, documented in the
  handoff. Not enforced in code beyond the rejection; nothing to fix.
- **Not exercised end-to-end over real libp2p.** All tests are in-process. The `*.integration.spec.ts`
  suites are gated/slow and were not run in this pass (nor the implement pass); a reviewer wanting
  cross-node confidence runs `yarn test:integration` in db-p2p out-of-band. Not agent-runnable here.

**No pre-existing failures encountered** (no `tickets/.pre-existing-error.md` written).

## How to reproduce the verification

```
cd packages/db-core && yarn build
cd packages/db-p2p && yarn build
node --import ./register.mjs node_modules/mocha/bin/mocha.js \
  "test/cluster-membership-binding.spec.ts" "test/cluster-repo.spec.ts" \
  "test/cluster-coordinator.spec.ts" "test/transaction-state-store.spec.ts" \
  "test/dispute.spec.ts" --reporter spec
# + regression: signature-validation-integration, cluster-consensus-divergence, cluster-invalidation,
#   cluster-error-propagation, cascade, invalidation, byzantine-fault-injection, quorum-restore
cd ../.. && yarn lint
```
