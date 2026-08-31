description: When two machines write to the same named collection for the very first time at the same moment, both writes are told they succeeded but each machine ends up with its own private copy of the data, and the two copies never merge. A test in this repository reproduces it every run.
files:
  - packages/reference-peer/test/distributed-diary.spec.ts:222-283 (the failing test — "should handle concurrent writes from multiple nodes")
  - packages/db-core/src/collection/collection.ts:154-169 (createOrOpen — the `collection:invented` branch that stages a header without committing it)
  - packages/db-core/src/collection/collection.ts:236-253 (advanceContext — the no-lower guard that makes the split permanent)
  - packages/db-core/src/collection/collection.ts:689-795 (syncInternal — the stale-retry loop that DOES work correctly once the collection exists)
  - packages/db-core/src/transactor/transactor-source.ts (transact — stale classification the retry loop keys off)
  - packages/db-p2p/src/cluster/cluster-repo.ts (ClusterMember pend validation — emits `cluster-member:validation-stale-revision`)
  - packages/db-p2p/src/storage/storage-repo.ts (StorageRepo.pend — conflicting-pending detection; readCommitBase / refuseMissingBase when a block has no committed base)
  - packages/db-core/src/collections/diary/diary.ts (no way to commit a header without also appending an entry — the API gap the test's premise assumes away)
  - docs/partition-healing.md, docs/correctness.md (the "Forked (conflict)" case this feeds)
difficulty: hard
repro: verified
----

# Two writers create one collection twice, and both are told they won

## The short version

Three machines each open the same diary by name and immediately append one entry. All three
appends report success. Afterwards each machine can see only a subset of the entries — in the
worst observed run, only its own — and no amount of refreshing ever closes the gap.

This is a **silently wrong answer**: a write that was acknowledged is not there.

## The failing test

```
cd packages/reference-peer && yarn test
```

`Distributed Diary Operations > should handle concurrent writes from multiple nodes`
(`packages/reference-peer/test/distributed-diary.spec.ts:222`).

It fails on every run. Under the package's own 10s mocha budget the symptom is a timeout:

```
Error: Timeout of 10000ms exceeded. For async tests and hooks, ensure "done()" is called;
if returning a Promise, ensure it resolves.
    at listOnTimeout (node:internal/timers:608:17)
```

Raised to 120s, the test's own convergence poll is what fails, which is the honest error:

```
Error: waitForValue timed out after 30000ms: Node 1 should converge on all successful
concurrent writes
    at waitForValue (packages/db-core/dist/src/testing/async-wait.js:35:19)
    at async Context.<anonymous> (test/distributed-diary.spec.ts:267:24)
```

**The 10s-vs-30s timeout mismatch between the package's `test` script and the test's own
`waitForValue` budget is real but is NOT the bug.** An earlier triage pass concluded it was.
It is not: convergence never happens, at any budget. Widening the mocha timeout would only
change which error message is printed. Do not "fix" this ticket that way.

## What actually happens

Instrumented run (`DEBUG='optimystic:db-core:collection,optimystic:db-core:network-transactor'`),
one collection id, three machines:

```
collection:invented id=concurrent-test-…  — no committed header found; staging a fresh empty collection
collection:invented id=concurrent-test-…  — no committed header found; staging a fresh empty collection
collection:invented id=concurrent-test-…  — no committed header found; staging a fresh empty collection

40.106  pend   actionId=8XsvJ5I5xf0oK_ZYDO3WYg  blockIds=2
40.286  pend   actionId=S9oHgUaHvheTW_-AU9jvoQ  blockIds=2
40.350  pend   actionId=lPJNI6eWjS2fzKVgvMJPAQ  blockIds=2
40.444  commit actionId=8XsvJ5I5xf0oK_ZYDO3WYg  rev=1   ← accepted
40.714  commit actionId=S9oHgUaHvheTW_-AU9jvoQ  rev=1   ← ALSO accepted, same revision
41.086  cluster-member:validation-stale-revision …
        'stale revision: block concurrent-test-… at rev 1, requested rev 1'   ← third writer refused
41.577  commit actionId=lPJNI6eWjS2fzKVgvMJPAQ  rev=2   ← retried correctly, landed
```

**Two different actions committed revision 1 of one collection.** That is the fork, at the
protocol level, with both writers acknowledged.

The third writer is the control: it hit the guard, was classified stale
(`coordinator-repo:pend-stale-classified latestRev=1 requestedRev=1`), backed off, refreshed,
and re-pended at revision 2. So the stale-retry machinery in `Collection.syncInternal` is
**correct and working**. It simply never got the chance for the first two, because at the moment
each of them pended, the block did not exist and nothing refused them.

Once the two lineages exist, `Collection.advanceContext`'s no-lower guard is what seals the
split — correctly in isolation (it is what stops a stale read rewinding a collection), fatally
here. The divergence instrument fires on it:

```
collection:lineage-divergence id=concurrent-test-… rev=1 held=8qJep6ZsCy3ftqKnu_bamg read=489TJiKCeRjU0xSuDVj3QQ
collection:lineage-divergence id=concurrent-test-… rev=1 held=nmNNtjHnjtMR4pveMk-zkw read=489TJiKCeRjU0xSuDVj3QQ
```

Ruled out by the same capture: this is **not** a routing or cohort-membership artifact. Every
`cluster-tx:cluster-members` line for this block names the same three peers for all three
writers.

## Root-cause hypothesis

The revision a write targets is checked at **pend** time against what the receiving member has
already committed, and nothing reserves that revision for the duration of the write. Two pends
that both pass the check before either commits therefore both proceed to commit the same
revision.

For an **existing** collection that window is narrow and, more importantly, covered — a second
writer racing an in-flight pend is refused as a pending conflict and retries (observed: writers
re-pending two and four times before landing at distinct revisions 3 and 4).

For a collection being **created**, the window is not covered. The header block has no committed
base at all, so "latest 0, requested 1" is not stale, and there appears to be no pending-conflict
refusal on a block whose creation is itself the pending record. Both creators sail through.

Where the reviewer should start:

- `StorageRepo.pend` — does the conflicting-pending scan run at all for a block with no committed
  base, or does the missing-base path (`readCommitBase` / `refuseMissingBase`) return before it?
- `ClusterMember`'s pend validation — the stale-revision verdict is derived from committed state;
  a creation has none to compare against.

The likely shape of the fix is that **creating a block must be a distinguishable, reservable
operation** — a create is refused if any other create for that block id is pending or committed,
rather than being modelled as "a write to revision 1 of a block whose latest revision is 0".

Whether the general (non-creation) commit race is fully closed by the existing pending-conflict
path or only narrowed by it is **not** settled by this ticket, and should be checked rather than
assumed: one instrumented run of the same test with the collection pre-created showed all three
concurrent appends landing at distinct revisions 3 and 4 (converged, correct), while an earlier
pre-created run still produced `collection:lineage-divergence` at rev 3. That inconsistency across
runs is unexplained and may be a second, narrower race. Treat closing the creation race as the
deliverable and record what was found about the general case.

## Why this test hits it every run when six crafted attempts did not

`Diary.createOrOpen` does not commit anything — the `collection:invented` branch stages a header
in the local tracker and nothing reaches storage until a later `sync`. The test does:

```ts
const diary1 = await Diary.createOrOpen(nodes[0]!.transactor, diaryName);
console.log('Waiting for diary to propagate...');
await delay(500);            // waits for a header that was never written
const diary2 = await Diary.createOrOpen(nodes[1]!.transactor, diaryName);
const diary3 = await Diary.createOrOpen(nodes[2]!.transactor, diaryName);
```

with a comment stating the intent: *"Create diary on Node 1 first, then have other nodes open it.
This ensures all nodes work with the SAME header block."* That intent is unachievable through the
current `Diary` API — there is no way to force the header to be committed short of appending an
entry. So the test does not sidestep the create race; it walks all three machines into it,
deterministically, every run.

**This is the in-repo reproducer that has been missing.** `blocked/secondary-index-repro-exhausted-upstream`
records six failed attempts to reproduce a one-id-two-lineages fork in this repository, and
concluded the next evidence had to come from a downstream run. It does not: it is in
`packages/reference-peer`, in the default test suite, and it fails every time. That ticket's
"stop reproducing here" recommendation should be revisited on the strength of this.

## Relationship to work already in flight

`review/2-coordinator-commit-latch-and-rev-threading` and
`implement/2.2-coordinator-interleaving-spec` chase the same fingerprint via a different
mechanism — a commit/refresh interleaving *within one process*. `2.2` explicitly asks whoever
picks it up to record a negative if that interleaving turns out not to corrupt state, because
then the fork would still be unexplained.

This ticket supplies a mechanism that produces the exact fingerprint **across machines, with no
interleaving required**, at HEAD with all three coordinator-latch commits landed
(`52d0509c`, `210ebffd`, `071478cb`). Neither ticket subsumes the other; whoever works either
should read this one first. No `prereq:` is set deliberately — the fixes touch adjacent code but
the causes are independent, and this failure is in the default suite today.

## Design constraints

- **A fix must not be a widened timeout.** The convergence never happens; the budget is not the
  problem. See above.
- **The failing test must stay as-is in shape and strength.** Do not skip it, do not weaken
  `expect(finalEntries.length).to.equal(successfulWrites)`, and do not paper over the create race
  by seeding the diary with a throwaway entry before the concurrent phase. A seed does make the
  test pass, and it passes for the wrong reason: the seed inflates the entry count so the
  `>= successfulWrites` poll is satisfied while a node's own entry is still missing from another
  node's view. That is a masked failure, not a fix.
- **Acknowledged means durable.** Whatever the resolution, a write that returns success must be
  present in the lineage every other reader converges on, or it must fail loudly. Two
  acknowledged writers holding incompatible histories is the outcome to eliminate.
- **`advanceContext`'s no-lower guard stays.** It is correct; it is a seal, not the cause.
  Do not relax it to make the split heal — that trades this bug for stale-read rewinds.
- **The parked architectural question stays parked.** *What the system should do once two
  lineages already exist* belongs to `backlog/more-design/6.5-partition-healing`'s "Forked
  (conflict)" arm. This ticket is about not creating the second lineage in the first place.
- **Consider whether `Diary`/`Collection` should be able to commit a header on its own.** The
  test's premise — create on one machine, then open elsewhere — is a reasonable thing for a
  caller to want and is currently unexpressible. Whether that becomes part of the fix or a
  separate follow-up is the implementer's call, but the API gap should be named either way.

### Cross-cutting obligations

- **Wire format:** none is implied by the diagnosis, but if the fix distinguishes a create from a
  revision-1 write on the wire (a new pend field, a new verdict, a reservation record), that **is**
  a `db-core` wire-shape change and must be flagged as such — `PendRequest` in
  `packages/db-core/src/network/struct.ts` is shared by every transport.
- **Storage format:** likewise, if the fix introduces a durable creation-reservation record, that
  is an on-disk shape every raw-storage backend must honour — the conformance suite
  (`packages/db-p2p/src/testing/raw-storage-conformance.ts`) is the place to pin it, and all five
  backends run it.
- **No determinism-edition bump, byte-format vector, or migration is anticipated** for a fix that
  stays inside the pend-validation logic.
- **Regression coverage:** the reproducer already exists and is already in the default suite, so
  no new fixture is strictly required. A cheaper, faster mesh-tier case pinning "two concurrent
  creates of one id ⇒ exactly one succeeds, or both converge" would still be worth having, since
  the reference-peer test stands up real libp2p sockets and takes ~16s.

## What was ruled out during triage

- **Stale portal-dist.** `p2p-fret`'s `dist/` was stale against its `src/`; it was rebuilt
  (`../Fret/packages/fret`, clean tree at `7690dbe`) and the failure reproduces unchanged.
  `@quereus/quereus` was already current.
- **Flakiness.** Reproduced on every one of six runs.
- **Cohort/routing divergence.** All three writers resolved the identical three-peer cohort for
  the block.
- **A regression from the recent coordinator-latch commits.** `packages/reference-peer` has no
  diff across `52d0509c..HEAD`; the mechanism here is cross-machine and does not involve the
  interleaving those commits addressed.

---

# CORRECTION on promotion — triage classification was wrong, and the obvious fix is the wrong fix

## This is NOT a pre-existing failure

It was recorded in `tickets/.pre-existing-known.md` at commit `714f1e57` as pre-existing. It is not.
Bisected to a first-bad commit with deterministic endpoints and no flaky results:

**`210ebffd` — "ticket(implement): coordinator-commit-latch-and-rev-threading"**. Parent `52d0509c`
passes 2/2; `210ebffd` fails 2/2. The entry has been removed from the allowlist — a regression sitting
on a known-failures list is worse than a red test, because it stops being counted.

The responsible change is one line, `packages/db-core/src/collection/collection.ts:132`:

```ts
- this.latchId = `Collection:${this.id}`;
+ this.latchId = `Collection:${this.id}#${this.instanceTag}`;
```

Reverting **only** that line makes the test pass 3/3 in 4s. Nothing else in `210ebffd` (rev-threading
through `pendedRevs`, the coordinator's whole-span latch hold, the `recordCommitted` tripwire) is
required for the failure: the diary path runs through `updateAndSync`, not `coordinator.commitOnce`.

FRET was explicitly controlled out with a 2x2 against a pinned beta.3 worktree — the Optimystic commit
is the sole determinant.

## Do NOT fix this by reverting that line

`Latches.lockQueues` is a **static, per-process** Map (`packages/db-core/src/utility/latches.ts:4`,
whose own doc comment warns the key scope is process-global). The test runs all three "nodes" in one
process, so the old key made three unrelated `Collection` instances share one queue and serialize by
accident. `210ebffd`'s own comment concedes this.

**In production each node is a separate OS process, so that global key never serialized anything
across nodes.** Therefore:

- The per-instance latch key is *correct*. Serializing distinct instances was the accident.
- **The concurrent-create race is a real production defect and always has been.** It was never
  masked in production — only in this single-process test.
- Reverting line 132 restores a green test while leaving the production bug exactly where it is, and
  removes the only reproduction we have. That is strictly worse than the red test.

Keep the per-instance key. Fix the race.

## This is very likely the reported index fork

`bug-lineage-divergence-observed-two-actions-one-revision` (backlog) records two machines diverging on
an index sub-collection, both departing from a shared base, both landing at the same revision under
different action ids, never merging. The trace at the bad commit here is that exact shape:

```
collection:invented x3
pend iTgk26 / pend yqcpVQ / pend 0g6tZK      (within 220ms)
commit iTgk26 rev=1 ; commit yqcpVQ rev=1 ; commit 0g6tZK rev=1
collection:lineage-divergence forkRev=1 heldAction=0g6tZK readAction=iTgk26
```

Index sub-collections are created on demand, so two nodes writing one index key concurrently both
"invent" and both commit rev 1 — which is why the fork was only ever observed on the index
sub-collection and never on the main table, whose collection already exists. **If that link holds,
fixing this race closes the headline downstream bug reported in issues #12/#15.** Verify the link
rather than assuming it, and say either way.

## What the fix has to do

The window is a create that commits a first revision without any committed base to compare against.
`Diary.createOrOpen` only *stages* a header, never commits one, so every concurrent writer starts
from "no committed header" and each believes it is creating revision 1.

The invariant wanted: **a commit that creates a collection's first revision must succeed for exactly
one writer; every other concurrent writer must be told it lost and rebase onto the winner.** The
existing stale-retry machinery in `Collection.syncInternal` already does the right thing once the
collection exists — the gap is that it has nothing to detect against when the base is absent.

Sites named by the original analysis, all still current:
`StorageRepo.pend` (conflicting-pending detection, `readCommitBase` / `refuseMissingBase` when a block
has no committed base), `ClusterMember` pend validation (emits
`cluster-member:validation-stale-revision`), `collection.ts:154-169` (`createOrOpen`'s
`collection:invented` branch), `collection.ts:236-253` (`advanceContext`'s no-lower guard, which makes
the split permanent once it happens).

Prefer the boundary invariant over a patch at the diary path — every collection type creates this way,
not just diaries.

## Acceptance

- `packages/reference-peer/test/distributed-diary.spec.ts` "should handle concurrent writes from
  multiple nodes" passes, **with the per-instance latch key retained**.
- All three concurrent appends are durable — the losing writers rebase and their entries survive.
  A fix that merely serializes, or that drops a loser's write while reporting success, is not a fix:
  the acknowledged-write-that-vanished is the whole defect.
- Full `yarn check` green, integration tier included.
