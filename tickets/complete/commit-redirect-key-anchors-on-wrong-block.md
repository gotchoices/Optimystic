description: A peer deciding whether to forward an incoming commit to another group was checking the wrong block, so multi-block writes could be bounced to a group that can't handle them. Fixed the routing key and added regression tests.
prereq:
files:
  - packages/db-p2p/src/repo/service.ts (deriveBlockKey extracted; commit redirect now keys on blockIds[0])
  - packages/db-p2p/test/redirect.spec.ts (deriveBlockKey derivation tests + large-mesh commit redirect regression test)
  - packages/db-p2p/src/repo/coordinator-repo.ts (commit handler — anchors on blockIds[0], guards verifyResponsibility(blockIds))
  - packages/db-core/src/network/struct.ts (CommitRequest = ActionBlocks + tailId + rev)
difficulty: medium
----

# Commit redirect key anchored on the collection tail, not the block(s) being committed — COMPLETE

## Summary of the fix (implement stage)

`RepoService.handleIncomingStream` redirect-checks each op against the cluster of an op-specific
`blockKey` before handling it. The **commit** branch derived `blockKey` from `operation.commit.tailId`,
but the handler it protects — `CoordinatorRepo.commit` (coordinator-repo.ts:402-419) — anchors consensus
on `blockIds[0]` and guards with `verifyResponsibility(blockIds)`. For a per-block commit batch whose
`blockIds[0] !== tailId`, the coordinator was redirect-checked against the **tail's** cluster and, if not
a member, bounced the commit to a cluster that then fails `verifyResponsibility` for the non-tail block.

The implement stage:
- Extracted per-op key derivation into a pure, public `deriveBlockKey(operation)` on `RepoService`.
- Fixed the commit case to key on `operation.commit.blockIds[0]` (was `tailId`).
- Rewrote `handleIncomingStream` dispatch to derive once → redirect-check iff key defined → dispatch,
  removing four duplicated redirect blocks.
- Added a `deriveBlockKey` describe and a large-mesh commit-redirect regression describe to
  `redirect.spec.ts`.

## Review findings

### What was checked

- **Correctness of the fix** — confirmed against the protected handler. `CoordinatorRepo.commit`
  (coordinator-repo.ts:402-419) anchors `getClusterSize(blockIds[0])` / `executeClusterTransaction(blockIds[0])`
  and `verifyResponsibility(blockIds)`. `CommitRequest = ActionBlocks & { tailId, rev }` (struct.ts:67),
  so `blockIds` is a typed field and `blockIds[0]` is the right anchor. Keying on `blockIds[0]` is now
  consistent with get/cancel and with the handler. ✔
- **Dispatch-rewrite behavior parity** — verified. The one behavioral difference (an op with an
  empty/undefined key no longer calls `checkRedirect`, so `(message as any).cluster` is not attached for
  that degenerate case) is immaterial: `service.ts:181` is the only writer of `message.cluster`, and the
  only reader is the test suite — nothing in production consumes it. The repo handlers receive
  `operation.<op>` + `message.expiration`, never `message.cluster`. ✔
- **Type safety** — `deriveBlockKey` returns `string | undefined`; the caller guards on
  `blockKey !== undefined`. Build/typecheck of `db-core` and `db-p2p` both exit 0. ✔
- **Tests** — `redirect.spec.ts`: 19 passing (6 new), including the regression assertion that a non-tail
  commit batch derives `blockIds[0]` not `tailId`, and an end-to-end keyed-network-manager test proving
  the redirect fires toward `block-A` and would NOT fire if keyed on `tail-Z`. The keyed network manager
  maps real sha256 digests (the same hash `checkRedirect` computes), so the distinction is genuine. ✔
- **Lint** — repo `lint` script is a no-op placeholder (`"echo 'Lint not configured...'"`); nothing to
  run.
- **Docs** — no doc files reference the commit redirect keying; nothing to update. The `deriveBlockKey`
  doc-comment accurately describes the new behavior.

### What was found

- **No issues in the commit fix itself** — minor or major. The change is correct, scoped, tested, and
  behavior-preserving.

- **Pre-existing flaky test (not mine).** The full `db-p2p` suite surfaced one intermittent failure,
  `reactivity / mesh — slow-subscriber isolation` (`CohortBackoffError: … retry after 1000ms`, in the
  cohort-topic / reactivity subsystem). It passed in isolation and passed on an immediate re-run of the
  full suite (732 passing / 0 failing). It is timing-based, outside this ticket's diff, and likely tied
  to the preceding `cohort-topic-topic-budget-eviction-leak` ticket. Flagged in
  `tickets/.pre-existing-error.md` for the runner's triage pass; not addressed here.

- **MAJOR — two pre-existing latent bugs of the same class, out of this ticket's commit-only scope →
  filed as follow-up `fix/` tickets:**
  1. `fix/pend-redirect-key-uses-structural-field-not-block-id` — `deriveBlockKey`'s `pend` branch uses
     `Object.keys(operation.pend.transforms)[0]`, which yields a structural field name
     (`'inserts'`/`'updates'`/`'deletes'`) rather than a block id, because `PendRequest.transforms` is a
     `Transforms` (`{ inserts?, updates?, deletes? }`), not a block-id-keyed map. Correct derivation is
     `blockIdsForTransforms(...)`. Confirmed against `transform/struct.ts` and `transform/helpers.ts`.
     The existing pend tests pass a flat `{ 'block-A': {} }` that doesn't match the real shape, so the
     fix must also rework those fixtures.
  2. `fix/coordinator-cache-hint-keys-wrong-block-and-encoding` — `RepoClient.extractKeyFromOperations`
     (client.ts ~101-119) and `ClusterClient.recordCoordinatorForRecordIfSupported` (cluster/client.ts
     ~53-65) key commit on `tailId`, pend on the structural field name, and encode with raw
     `TextEncoder().encode` instead of `blockIdToBytes` (sha256) — so the cache hint is a no-op today and
     would misroute if the encoding were corrected without fixing block selection. Confirmed by reading
     both files.

### Disposition

- Minor findings fixed in this pass: **none** (no minor issues in the in-scope change).
- Major findings: **2**, both filed as `fix/` tickets above (independent, no prereq between them; neither
  blocks this ticket — the commit fix stands on its own).
- Pre-existing failure: flagged via `.pre-existing-error.md`.

## Validation re-run during review

- `yarn build:db-core` + `yarn build:db-p2p` — exit 0.
- `redirect.spec.ts` — 19 passing.
- Full `db-p2p` suite — 732 passing / 27 pending / 0 failing on the clean re-run (one flaky failure on a
  prior run, documented above).
