description: When one write spans several collections (a table and its indexes) that are agreed in separate rounds of signatures, a node kept only one signature set per write, so a table's change notification could go out signed by the index's round and be refused. Each round's signatures are now kept under the collection it committed, so each notification carries its own.
architecture: docs/internals.md#cohort-topic-origination-bridge-networked-reactivity
files: packages/db-p2p/src/cluster/commit-cert.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/test/cohort-topic/change-bridge.spec.ts, packages/db-p2p/test/cluster-consensus-divergence.spec.ts, packages/db-p2p/test/cluster-invalidation.spec.ts, docs/internals.md, docs/cohort-topic.md, tickets/backlog/feat-a-network-watch-wake-sees-the-whole-commit.md
repro: static
----
# Keep a commit certificate per (action, collection tail)

## What changed

`CommitCertStore` (`packages/db-p2p/src/cluster/commit-cert.ts`) used to be keyed by action id with `put` overwriting, so when one action committed a table and an index as two consensus records (the per-collection fallback when `commitMany` answers `undefined`) and a member in both cohorts applied them concurrently, the table's `CollectionChangeEvent` could resolve the index record's certificate. The store is now keyed by `(actionId, tailId)`:

- `put(actionId, cert, tailIds, now?)` — one entry per tail; `[]` writes nothing (a sweep record, whose events never originate); `undefined` writes an action-wide entry (an invalidation).
- `get(actionId, tailId, now?)` — the per-tail entry, else the action-wide entry, else `undefined`. Commit records never write action-wide entries, so the fallback cannot cross collections.
- One `Map` keyed by `JSON.stringify([actionId, tailId ?? null])` — no separator ambiguity even though action ids are not format-checked; TTL and the cap count per entry, eviction unchanged (insertion order).
- `committedTailIds(commits)` (new, same file) — the tails a record commits: `commits.filter(c => c.blockIds.includes(c.tailId)).map(c => c.tailId)`, the same test `selfAppliedTail` applies to the event.
- `makeClusterCommitCertExtractor` reads `store.get(event.actionId, event.tailId)` and logs the tail when nothing is retained.
- `CommitCertificateSink` (also the public `NodeOptions.onCommitCertificate`) gains a third argument `tailIds: readonly BlockId[] | undefined`; two-argument sinks still type-check. `ClusterMember.applyConsensusCommits` passes `committedTailIds(commits)` through `captureConsensusCommitCert` → `captureCommitCert`; the invalidation capture passes `undefined`, with a `NOTE:` that an invalidation event will need a `tailId` among its `blockIds` to pass `selfAppliedTail` once the dispute subsystem is wired. The sink still fires once per record that reaches `minSigs`, the sweep's included (with `[]`).
- The composed sink in `createLibp2pNodeBase` forwards `tailIds` to both `certStore.put` and the caller's sink.

Docs: `docs/internals.md` § Change Notification no longer gives this defect as a reason the catch-all feed is not held (the remaining reasons — rotation detection and the owned-block feed want no delay — stand; holding it for origination stays with backlog `feat-a-network-watch-wake-sees-the-whole-commit`, whose arm now says this prerequisite has landed). § Cohort-Topic Origination Bridge: diagram updated and a new bullet "One cert per collection tail, not per action". Same rewording in the `emitCollectionChanges` doc comment in `storage-repo.ts`. Two "keyed by action" asides in `docs/cohort-topic.md` now say "keyed by action and collection tail". The catch-all feed is still never held — that behaviour is untouched.

## Tests

- New: `change-bridge.spec.ts` "CommitCertStore: each record of one action keeps its own cert under the tail it committed" — the reproduction: certT under `(A, [tailT])`, certI under `(A, [tailI])`, then a sweep put `(A, [])`; the extractor resolves certT for the table event and certI for the index event (the old store returned certI for both); no action-wide fallback appears for a commit; an action-wide put is found by any tail and by `undefined` but does not shadow a per-tail entry of the same action.
- Updated to the new signatures: the store round-trip/TTL/cap test, the extractor test (event now carries `tailId`), the end-to-end bridge test.
- `cluster-consensus-divergence.spec.ts` "fires onCommitCertificate…" now asserts the record's tail (`['block-1']`) arrives as the third argument; `cluster-invalidation.spec.ts` "captures the invalidation commit cert…" asserts `undefined` arrives.

Ran: `yarn workspace @optimystic/db-p2p build`, `tsc --noEmit` (includes `test/`), full `yarn test` in `packages/db-p2p` (3529 passing, 74 pending), `OPTIMYSTIC_INTEGRATION=1` `substrate-real-libp2p.integration.spec.ts` (14 passing), `yarn lint:docs` (green). Did not run the whole `yarn test:integration` fan-out or the quereus plugin suites (no code there references the sink or store).

## Known gaps / for the reviewer

- The race itself (two records of one action interleaving on one member) is not reproduced end to end; the test is at the store/extractor layer, as the ticket specified. Repro remains `static`.
- `selfAppliedTail` and `committedTailIds` express the same rule in two places (one over a `CollectionChangeEvent`, one over `CommitRequest`s). They are cross-referenced in comments but not shared code; the shapes differ, so I left them separate.
- `reactivity-mesh-harness.ts` keeps its own `certByAction` map keyed by action and never touches `CommitCertStore`; it builds one cert per commit of one collection, so it is unaffected, but it would not catch this class of bug.
- A batch record retains the same cert under each of its tails — N entries against the 4096 cap for an N-collection batch. Not measured; the cap is a backstop and entries live 60 s.
