description: Emit a change event when a block lands on a node via churn re-replication, so reactive watchers on the new owner are woken.
prereq:
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/storage-repo.spec.ts
difficulty: easy
----

## What was done

`StorageRepo.saveReplicatedBlock` now emits a tail-less `CollectionChangeEvent` after a genuine
advance, matching the read-driven promotion path. The decision is captured under the
`StorageRepo.commit:<id>` latch (covering `getLatest` + `saveReplica` + advance-detect) and emitted
after the latch releases, mirroring the commit path's ordering.

### Key change (`storage-repo.ts`, `saveReplicatedBlock`)

- Reads `priorLatest = await storage.getLatest()` inside the latch, before `saveReplica`.
- Captures `effective = await storage.saveReplica(block, source)`.
- Derives `advanced = priorLatest === undefined || effective.rev > priorLatest.rev`.
- Guards on `block.header?.collectionId !== undefined` (mirrors `internalCommit`'s headerless defense).
- Emits via `emitCollectionChanges(...)` after `release()`, with no `tailId` — correct for a tail-less
  event; the cohort-topic bridge drops such events via `selfIsCohortMember` (and again via the
  cert-extraction gate).

## Validation

`yarn build` clean. `yarn test` in `packages/db-p2p`: **1018 passing, 31 pending, 0 failures**
(exit 0). The lone `storage-repo.spec.ts` block runs 41 passing (was 39 before this review's added
tests).

## Review findings

Adversarial pass over commit `05d9af4` (the implement diff), read fresh before the handoff summary.

### Checked

- **Correctness of `advanced` detection** — verified every branch: fresh (prior `undefined`),
  equal-rev monotonic no-op, older-rev drop, and advance-over-held. `saveReplica`
  (`block-storage.ts:126`) always returns `meta.latest`, so `effective.rev` is never below
  `priorLatest.rev`; no spurious or missed emits. A same-rev/different-actionId re-push correctly
  does **not** double-emit (guard returns held latest, `effective.rev === priorLatest.rev`).
- **Concurrency / latch discipline** — the `getLatest` + `saveReplica` read-modify-write is
  serialized against concurrent `commit()` on the same block under the shared
  `StorageRepo.commit:<id>` latch; emission is fire-and-forget after `release()`, so a throwing
  listener (isolated in `fireChangeListeners`) cannot affect the latch or durability.
- **Cohort-topic safety (the load-bearing claim)** — confirmed in
  `reactivity-membership-gate.ts:70-72` that `selfIsCohortMember` returns `false` for a tail-less
  event, and `change-bridge.ts` `extractCommitCert` is a second gate (a replica-persist has no
  commit cert). A replica-persist event therefore cannot re-originate a signed cohort-topic
  notification — no fan-out storm.
- **Type safety / build** — `tsc` clean; `CollectionId` already imported; signatures unchanged.
- **Error handling / resource cleanup** — `release()` in `finally`; on a `saveReplica` throw,
  `landed` stays `undefined` and nothing is emitted.
- **Docs** — the change-notification / reactivity subsystem is not documented in `docs/`
  (`storage.md`, `repo.md`, `cluster.md` make no mention of it), so this change leaves no stale
  prose. Behavior is captured in code comments, which are accurate.

### Found & fixed (minor — fixed in this pass)

- **Test coverage gap: advance-over-held-rev branch.** Every existing test started from an
  `undefined` prior, so the `priorLatest !== undefined && effective.rev > priorLatest.rev` branch
  (the actual churn scenario the ticket targets) was never exercised. Added
  `'replica advancing over an older held rev fires a second event'`.
- **Test coverage gap: source-less path.** The handoff listed the no-`source` hash-fallback case as
  a use case but no test covered it. Added
  `'source-less replica uses hash-fallback actionId and stays idempotent'` (first push fires once at
  rev 1 with a deterministic non-nil actionId; identical re-push is a no-op).

### Found — not fixed (out of scope, noted)

- **Dangling doc references (pre-existing).** Code comments in `reactivity-membership-gate.ts` and
  `change-bridge.ts` cite `docs/reactivity.md` and `docs/internals.md`, which do not exist anywhere
  in the repo. Not introduced by this ticket and unrelated to the replica-persist change; left for a
  separate docs pass.
- **No end-to-end multi-node integration test** for the reactive-watch wake path. Tracked in
  `tickets/backlog/enhancements/optimystic-network-reactive-watch-integration-test.md`. The
  `changeListeners` registry is node-local; this change does not alter cross-node behavior.

### Major findings

None. No new tickets filed.

## End
