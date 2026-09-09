description: A storage node that missed updates to a block used to apply the next update on top of its stale copy, silently giving that node different content under the same revision number. It now refuses such a commit and heals from a peer instead.
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/test/storage-repo.spec.ts, docs/internals.md, docs/repository.md, docs/correctness.md, packages/db-p2p/docs/storage.md
----

# Fork guard in `StorageRepo.internalCommit`, keyed on the writer's declared per-block base

## What landed

`StorageRepo.internalCommit` gained a seventh parameter, `declaredBaseRev?: unknown`, forwarded from `commit`'s per-block loop as `request.blockDigests?.[blockId]?.baseRev`. Immediately after `const latest = await storage.getLatest();`:

```ts
if (typeof declaredBaseRev === 'number' && !transform.insert && latest?.rev !== declaredBaseRev) {
	return await this.refuseMissingBase(blockId, actionId, rev, storage, latch,
		`local latest ${latest?.rev ?? 'none'} is not the declared base ${declaredBaseRev} of rev ${rev}`);
}
```

`baseRev` is the committed revision the writer read the block at, pinned when the update was staged and already riding inside every cohort signature preimage. Comparing against it — rather than against `rev - 1` — is what distinguishes a routine gap from a missed update: revisions are allocated per **collection**, so a member holding block X at rev 1 legitimately receives a commit of X at rev 7 when revs 2-6 touched other blocks. A `rev - 1` check breaks that, and is pinned against by `storage-repo.spec.ts` "commits across an arbitrary revision gap when a base IS held".

The refusal needed no new plumbing: `refuseMissingBase` throws `MissingBaseRevisionError`, `commit` already classifies that as divergence and drops the batch's unpromotable pendings, `ClusterMember.applyConsensusOperation` already maps `missing-base-revision` to "behind" divergence and runs `reconcileDivergentCommit`, and `CoordinatorRepo` already tolerates the reason.

Two doc blocks in `cluster/cluster-repo.ts` whose justification prose went stale with the guard were corrected (`validateCommitRevisions`, `validateCommitDigests`).

Implement stage: 269 insertions across three files, eight tests. Review stage added two more tests, four doc updates, three `NOTE:` blocks, one backlog ticket, and retired one blocked ticket.

## Validation

- `yarn lint` — clean. `yarn lint:docs` — 45 documents, 75 anchored citations, 586 file mentions, 330 links, all resolve. `yarn typecheck` (all workspaces) — clean.
- `yarn workspace @optimystic/db-p2p test` — **2632 passing, 49 pending, 0 failing** (2622 before this ticket; +8 implement, +2 review).
- `yarn workspace @optimystic/db-core test` — **1605 passing, 0 failing**.
- Negative controls, both stages. Implement: with the guard's comparison neutered, exactly the three refusal tests fail and the four abstain tests still pass. Review: with `divergentFailure = err instanceof MissingBaseRevisionError` replaced by `false`, exactly the new mixed-batch test fails. Both mutations reverted and re-run green.
- Downstream `../sereus` `control-write-degraded-cohort-member.integration.ts`, guard off vs on: `cluster-member:content-digest-mismatch` 20 to 0, `commit:missing-base` 0 to 6. That scenario is independently broken (5 of 7 tests fail with the guard disabled too), so its failures are not fallout from this work; the numbers above are log-line counts, not a pass/fail claim. Measured during implement; not re-run during review (out-of-repo, minutes per run).

## Review findings

Read the implement diff first, then traced `baseRev` end to end before reading the handoff.

### Premise verification — checked, no defect found

- **`baseRev` really is the block's own revision, not a collection revision.** Traced producer to consumer: `Tracker.update` pins the base when an update is staged, `Tracker.peekMaterialized` returns `pin.rev`, `computeBlockContentDigests` collects it, `blockDigestsField` attaches it, `digestsFor` narrows it per coordinator batch, and the guard reads it. The number originates as `GetBlockResult.materialized.rev`, documented as "the highest committed revision at or below the pin" — the same quantity as the member's block-level `latest.rev`. The comparison is apples to apples.
- **The obvious false-positive route is not reachable.** If a block could be *updated* on the strength of a read excluded from the optimistic-concurrency conflict set, an honest writer could declare a stale base and be refused. It cannot: `navigation`-purpose reads (the only droppable kind) are produced solely by the point-lookup descent in `btree.ts`, and every write descent reads at `value` purpose, so any block a transaction updates is in its conflict set and a stale base is rejected a round earlier.
- **Idempotent redelivery cannot trip the guard.** After rev N lands, `latest.rev` no longer equals the declared base, so a redelivery would refuse — except `commit` partitions `latest.rev >= request.rev` into already-done/stale *before* the per-block loop. Correct, but it was an undocumented dependency; now pinned by a test.
- **Hostile input.** The `!transform.insert` arm keys on the member's own pended transform, so no declaration can flip it. A junk numeric `baseRev` can force refusals and reconcile churn but never a fork — already stated at the site.

### Major — one ticket filed

**The guard only reaches what the writer declared, and two paths declare nothing.** Filed as `backlog/bug-a-pended-transform-does-not-carry-its-base`, at the representation rung rather than as a point fix: the version a change was authored against travels separately from the change itself (on the *commit* message, optional per block) instead of with the pended transform, so any apply site that lacks a commit message has nothing to check. Two arms:

- A commit that declares no digest for the block (older writer, undeclarable block, delete-only transform) gap-applies exactly as before. The implementer identified and documented this arm.
- **The read-driven promotion in `StorageRepo.get` forks the same way, and the handoff did not identify it as a fork vector.** That loop walks `context.committed` in revision order and silently skips any entry whose pending it does not hold, then promotes the next one over the stale base. It cannot be guarded with today's information — `context.committed` is a collection-level `(actionId, rev)` list with no per-block base, and "no pending for that action" is the normal case for the many actions that never touched this block, which is the same unsoundness that killed the `rev - 1` idea. A `NOTE:` was added at that loop pointing at the ticket, and the guard-site `NOTE:` was widened from one arm to two.

Not reproduced: the ticket is filed `repro: static`, with the test that would confirm it spelled out.

### Minor — fixed in this pass

- **Docs still stated the pre-guard rationale as current fact.** `docs/internals.md` "Commit content-digest check (promise round)" said a lagging member "legitimately materializes different bytes" — the identical stale sentence the implementer corrected in `cluster-repo.ts` but not in the document that code points readers at. Rewritten to the post-guard rule: the member cannot *judge* the content so it abstains, and it never materializes those bytes because apply time refuses.
- **The new invariant was nowhere in the docs.** Added a "Key Invariants" bullet to `docs/internals.md` ("an update-only transform is applied only to the base its author read") stating the rule, why revision arithmetic cannot substitute for it, and the two arms it does not reach; and a matching paragraph to `packages/db-p2p/docs/storage.md`, whose invariant section 3 previously named the missing-base refusal as enforcing only the materializability rule.
- **`baseRev` gained a second consumer with a user-visible consequence.** Declaring content now also buys fork protection, so *not* declaring has a second cost alongside the replication cost already documented. Added to `docs/repository.md` "Declared block content" and to `docs/correctness.md` "The cost of not declaring".
- **Two test gaps the handoff named.** Added "drops a not-yet-reached sibling's pending when the refusal is a declared-base mismatch" (the mixed-batch path, previously covered only through the no-base refusal) and "does not refuse the idempotent redelivery of a revision it already landed". The first was confirmed load-bearing by negative control.

### Tripwires — recorded, not filed

- **The ahead-of-declared-base arm is labelled "behind".** A member holding more than the writer saw refuses through the same `missing-base-revision` reason, so `ClusterMember` reconciles as if it were lagging; in a cohort where nobody holds the revision that ends in `no-rev-quorum` rather than a clean stale failure. The outcome is right — the writer read a base the cohort moved past, and its retry re-reads — but the log reads as the opposite of the truth. Parked as a `NOTE:` at the guard site, with the closure (a distinct reason string for the ahead arm) named.

### Checked, judged adequate, nothing filed

- **Cluster-tier coverage.** The handoff flags that no db-p2p test exercises declared-base refusal through `ClusterMember` reconcile to convergence end to end. The refusal rides on the pre-existing `missing-base-revision` reason, so it inherits that mapping and its tests; and the specific untested seam — `reconcileDivergentCommit` having no mesh-level test — is already an open arm of `backlog/debt-mesh-harness-policy-and-commit-path-untested`. Filing again would duplicate it.
- **Loose typing.** `declaredBaseRev?: unknown` validated at use is a second site for the pattern, matching how `validateCommitOperations` treats `blockDigests`. An ingress schema for `blockDigests` is a larger separate change and nothing here makes it more urgent.
- **Source hygiene.** `internalCommit` now takes seven positional parameters — a smell, but every call site is internal and an options object would be churn with no correctness gain. `storage-repo.ts` measured 1449 lines (`Get-Content ... | Measure-Object -Line`), up 67 from 1382, of which roughly 56 are comment; no size ticket exists for the file and it is well under `cluster-repo.ts` at 2343. The 40-line comment on a four-line guard is heavy, but it is the only record of why `rev - 1` must not be re-landed — a mistake the board shows was already made once — and it matches the file's house style. Left as is.
- **Error handling and resource cleanup.** The guard adds no I/O and no allocation: it reuses the `latest` already fetched and exits through `refuseMissingBase`, which drops the pending under the latch already held.

### Board hygiene

`blocked/st-commit-contiguity-guard-premise` asked a human two questions — is the fork risk real, and which of three detection mechanisms to use — and this work answered both: reproduced twice, and option 2a ("carry the intended base revision") designed and shipped. Left in place it would have told the next reader the guard is unsound and must not be built. Retired to `complete/st-commit-contiguity-guard-premise.md` with the answers recorded and a pointer to the new backlog ticket for what remains open.
