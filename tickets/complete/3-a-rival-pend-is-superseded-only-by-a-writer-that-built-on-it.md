description: When a machine decides whether an earlier, still-unfinished write blocks a new write to the same block, it can now compare against the version the new write was actually built on, so a write built on an older copy waits instead of silently overwriting the earlier change. The review narrowed this to the clusters where that overwrite can actually happen (four or more machines), so two- and three-machine clusters keep today's behaviour and cannot be wedged by it.
files: packages/db-p2p/src/storage/pending-claim.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/race-resolution.ts, packages/db-p2p/src/repo/stuck-reservation.ts, packages/db-p2p/src/storage/struct.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/test/pending-claim.spec.ts, packages/db-p2p/test/cluster-pend-held-vote.spec.ts, packages/db-p2p/test/cluster-commit-digest.spec.ts, packages/db-p2p/test/storage-repo.spec.ts, packages/db-p2p/test/rival-superseded-only-by-a-writer-that-built-on-it.spec.ts, packages/db-p2p/test/util/node-count-mesh.ts, docs/correctness.md, docs/repository.md, docs/internals.md, packages/db-p2p/docs/storage.md, tickets/backlog/bug-a-writer-held-by-a-change-it-never-saw-retries-on-its-stale-copy.md, tickets/backlog/debt-unpromotable-pending-records-need-a-sweep.md
difficulty: medium
repro: verified
----

# A rival pend is superseded only by a writer that built on it — complete

Third of the three tickets split from `bug-a-pended-transform-does-not-carry-its-base`. It reads the base each pend carries (stored by the second ticket) in the rival rule and at the commit vote.

## What landed (implement pass, as narrowed by review)

**The rule** (`isReservationAgainst` in `packages/db-p2p/src/storage/pending-claim.ts`, first match wins):

- either side's revision unknown → reserves;
- the record has a stored base AND the request has a usable base (a number below its revision) → reserves iff `claim.rev > baseRev` (the "base arm");
- otherwise → reserves iff `claim.rev >= rev` (the revision rule, unchanged from the release).

**Where the base arm is read.** Only at the promise vote (`ClusterMember.reservingRivals` → `reservationRequestOf`), and only when `cohortCanMissAPend(peerCount, superMajorityThreshold)` — the cohort can reach its promise super-majority without one member (four and up at the default 0.75). The apply-time scan in `StorageRepo.pend` always uses the revision rule, so it is never stricter than the vote. The coordinator's diagnostic `corroborateHeldBlocks` uses the same gate (the cohort size is threaded from `pendThroughCluster`).

**Commit vote.** `ClusterMember.validateCommitBaseDeclarations` rejects with the signed reason `base-declaration-disagrees` when this member's record for the action stored a base other than the commit's declared `blockDigests[id].baseRev` AND this member's own latest is that declared base; otherwise it abstains (the review's narrowing — see finding 2).

**Four-member mesh spec** (`rival-superseded-only-by-a-writer-that-built-on-it.spec.ts`) reproduces and closes the lost update; phase 4 now asserts the newcomer's refusal is a `TornActionError` and prints its `final` flag.

## Review findings

Read the implement diff (`f9d7c8e9`) first, then the handoff and the maintainer's check-in notes. The maintainer's five questions were the main review question; each is answered below with what was measured.

### 1. Records with no stored base — fixed (maintainer item 1)

The implement pass judged a base-less record (written by the release `6d43b9f4`, or for an inserted/deleted block) by the newcomer's base, so such a record whose commit ran nowhere could never clear — no member can promote a base-less record from a read. Fixed in `isReservationAgainst`: the base arm applies only when the record has a stored base; a base-less record keeps the slot rule. Pinned by `pending-claim.spec.ts` "a record with no stored base keeps the revision rule: a release-shaped record is superseded once the collection moves past its slot" and the vote-level "approves over a record with no stored base" (four members).

Residual, recorded in the `isReservationAgainst` doc comment: a rival record for a *deleted* block also has no base, so the lost-update shape with a rival delete (four members up) stays on the revision rule, as it was before this ticket.

### 2. The honest-retry reject at three members — measured, then narrowed (maintainer item 2)

Measured at the member tier on a real `StorageRepo` in a three-peer record (`cluster-commit-digest.spec.ts`, "three members, an honest retry…"): the member still holds the earlier attempt's record (stored base 1, latest 1), and the retry's commit declares base 2 at rev 3. With the implement pass's code the member voted **reject** (negative control, below). At three members with the 0.75 threshold every member must promise (`maxAllowedRejections = 0` in `getTransactionPhase`), so that one signed reject sinks the honest retry's commit for the whole cohort — a regression at the node count the maintainer cares most about.

Applied the fallback the implementer named: abstain unless this member's latest is the declared base. The test now shows the member approving, and its own apply (`repo.commit`) refusing the stale record (`guardCommitBase`'s stored-vs-declared disagreement) with nothing applied. The reject still fires where the digest check would also reject (member at the declared base), and names the cause.

Not built: a full three-machine mesh run of this shape. On the in-process mesh a single cohort pends all of an action's blocks in one request, so leaving an earlier attempt's record on exactly one member while the same action id retries needs two coordinated delivery failures (the retry's pend and the cancel both lost to that member) plus a base change between attempts; the member-level test covers the vote and the apply, and the cohort consequence follows from the threshold arithmetic.

### 3. The held writer that never re-reads — confirmed, with a new observation (maintainer item 3)

- Error type: confirmed. N's write reaches the caller as `TornActionError` (asserted in phase 4 of the mesh spec).
- `final`: **false** — "whether the write is saved could not be established" (`commit-not-durable: 0 of 4 cohort member(s) report holding rev 3`), although all four members answered and the write can never land. So the application is told to read back before resubmitting, not that it may resubmit. Conservative, never unsafe; the wrong signal. Not pinned in the spec either way (a `NOTE:` at the assertion explains). Added as an arm to `backlog/bug-a-writer-held-by-a-change-it-never-saw-retries-on-its-stale-copy`.
- Sizes: with the review's gate, no two- or three-member shape reaches this path (the vote there never holds on the base), and the stale read itself needs a member outside the pend's quorum. The backlog ticket now has a "Which cohort sizes reach this" section saying so.

### 4. The abandoned-write case — new at two and three members as implemented; fixed by narrowing (maintainer item 4)

Existed before this ticket? Partly. Under the release's revision rule, a record whose writer vanished holds only writers asking for its own slot, and clears as soon as any other write moves the collection past it. What the implement pass added was a permanent hold: every later writer's base is below the record's slot forever.

New at two and three members? **Yes, as implemented** (reasoned from the code; the gate's tests below measure the vote). The cheapest trigger is not a crash but one lost message: a writer's data-block pend lands, its tail pend loses a race, and its cancel reaches every member but one. That member keeps the record, votes `held` on every later writer to the block, and at two or three members (unanimity) one `held` vote fails every pend — the block is wedged for good by a single dropped cancel.

Fix: the base arm is read only where a member can miss a pend (`cohortCanMissAPend`). That is exactly the condition for the lost update the base arm closes, and exactly where one member's hold is outvoted. Two- and three-member cohorts get the release's behaviour back. At four and up, a stray record on one member is outvoted, and because the apply-time scan keeps the revision rule, that member still stores the admitted pend, whose commit sweeps the record. What remains at four and up: a record left on enough members to deny a super-majority (a writer that crashed after its data-block pend, before any cancel) holds every later writer to that block. That is recorded at the `NOTE:` on `isReservationAgainst` and as the rewritten 2026-09-18 arm of `backlog/debt-unpromotable-pending-records-need-a-sweep`.

Pinned by `cluster-pend-held-vote.spec.ts` ("approves the base-below pend at 2 members / at 3 members: a stray record on one member must not sink every later writer", and "still holds a pend for the record's own slot at three members"), `pending-claim.spec.ts` (`cohortCanMissAPend` table), and `storage-repo.spec.ts` ("the apply-time rival scan keeps the revision rule whatever base the pend declares"). The four-member mesh spec still closes the lost update, now at the vote.

### 5. Integration suites — run (maintainer item 5)

`OPTIMYSTIC_INTEGRATION=1` db-p2p `test/**/*.integration.spec.ts`: 44 passing, 2 pending, 0 failing. Quereus plugin integration specs: 5 passing. (First run of these on this branch.)

### Other checks

- **Correctness (safety).** The base arm only ever holds more than the revision rule (property test in `pending-claim.spec.ts`, still green against base-carrying claims). Moving the apply-time scan back to the revision rule keeps "the apply never refuses what the vote approved"; the closure for the four-member shape is at the vote, where the members holding the rival's record are the super-majority the newcomer needs. Residual: a rival record that lands at a member *between* that member's vote and its apply is judged by the revision rule at apply — narrow, and no worse than the release.
- **Consistency across sites.** Vote, coordinator corroboration and apply now each state which inputs they feed the rule; the gate is one function used by both the member and the coordinator.
- **Type safety / error handling.** `latestRevOf` (new helper for the commit-vote fallback) treats a read fault as "cannot judge" and logs it, matching the method's other abstains. No new throws on the vote path.
- **DRY / modularity.** `cohortCanMissAPend` is the single statement of the gate; the super-majority arithmetic it mirrors is still inlined elsewhere in `cluster-repo.ts` and `cluster-coordinator.ts` (pre-existing, not touched).
- **Performance.** The commit-vote fallback adds one contextless local `get` per disagreeing block, only on the reject path. Unmeasured; negligible by construction.
- **Resource cleanup.** Nothing new held open.
- **Docs.** Updated `docs/correctness.md` (pend-refusal paragraph, Theorem 1 Case 2, Theorem 9 and its liveness paragraph), `docs/repository.md` (the "A pending record claims a slot…" section rewritten, and a stale path — `declaredBaseFor` moved from `storage-repo.ts` to `pending-claim.ts` — fixed), `docs/internals.md` (commit-vote paragraph, held-vote bullet), and source comments in `race-resolution.ts`, `struct.ts`, `i-block-storage.ts`, `storage-repo.ts`, `cluster-repo.ts`, `coordinator-repo.ts`. `packages/db-p2p/docs/storage.md` only carries the section cross-reference, which still resolves (`yarn lint:docs`: all 46 documents resolve).
- **Source hygiene.** `packages/db-p2p/src/cluster/cluster-repo.ts` is 3115 lines (`wc -l`); this ticket added about 100 lines to it (the commit-vote check). Size debt that predates the ticket; no open ticket claims a split and none filed here — noted only.
- **Tests from the implement pass.** Kept; the rule table, vote suite, commit-vote suite and storage suite were rewritten for the narrowed rule rather than loosened: every "holds" case now runs with a base-carrying record at four members, and the new cases pin the two- and three-member behaviour.

### Negative controls (run in this review)

- With the cohort gate and the commit-vote fallback both disabled in `cluster-repo.ts`, exactly the four new tests failed: the vote approving at two and at three members, the commit vote abstaining for a member not at the declared base, and the three-member honest-retry test (the member voted reject). Restored and re-verified.

### What was measured

| Check | Result |
|---|---|
| `yarn workspace @optimystic/db-p2p build`, root `yarn typecheck` | clean |
| eslint on every touched source and spec | clean |
| `yarn workspace @optimystic/db-p2p test` | 3100 passing, 63 pending (env-gated), 0 failing |
| `yarn workspace @optimystic/quereus-plugin-optimystic test` | 997 passing, 13 pending, smoke ok |
| db-p2p integration (`OPTIMYSTIC_INTEGRATION=1`) | 44 passing, 2 pending |
| quereus plugin integration specs | 5 passing |
| `yarn lint:docs` | 46 documents, all resolve |

No pre-existing test failures were seen.
