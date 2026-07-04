----
description: Two block-restoration paths that used to trust a single peer's self-reported "latest version" now require a quorum of peers to agree (and matching bytes for content) before accepting. This is the completed review of that change.
prereq:
files: packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/reputation/types.ts, packages/db-p2p/test/quorum-restore.spec.ts, packages/db-p2p/test/coordinator-repo-read-repair-trust.spec.ts, docs/internals.md
----

# Review complete: read-repair + reconcile now verify peer claims by quorum

## Summary

The implementation replaces "the highest revision any single peer reports wins"
with "the highest `(rev, actionId)` corroborated by a quorum of distinct peers
wins", and additionally gates the reconcile path on byte-identical block content
agreeing across a quorum. Shared primitives live in the new
`cluster/quorum-restore.ts`. The core logic is sound, well-tested at the unit
level, and the security property (a minority of lying peers cannot steer
restoration) holds.

Review verdict: **accept with one follow-up ticket filed and three tripwires
recorded.** Nothing blocking; no regressions.

## Validation run during review

- `cd packages/db-p2p && npx tsc --noEmit` → exit 0.
- `yarn test` (full suite) → **1144 passing, 36 pending**, matches the handoff.
- Focused specs (`quorum-restore.spec.ts`, `coordinator-repo-read-repair-trust.spec.ts`,
  `coordinator-repo-read-repair.spec.ts`) → all green.
- Re-ran typecheck + focused specs after the review's comment/doc edits → green.

## Review findings

### Checked, no issue
- **Threshold plumbing.** `CoordinatorRepo` applies the `0.51` default when the
  policy omits `simpleMajorityThreshold`, so the quorum math never sees `undefined`
  (a `NaN` quorum would silently decline everything). `consensusConfig.simpleMajorityThreshold`
  is likewise a concrete `0.51` in `libp2p-node-base`.
- **`reputation` binding in reconcile** is a non-optional `PeerReputationService`
  and every `reportPeer` call is wrapped in try/catch — a reputation write cannot
  block or throw in the restore path. Same for read-repair's penalize helper.
- **Reconcile content-penalty basis is provable.** Penalizing a peer that serves
  block bytes hashing differently from the quorum-agreed content for the *same*
  committed `(rev, actionId)` is genuine, detectable misbehavior. Kept as-is.
- **Distinct-voter counting, small-cluster fallback, highest-rev preference,
  content-split decline** all behave as documented and are unit-covered.
- **Archive shape.** The reconcile candidate build correctly guards `data?.action`
  before reading `actionId` and keeps `block` optional (rev claims don't require
  bytes; the content gate filters for bytes separately).

### Fixed inline (minor)
- **Stale doc.** `docs/internals.md` §"A *behind* member actively reconciles"
  described `reconcileBlock` as pulling the revision "from a cohort peer that
  holds it" — single-peer-trust language that no longer matches the code. Rewrote
  it to state the quorum-corroboration + content-hash gate and the "no quorum →
  leave for churn/rebalance retry" behavior.

### Filed as a follow-up ticket (major)
- **Read-repair penalizes non-provable claims.** `penalizeContradictingRevClaims`
  penalizes any peer reporting `rev > selected.rev`. That is not provable
  misbehavior: an honest peer legitimately *ahead* of the sampled quorum — an
  in-flight commit it durably stored, or other honest holders dropped from the
  sample by the 1-second per-peer timeout — reports a higher rev and is penalized
  (weight 30, above the deprioritize threshold of 20 → a single false hit
  deprioritizes an honest, up-to-date peer). Declining to *restore* on the
  uncorroborated claim is correct and stays; the extra reputation penalty on
  ambiguous evidence is the defect. Not fixed inline because it reverses a
  deliberately-tested assertion (the trust spec asserts the `rev:99` liar is
  penalized) and the correct discrimination needs commit-cert verification — a
  design call, not a mechanical edit. Filed
  `backlog/debt-read-repair-penalty-provable-only.md`; a `NOTE:` at the penalize
  site indexes it.

### Tripwires recorded (conditional; not filed as tickets)
- **Content-quorum denominator** — `NOTE:` at the reconcile content gate
  (`libp2p-node-base.ts`). `selectQuorumBlock` recomputes its quorum over only the
  block-*carrying* corroborators, not the full rev-responder set, so if most peers
  corroborate the rev but few carry bytes (e.g. mid-prune) the content quorum can
  shrink to 2. Harmless with honest peers; a colluding pair becoming the only
  block-servers is the Sybil regime already deferred to
  `debt-read-repair-commit-cert-verification`.
- **Single-responder fallback vs a missing block** — `NOTE:` at the fallback in
  `selectQuorumRev` (`quorum-restore.ts`). The code's "declining is safe because
  local keeps its data" rationale holds when repairing a *stale* block, but for a
  *missing* block the caller has no local copy, so the fallback accepts a single
  uncorroborated peer's claim (availability over integrity) in the degraded
  one-responder regime. Reconcile is unaffected — its content gate has no fallback.
- **`floor` vs strict-majority quorum** — carried over from the implementer's
  handoff (their gap #4). `quorumSize` uses `floor`, per the source ticket's spec,
  so at N=5 responders quorum is 2, not a strict majority of 3. This still defeats
  the single-liar threat (1 < 2) and is the prescribed rule, so it is intentional,
  not a defect. Left as-is; recorded here for the next reader.

### Known gaps from the handoff — dispositions
- **No end-to-end test for `reconcileBlock` wiring** (handoff gap #1) and **the
  mesh-harness double still does single-peer trust** (gap #2). Accepted: the
  quorum/content logic is fully unit-tested via `quorum-restore.spec.ts`, and
  read-repair is exercised end-to-end through `CoordinatorRepo`. Adding a mesh
  integration test for the reconcile closure is worthwhile but is test-hardening,
  not a correctness gap in the production path — not filed as a ticket this pass;
  a future integration/harness pass can pick it up alongside the mesh-harness
  fidelity fix.
- **Sybil resistance** (gap #3). Out of scope by design; the existing backlog
  ticket `debt-read-repair-commit-cert-verification` covers it. The new
  `debt-read-repair-penalty-provable-only` overlaps it (a valid commit cert is the
  complete form of "provable") and cross-references it.
