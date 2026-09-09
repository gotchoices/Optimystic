description: A storage node that missed updates to a block used to apply the next update on top of its stale copy, silently giving that node different content under the same revision number. It now refuses such a commit and heals from a peer instead.
files: packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/test/storage-repo.spec.ts
difficulty: medium
----

# Fork guard in `StorageRepo.internalCommit`, keyed on the writer's declared per-block base

## What landed

One guard, three comment updates, eight tests. Diff is 269 insertions across three files; no new types, no new machinery, no wire-format change.

### The guard (`packages/db-p2p/src/storage/storage-repo.ts`)

`internalCommit` gained a seventh parameter, `declaredBaseRev?: unknown`, forwarded from `commit`'s per-block loop as `request.blockDigests?.[blockId]?.baseRev` (storage-repo.ts:908). Immediately after `const latest = await storage.getLatest();` (storage-repo.ts:1237):

```ts
if (typeof declaredBaseRev === 'number' && !transform.insert && latest?.rev !== declaredBaseRev) {
	return await this.refuseMissingBase(blockId, actionId, rev, storage, latch,
		`local latest ${latest?.rev ?? 'none'} is not the declared base ${declaredBaseRev} of rev ${rev}`);
}
```

`baseRev` is the committed revision the writer read the block at, pinned at update-stage time and already riding inside every cohort signature preimage. Comparing against it — rather than against `rev - 1` — is what distinguishes a routine gap from a missed update: revisions are allocated per **collection**, so a member holding block X at rev 1 legitimately receives a commit of X at rev 7 when revs 2–6 touched other blocks. A `rev - 1` check would break that (and is pinned against by `storage-repo.spec.ts` "commits across an arbitrary revision gap when a base IS held"). Do not "simplify" the condition into one.

The refusal needs no new plumbing: `refuseMissingBase` throws `MissingBaseRevisionError`, `commit` already classifies that as divergence and drops the batch's unpromotable pendings, `ClusterMember.applyConsensusOperation` already maps `missing-base-revision` to "behind" divergence and runs `reconcileDivergentCommit`, and `CoordinatorRepo` already tolerates the reason. The writer's retry then lands on a healed base.

A ~30-line comment at the site documents each clause, the ahead-of-declared-base case, the read-driven-promotion abstain, and the residual gap (below) as a `NOTE:` tripwire.

### Comment updates (`packages/db-p2p/src/cluster/cluster-repo.ts`)

Two doc blocks whose justification prose went stale the moment the guard landed:

- `validateCommitRevisions` (~1528): the "a member behind the commit cannot judge it" abstain now says *why* abstaining is safe — apply-time refuses what the vote cannot judge.
- `validateCommitDigests` (~1648): the update-only abstain rule no longer claims a lagging member "legitimately materializes different bytes"; it now says the member cannot *judge* the content and never goes on to materialize it.

The pinned gap test's comment in the spec was widened to state the full rule (arbitrary gap commits when the held base matches the declared base, or when nothing is declared).

## How to exercise it

`yarn workspace @optimystic/db-p2p test --grep "fork guard"` runs the new suite (7 tests, ~40ms; all in-process `StorageRepo` over `MemoryRawStorage`, no cluster, no network).

The eight tests added, and what each pins:

- **Fork prevention (the reproduced defect).** Two independent members. Both take rev 1 (insert, `items: []`) and rev 2 (append `'a'`, declared base 1). Only the healthy one takes revs 3 and 4 (`'b'`, `'c'`). Then rev 5 (prepend `'z'`, declared base 4) goes to both: healthy commits and holds `["z","a","b","c"]` at rev 5; the gapped one refuses with a `missing-base-revision`-prefixed reason and **stays at rev 2** holding `["a"]`. The old behaviour was both reporting rev 5 with different `canonicalBlockHash` values.
- **Ahead of the declared base.** Member at rev 4, writer declares base 2 for rev 5 → refuses, `latest` untouched at 4. This is divergent history, not lag, and is equally unsafe to apply.
- **Refusal drops the pending.** After the refusal a `policy: 'f'` write to the same block is accepted, so no orphan record blocks the block forever.
- **Four abstains, each preserving pre-guard behaviour:** no `blockDigests` at all; `baseRev: '4'` (a string — untrusted wire data must not be coerced into a comparison); a declared entry that omits `baseRev`; an insert-carrying transform with a hostile `baseRev: 4` attached.
- **The legit collection-level gap, declared.** Sibling of the pre-existing un-declared gap test: base rev 1 held, `baseRev: 1` declared, commit at rev 7 succeeds.

Reaching the insert-abstain state took an unusual setup worth knowing about: `pend` refuses an insert over a block it already holds (stale), so that test pends the insert against an absent block, brings a revision in by `saveReplicatedBlock`, then commits — which is how a real member actually lands there.

## Validation performed

- `yarn workspace @optimystic/db-p2p typecheck` — clean. `yarn workspace @optimystic/db-p2p test` — **2630 passing, 49 pending, 0 failing** (baseline before this ticket was 2622; +8 new).
- `yarn workspace @optimystic/db-core typecheck` — clean. `yarn workspace @optimystic/db-core test` — **1605 passing** (no source change there; the commit-request shape is shared).
- **Negative control.** With the guard's comparison neutered (and nothing else changed), exactly the three refusal tests fail and the four abstain tests still pass — the new tests are not self-satisfying. The guard was then restored and the full suite re-run green.
- **Downstream, `../sereus` `packages/integration-tests`**, `control-write-degraded-cohort-member.integration.ts`, run with `DEBUG='optimystic:db-p2p:*,sereus:cadre:control-db*'`, guard OFF vs guard ON with rebuilt `dist` both times:

  | | `cluster-member:content-digest-mismatch` | `commit:missing-base` |
  |---|---|---|
  | guard OFF | 20 | 0 |
  | guard ON | 0 | 6 |

  The fingerprint the fix-stage investigation chased is gone, replaced by exactly the intended sequence. The guard's log lines show it firing on the real fork shape in a live cohort, e.g. `commit:missing-base blockId=yF-MV… rev=8 detail=local latest 6 is not the declared base 7 of rev 8`. Of the 6 reconcile attempts that followed, 4 restored/certified and 2 hit `no-rev-quorum` — expected in a deliberately-degraded 3-peer cohort, where one member is the thing being degraded.

## Known gaps — read these before signing off

- **The residual arm is real and untouched.** A commit whose block declares **no** digest still gap-applies exactly as before: pre-upgrade writers, undeclarable blocks (read-far-then-update eviction, see `db-core/src/transform/digest.ts`), and delete-only transforms. This is deliberate (abstaining is what keeps the guard from breaking routine writes) and is recorded as a `NOTE:` tripwire at the guard site. Whether forked content can then spread by replication is already tracked by `backlog/debt-repair-cannot-tell-a-fork-from-a-lagging-cohort` — do not re-file.
- **Test coverage is StorageRepo-tier only.** Nothing in db-p2p's own suite exercises declared-base refusal → `ClusterMember` reconcile → convergence end to end. It rides on the existing `missing-base-revision` reason, so it inherits that mapping and the tests already covering it, but the composed path is verified only by the sereus log evidence above, not by a repeatable unit test. A cluster-tier test is the obvious thing a reviewer might want.
- **Mixed-batch behaviour is untested for *this* refusal.** A declared-base refusal breaks `commit`'s per-block loop like any divergence — sibling blocks that already landed stay landed, the rest of the batch's pendings are dropped. The existing mixed-batch tests cover that for the no-base refusal through the identical code path; no test drives it with a declared-base mismatch specifically.
- **`declaredBaseRev` is typed `unknown` and validated at use.** That matches how `validateCommitOperations` treats `blockDigests`, but it means the loose typing is now in a second place. If someone wants an ingress schema for `blockDigests`, that is a separate, larger change.
- **The sereus scenario is broken independently of this work.** `control-write-degraded-cohort-member.integration.ts` fails 5 of 7 tests **with the guard disabled** as well as enabled, and the failing subset varies run to run (one run also lost its whole `beforeAll` to a 45s peer-discovery timeout). Not caused by this change and not in this repo's test surface, so no `tickets/.pre-existing-error.md` was written — but a reviewer reading those logs should not mistake the failures for fallout. The two multi-megabyte debug logs used for the table above were deleted after extraction; re-run the command above to regenerate.

## Files

- `packages/db-p2p/src/storage/storage-repo.ts` — the guard (~1204-1240), the call-site forward (~905-912), the `internalCommit` doc.
- `packages/db-p2p/src/cluster/cluster-repo.ts` — two stale doc blocks corrected (~1527, ~1648). No behaviour change.
- `packages/db-p2p/test/storage-repo.spec.ts` — the `commit — declared base revision (fork guard)` describe (~2400-2570) and the widened gap-test comment (~2080).
