description: A machine that had just joined a group and was still catching up could veto other machines' writes, because its vote rebuilt the whole block just to check a version number. The vote now reads the version number and the pending reservations straight from storage's bookkeeping, so a catching-up machine is judged the same whether or not it can rebuild the block yet.
files: packages/db-p2p/src/cluster/cluster-repo.ts (validatePendOperations, judgeStaleRevisions, onceGet, heldLatestOf, rivalClaimsOn, reservingRivals, noteStaleLossUnvoted), packages/db-p2p/src/storage/storage-repo.ts (IHeldRevisionReader and IPendingClaimReader doc comments, the NOTE in get's per-block catch), packages/db-p2p/test/cluster-repo.spec.ts ("update - the pend vote reads metadata, not blocks"), docs/internals.md (the "three answers" bullet)
difficulty: medium
----
Reported from sereus on `@optimystic/*` 1.12.0: a strand replica that had just joined a 3-member cohort and was still pulling blocks voted `reject` with `block <id> unavailable (unmaterializable): cannot verify revision`, which failed the write non-retryably about 1 run in 4 under load.

## What was wrong

The promise-round vote (`ClusterMember.validatePendOperations`) needs two facts per block, both of which storage keeps in metadata: the committed `latest` revision (stale-revision check) and the pending records with their claimed slots (reservation / `held` check). It fetched them through a full `StorageRepo.get`, so:

- **Arm 1.** A member whose held `latest` would not materialize got `{ state: {}, unavailable: 'unmaterializable' }` back — `latest` dropped — and voted reject, although it knew the revision. The same member holding *no* metadata for the block approved, so two shapes of "no usable base here" got opposite answers.
- **Arm 2.** `get` lists `state.pendings` only beside a block it materialized, so a rival's pending record on a block with no committed revision (or an unmaterializable one) was invisible to the vote, though `StorageRepo.pend` (policy `'r'`, what production sends) refuses it at apply.

## What changed

`validatePendOperations` now reads what `StorageRepo.pend` reads at apply:

- `latest` via `IHeldRevisionReader.heldRevisions` (`heldLatestOf`). Known → stale judgement as before (`staleRevisionAgainst`). `null` → never committed, not stale. Left out (metadata unreadable) → **no answer, no veto**: logged as `cluster-member:validation-block-unavailable` (now with `actionId` and `requestedRev` instead of `reason`) and skipped. The `cannot verify revision` reject is gone. The stale check moved into its own method, `judgeStaleRevisions`.
- Rivals via `IPendingClaimReader.listPendingClaims` (`rivalClaimsOn`), fed straight into `reservingRivals` (now synchronous, takes claims instead of re-reading them).
- Fallbacks for a repo without those capabilities (test doubles): one memoized `get` per vote (`onceGet`). An `unavailable` entry is "no answer" for the revision; `state.pendings` become claims with no slot, which `isReservationAgainst` already counts as reserving — the same "every rival reserves" degradation as before. A `listPendingClaims` throw logs `cluster-member:pending-claims-read-error` and takes the same `get` fallback.
- `noteStaleLossUnvoted` (the loss count for a record that arrives already refused) uses `heldLatestOf` too, so it and the vote still share one stale rule.
- Docs: the `docs/internals.md` "three answers" bullet no longer says the vote rejects; it describes the metadata reads and the no-answer rule. Doc comments on `IHeldRevisionReader` / `IPendingClaimReader` name the vote as a consumer, and the `NOTE:` in `StorageRepo.get`'s catch points revision-only consumers at `heldRevisions`.

## Behaviour changes a reviewer should weigh

- **Tombstoned blocks are now judged at the vote.** `get` drops `latest` for a tombstoned block, so the vote used to approve a pend at or below the tombstone's revision and storage refused it at apply. `heldRevisions` returns the tombstone's revision, so the vote now rejects it as stale — the same answer storage gives, just one round earlier.
- **New `held` votes on blocks with no committed revision.** The obvious case: two writers creating the same collection at once, since the header block id is the collection name. Before, the vote approved and storage refused at apply; now the vote says `held`, which the coordinator returns as a retryable conflict. The integration test "B writes and converges after both nodes invented the collection" still passes.
- **A member that cannot read a block's metadata no longer blocks consensus by itself.** It never could stop a stale write alone: caught-up members still run the check, the fork guard in `StorageRepo.internalCommit` refuses an update-only commit over a base this member does not hold, and `CoordinatorRepo.commit` acknowledges only what a majority holds. That is the same position the content-digest check already takes for an unmaterializable base.

## Tests added (all in `packages/db-p2p/test/cluster-repo.spec.ts`, describe "update - the pend vote reads metadata, not blocks")

- "judges a held revision that will not materialize: approves a pend past it, rejects one at it" — **arm 1 reproduction.** Real `StorageRepo` over `MemoryRawStorage`; a forward tombstone at rev 5 on a fresh block (`BlockStorage.saveDeletion`) gives a `latest` that will not materialize, asserted as a precondition (`get` answers `unavailable: 'unmaterializable'`). A pend at rev 6 is approved, and one at rev 5 is rejected with the exact signed `stale revision` reason.
- "holds a pend behind a rival record on a block with no committed revision" — **arm 2.** Real `StorageRepo`; the rival pends an insert at rev 1, with a precondition that `get` lists no `pendings`. Our pend at rev 1 gets `held` with `heldBy` naming the rival.
- "does not veto when a get-only repo answers the block unavailable" — the fallback rule. Replaces the old "rejects a pend whose block read came back unavailable", which pinned the behaviour this ticket reverses. Asserts approve plus the `validation-block-unavailable` log line.

I did not run the new tests against the pre-change code (that would have meant stashing the tree). They were written against the old behaviour by construction: the old code returns reject, approve and reject where they expect approve/reject, held and approve, and the preconditions pin the storage shape each one needs.

## Validation run

- `OPTIMYSTIC_SKIP_BUILD_CHECK=1 yarn test` in `packages/db-p2p`: 3275 passing, 70 pending, 0 failing (includes `member-missed-commit-heals-at-commit`, `cluster-pend-held-vote`, `cluster-pend-staleness`).
- `OPTIMYSTIC_SKIP_BUILD_CHECK=1 yarn test:integration` in `packages/db-p2p`: 50 passing, 2 pending.
- `npx tsc --noEmit -p tsconfig.json` in `packages/db-p2p` (src + test): clean. `npx eslint` on the three changed files: clean. `yarn lint:docs`: all citations resolve.
- I used `OPTIMYSTIC_SKIP_BUILD_CHECK=1` because the sibling Fret checkout (`C:\projects\Fret`) has someone else's uncommitted edits, so the freshness guard reports `p2p-fret` stale. I did not rebuild their in-flight work. Nothing here touches Fret. The quereus-plugin integration suite and the full `yarn check` were not run.

## Known gaps

- **Root cause of the sereus member's unmaterializable `latest` is still not identified.** This fix removes the vote's dependence on materialization whatever the cause. **For the sereus reporter:** if the veto or anything like it recurs, capture with `optimystic:db-p2p:storage-repo,optimystic:db-p2p:block-storage` added to the debug namespaces. The `get:unmaterializable … error=…` line names which path left the member with a `latest` it cannot materialize.
- **Degraded arm 2.** If `listPendingClaims` throws on a real `StorageRepo`, the `get` fallback still lists no rivals on a block with no committed revision. The apply-time scan in `StorageRepo.pend` remains the backstop there.
- **A throwing `heldRevisions`** (only possible through a decorator, since `StorageRepo`'s implementation catches per block) escapes the vote the way a throwing `get` always did. That behaviour is unchanged.
- **Out of scope, as in the fix ticket:** the report's second fingerprint, `commit-not-durable: 0 of 3 cohort member(s) report holding rev 8 … (local-executed)` (seen once on 1.11.0). No code site has been found for it, and nothing here changes the durability gate.
