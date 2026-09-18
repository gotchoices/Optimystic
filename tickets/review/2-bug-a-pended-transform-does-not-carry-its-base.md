description: When a storage node accepts a pending change to a block, the change now arrives with, and is stored with, the version of the block it was written against, so every later step that applies the change can refuse to apply it to a different version, including the steps that have no commit message to consult.
prereq: a-staged-edit-keeps-the-version-it-was-computed-against
files: packages/db-core/src/network/struct.ts, packages/db-core/src/transform/digest.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/collection/collection.ts, packages/db-p2p/src/storage/struct.ts, packages/db-p2p/src/storage/pending-claim.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/cluster/race-resolution.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/block-storage.spec.ts, packages/db-p2p/test/block-lineage.spec.ts, packages/db-core/test/commit-digest-threading.spec.ts, packages/db-core/test/coordinator-pend-bases.spec.ts, docs/internals.md, docs/repository.md, packages/db-p2p/docs/storage.md, docs/correctness.md
difficulty: hard
repro: verified
severity: corruption
likelihood: unusual
----

# A pend carries, and storage keeps, the version each block's change was computed against — implemented, for review

Second of the three tickets split from the plan ticket of this slug. The first (`a-staged-edit-keeps-the-version-it-was-computed-against`, complete) made the writer's base trustworthy; this one is the representation change; the third (`a-rival-pend-is-superseded-only-by-a-writer-that-built-on-it`, in `implement/`, prereq on this slug) reads the new stored base in the rival-pend rule.

The defect was reproduced before the fix: with the stored-base comparison neutered, the plan ticket's two-member scenario promotes the pending record on the member that missed the earlier change and the two members' block hashes differ at the same revision (the negative control below).

## What was built

**Wire.** `PendRequest.baseRevs?: BlockBaseRevs` (a new `Record<BlockId, number>` alias beside `BlockContentDigests` in `packages/db-core/src/network/struct.ts`), produced through `baseRevsField` in `packages/db-core/src/transform/digest.ts` so an empty map omits the key and a pend naming nothing serializes exactly as before. Producers: `TransactorSource.transact` gained a trailing `baseRevs` parameter; `Collection.syncAttempts` passes `tracker.stagedBaseRevs(...)` and retains it on the `InFlightAttempt` so the torn-action re-send in `completeOwnEntry` names the same bases as the operations it re-sends (an addition to the ticket's producer list, for that reason); `TransactionCoordinator.pendCollection` reads the same map from the collection's tracker, the way `commitCollection` reads digests. `NetworkTransactor.pend` narrows the map to each batch's own ids at send time through `pendRequestForBatch`, dropping the action-wide key before spreading the subset; `digestsFor` and the new `baseRevsFor` share one `subsetOf` helper.

**Storage.** `BlockMetadata.pendingBases?: Record<ActionId, number>`, a sibling of `pendingRevs`, written, dropped and swept through the one `BlockStorage.recordClaim` choke point (now taking `{ rev, baseRev } | undefined`, with a `setEntry` helper per map). `IBlockStorage.savePendingTransaction` takes `baseRev: number | undefined` before the latch; `PendingClaim.baseRev?`; `listPendingClaims` joins it; new `IBlockStorage.pendingClaimOf(actionId)` reads one record's claim, joined against the record so an inert entry never reads as a live claim. `deletePendingTransaction` writes metadata when either map has an entry.

**Apply sites** in `packages/db-p2p/src/storage/storage-repo.ts`:

- `pend` stores the base as told, validated only as a number and only for an update-only transform (`declaredBaseFor`, with the `NOTE:` on why the pend never refuses on a mismatch). A base attached to an inserted or deleted block is dropped at pend, so a base-independent record can never read as base-dependent later.
- `internalCommit` now calls `guardCommitBase`: stored base (from the pend) primary, commit declaration fallback; both present and unequal is refused through `refuseMissingBase` with the detail `stored base X disagrees with declared base Y of rev Z` and its own log line `commit:base-disagreement`; then `effective = stored ?? declared` must equal `latest.rev`; neither present applies as before, logged `commit:base-undeclared`. Base-independence is one predicate, `isBaseIndependent` (insert or delete, by truthiness, matching `applyTransform`), keyed on the member's own pended transform.
- The read-driven promotion in `get` calls `mayPromoteOnRead` per entry: base-independent records promote; an update-only record promotes only when its stored base equals `latest.rev` (re-read per entry, so the second of two held records sees the first just landed); anything else declines — record and `latest` untouched, `get:promote-declined` logged, walk stopped for the block.

**One deliberate deviation from the ticket text.** The ticket says a decline sets no `unavailable` flag. It does not, except when this node holds no committed revision of the block at all: there the absent answer below would contradict the pending record the node holds, which is exactly the guess the flag exists to name, and the pre-existing test "flags a context-driven read as unmaterializable when the pending has no base" pins that honesty. So a decline flags `unmaterializable` only when `latest` is undefined. The reviewer should confirm that reading.

**Docs.** `docs/internals.md` (the too-old-read paragraph and the invariant "An update-only transform is applied only to the base its author read", rewritten around the stored base with the base-less residual stated as accepted), `docs/repository.md` ("Declared block content" and "A pending record claims a slot", plus the repoint at the third ticket), `packages/db-p2p/docs/storage.md` ("Block Metadata" now lists both maps with a paragraph, and invariant 3's second paragraph), `docs/correctness.md` (§2's commit-only exclusion paragraph, the Theorem 1 Case 2 repoint, and Theorem 14's "A declaration buys one more thing" rewritten as "used to"). `yarn lint:docs` resolves.

**`NOTE:` sweep.** No code or doc site still names `backlog/bug-a-pended-transform-does-not-carry-its-base`. The rival-check sites now name `a-rival-pend-is-superseded-only-by-a-writer-that-built-on-it`: `isReservationAgainst` in `pending-claim.ts`, `operationsConflict` in `race-resolution.ts`, `docs/correctness.md` §2 and Theorem 1 Case 2, and `docs/repository.md` "A pending record claims a slot". The only remaining occurrences of this slug are the headers of the three new test suites, which name this ticket as their origin. `validatePendOperations` in `cluster-member.ts` and Theorem 9 carried no reference to the old slug.

## Use cases to exercise (all pinned by tests)

- A member that missed a change and then receives a commit that declares nothing for the block (arm one) refuses it and stays behind; a caught-up member lands it. `storage-repo.spec.ts` "with the base carried on the pend".
- A stale pending record from an earlier attempt of a retried action (stored base 4) meets the retry's commit that honestly declares this member's latest (2): refused with the disagreement detail, where a declaration-only guard would have applied it.
- The member is ahead of the stored base, with no declaration at all: refused.
- Neither pend nor commit names a base: applies, as accepted for base-less senders.
- An insert-carrying record with a hostile base on its pend keeps no base and commits; a malformed (string) base or an id the pend does not carry is ignored for that id.
- The plan scenario: two members at rev 1, A takes rev 2 (base 1), B misses it, both hold the pend for rev 3 (base 2); a read on B declines (latest 1, content unchanged, record kept, no flag) and the same read on A promotes to 3; after rev 2 lands on B by `saveReplicatedBlock` the same read promotes B to 3 and the two members' hashes agree. `storage-repo.spec.ts` "read-driven promotion applies a record only to the base it was computed against".
- A base-less record is declined and kept; an insert-carrying and a delete-only record promote regardless of base; a decline on the first missing entry stops the walk; a walk continues past a promoted record to the next whose base it now holds; a decline over no committed revision is flagged and keeps the record.
- The pending overlay branch (`context.actionId`) after a decline answers with the record still held (`state.pendings` names it) rather than a throw.
- `BlockStorage`: base recorded with the claim in one metadata write, joined by both readers, dropped on delete, promotion (`setLatest`), the dead-claim sweep, a same-action replica and `recover`; a redelivered pend overwrites record, slot and base together; metadata without the field reads as base-unknown; an entry whose record is gone is inert. `block-storage.spec.ts`, last suite.
- `NetworkTransactor.pend` gives each peer only its batch's bases, omits the key on an all-undeclared batch and when nothing is named, and subsets at send time on a retry split across coordinators; `Collection.sync` names a base for every update-only block (the log tail included) and never for an inserted or deleted one, equal to the base the commit digest was computed from; a pend message hashes identically after a JSON round-trip by an unaware peer and the field changes the hash. `commit-digest-threading.spec.ts`.
- `TransactionCoordinator.pendCollection` names each collection's own update-only blocks' bases and nothing from the other collection, equal to the commit's digest base. New `coordinator-pend-bases.spec.ts`.

## What was measured

| Check | Result |
|---|---|
| `yarn build` then `yarn typecheck` (root) | clean |
| `yarn workspace @optimystic/db-core test` | 1832 passing (1825 before, plus 7 new) |
| `yarn workspace @optimystic/db-p2p test` | 3041 passing, 63 pending (env-gated) (3023 before, plus 18 new) |
| `yarn workspace @optimystic/quereus-plugin-optimystic test` (after `clean && build` of db-p2p) | 997 passing, 13 pending, smoke ok — the plugin's local transactor passes the pend through unchanged |
| `yarn lint:docs` | 46 documents, all resolve |
| eslint on every touched source and spec file | clean |
| Negative control: `mayPromoteOnRead` forced to `true` and `guardCommitBase`'s stored base forced to `undefined`, `storage-repo.spec.ts` alone | 8 failing, exactly: the three arm-one tests in "with the base carried on the pend", the rewritten own-actionId decline test, and four of the six promotion tests (the insert/delete and walk-on tests pass either way, as they should); restored afterwards and re-verified |

## Test churn the reviewer should expect

- The two `get`-promotion fixtures that pend update-only records (`seedRev1AndPendA2` and the a2 pend in "keeps meta.latest monotonic") now carry `baseRevs`; a3 in the latter deliberately stays base-less because its commit races the promotion and must apply on either interleaving.
- "a promotion refusal on the context's OWN actionId ..." was rewritten to the decline contract (record kept, `state.pendings` names it) and renamed accordingly.
- Every latched `savePendingTransaction` call in the three specs gained an `undefined` base argument.
- A pre-existing weak assertion in "refuses the commit that would fork the block ..." compared two unawaited `canonicalBlockHash` promises (always unequal); it now awaits both. It still holds.

## Known gaps and things to look at

- `pendingClaimOf` is joined against the record, so on the commit path it costs one raw record read that `internalCommit` has already paid for the transform, plus one metadata read. Local KV gets, not measured; kept for contract symmetry with `listPendingClaims`. If the commit path ever shows it in a profile, `internalCommit` can pass the transform it holds and read the metadata alone.
- `commit:base-undeclared` fires on every base-less update-only commit; in the test suites that is most of them (bare `repo.pend` calls). Debug-level only. A reviewer may want the residual counted at a level that is visible in production logs.
- The repo-level `IPendingClaimReader` (the cluster vote's interface) was not given `pendingClaimOf`; the third ticket adds whatever the vote needs.
- The pend-batching tests needed single-member clusters (`MappedKeyNetwork(true)`), because the pend path batches by greedy set cover over `findCluster` and the shared routes put every block on one peer. The commit tests are unaffected. Worth a second look at whether the routes chosen exercise a genuine split on retry (peer-B throws once; b1 lands on C and b3 on A, asserted).
- A record with a base but no slot (a rev-less pend that names a base) is representable in the metadata; no producer sends one, and the sweep still reasons from slots alone, so such a base entry lives until the record is deleted. Harmless; noted so nobody reads the two maps as always co-keyed.
- No pre-existing test failures were seen in any suite.

## Review note from the garden check-in (2026-09-18 ~08:20)

This branch lands after the release cut from `6d43b9f4`, which has no `pendingBases` and no `baseRevs`. Please confirm, with a test if none exists, that block metadata and pending records written by `6d43b9f4`'s code still read and promote correctly under this change. Records with no stored base must fall back to the commit's declaration exactly as the plan intends, and must never be refused, or declined forever, merely for lacking a base. A node upgraded from the release would otherwise wedge on its own leftover pending records.
