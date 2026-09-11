description: When a node is asked for a record it does not have, it asks the rest of the network on every single read, with nothing limiting how often — even on a one-machine deployment where there is nobody to ask. Give that "it does not exist" answer the same short freshness window a record the node does hold already gets, so repeated checks for a not-yet-created record stop costing a network lookup each.
prereq:
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts:569 (per-block `LruMap`s — the new absence memo goes beside `lastSeenCommitMs`)
  - packages/db-p2p/src/repo/coordinator-repo.ts:770-806 (`get`'s consult decision: `isMissing` bypasses the window today)
  - packages/db-p2p/src/repo/coordinator-repo.ts:1062 (`shouldReadRepair` — the held-block window this mirrors)
  - packages/db-p2p/src/repo/coordinator-repo.ts:1152-1391 (`fetchBlockFromCluster` — every exit must state the new required field)
  - packages/db-p2p/src/repo/coordinator-repo.ts:1376 (NOTE about missing blocks never consulting the window — rewrite)
  - packages/db-p2p/src/repo/coordinator-repo.ts:1949 (`pend` entry — clears the memo)
  - packages/db-p2p/src/repo/coordinator-repo.ts:2388 (`commit` entry — clears the memo)
  - packages/db-core/src/transactor/network-transactor.ts:146-160 (comment stating what an unflagged absent guarantees — update)
  - packages/db-p2p/test/coordinator-repo-solo-read-repair-window.spec.ts:235 (the pinned "missing block consults every read" spec — flips by design)
  - packages/db-p2p/test/coordinator-repo-unavailable.spec.ts (multi-peer cohort fixtures: `buildRepo`, `makeKeyNetwork`, `makeAbsentStorageRepo`)
  - packages/db-p2p/test/coordinator-repo-absence-window.spec.ts (new)
difficulty: medium
----

# A block this node does not hold gets a freshness window too

## Background, in plain terms

`CoordinatorRepo.get` answers a read from local storage first. Before returning, it may ask the block's cohort (the other machines responsible for that block) whether they know better. This is called a consult. There are two reasons to consult:

- **(a) the block is missing locally.** Nothing limits how often this happens: every read consults.
- **(b) the block is held but might be stale.** This is limited by the lazy read-repair window (`readRepairWindowMs`, 10 s by default). A block checked recently is served locally with no network work.

Nothing limits trigger (a). A caller that checks for a record that has not been created yet pays one full consult on every check, forever. The biggest producer in the field is on GitHub issue #8. There, control-plane code reads the empty `Revocation` collection before every membership lookup and every control-plane insert. Measured in-process against a real solo node (2026-09-11):

- a never-written collection costs **2 consults on every call, 6 calls out of 6**;
- a collection written once costs 1 consult, then 0;
- `queryCadrePeers()` costs a flat 4 consults per call across 20 calls.

The 0.29.0 fix (the solo-self exit arming the window) cannot help here. `isMissing` short-circuits before the window is ever checked.

## Design

### The rule

A missing block skips its consult when an earlier consult, within the last `readRepairWindowMs`, **settled** its absence. A settled absence is one where the consult reached every cohort member it could ask, none of them claims the block, and it rested on a real cohort view. Otherwise the block consults exactly as it does today.

The held-block window already gives this guarantee for content: "checked with the cohort within one window". The absence memo gives the same guarantee for absence. Nothing weaker is ever served as authoritative.

### New state

```ts
/** Per block, when (this.now()) a consult last SETTLED that this node's absence of it is the cohort's
 *  answer too — see `absenceSettled` on fetchBlockFromCluster's result. Read only for a block still
 *  missing locally; cleared by any local pend/commit of the block and by seeing it present. */
private readonly settledAbsences = new LruMap<string, number>(1000);
```

It is a separate map, not `lastSeenCommitMs`, on purpose. `lastSeenCommitMs` is already stamped for missing blocks at exits whose verdict is **not** a confirmed absence: the solo-self exit (its stamp is inert today), the `cohort-too-small` deadlock arm when a peer claimed a revision, and the post-restore arm when acquisition failed (`claimed`). Reusing it would turn a `claimed-elsewhere` absence into an authoritative one for a whole window. That is the exact trap the NOTE at `:1376` warns against ("rather than widening `isMissing`").

### A required field on the consult's result

`fetchBlockFromCluster` returns `{ absence, currency, absenceSettled: boolean }`. The field is **required**, the same way `currency` is, so any exit added later has to say which side it falls on. (Backlog `debt-freshness-state-scattered-across-coordinator-repo` asks for arming decisions to be returned as part of the verdict rather than remembered per exit. This follows that shape.)

| exit | `absenceSettled` | why |
|---|---|---|
| no `clusterLatestCallback` (`:1153`) | `false` | unreachable from `get` (guarded); nothing to settle against |
| empty cohort (`:1166`) | `false` | a routing failure, not an answer — same reasoning as its NOTE about not arming |
| solo-self (`:1172`) | `true` | nobody else could hold it; re-asking inside one window learns nothing the next `findCluster` would not |
| `!corroborated` (`:1263`) | `absence === 'confirmed'` | settled only with no claim and no silence (this covers the `cohort-too-small` arm without a claim) |
| `local-current` (`:1335`) | `absence === 'confirmed'` | only reachable for a held block; harmless, stated for consistency |
| post-restore (`:1383`) | `false` | restored → the block is now present; not restored → `claimed` |

A consult that **throws** settles nothing.

### In `get`

For each block, in the existing loop:

- **Present locally** (`!isMissing`): delete any `settledAbsences` entry, then continue exactly as today.
- **Missing, and `absenceIsSettled(blockId)`**: skip the consult. Serve the local entry as-is: an authoritative absent `{ state: {} }`, or pending-only content. Add no flag and **no log line**. The held-block skip path logs nothing either, and a per-read line would recreate the volume this ticket removes.
- **Missing, not settled**: consult exactly as today. After the refresh, if the block is still missing (no `state.latest` on the refreshed entry), `absence === 'confirmed'`, and `absenceSettled`, stamp `settledAbsences.set(blockId, this.now())`. Otherwise delete the entry. A consult that ended `unconfirmed`/`isolated`/`claimed`, or threw, must leave no memo, so the next read consults and flags as it does today.

```ts
/** A missing block may skip its consult: an earlier consult settled its absence within one window. */
private absenceIsSettled(blockId: BlockId): boolean {
	if (this.readRepairMode === 'paranoid') return false;	// "verify every read" means every read
	const at = this.settledAbsences.get(blockId);
	if (at == null || this.now() - at > this.readRepairWindowMs) return false;
	if (this.readRepairSampleRate > 0 && this.rand() < this.readRepairSampleRate) return false;
	return true;
}
```

**Modes.**
- `paranoid` never skips.
- `lazy` uses the window and the sample rate, mirroring `shouldReadRepair`.
- `off` also uses the window. `off` disables stale-content repair, but the absence consult is not stale-content repair, and leaving `off` unbounded would make the mode meant to do *less* network work do *more*. State this in a comment.

### Clearing on local writes

At the top of `pend` (`:1949`) and `commit` (`:2388`), delete `settledAbsences` for every block id involved. Do it **before** routing and regardless of outcome. There are two reasons:

1. **A pend refused because the block already exists somewhere is the strongest possible evidence that the memo was wrong.** The writer's retry re-reads, and that read must consult and restore rather than serve the memo's authoritative absent again for the rest of the window.
2. After a successful commit the block is present, so the memo is dead anyway. Clearing it keeps the LRU honest.

Clearing is always the safe direction: it can only cause an extra consult.

A cohort member's storage receiving another coordinator's pend or commit does not go through this class. It does not need to: the block becomes present locally, and present blocks never read the memo.

### Comments to update

- `get` `:770-772`: replace "(a) Missing — legacy behavior" with the new rule and a pointer to `settledAbsences`.
- `get` `:779-790` (the `NetworkTransactor` coupling NOTE): an unflagged absent now means "the cohort confirmed this absence **within the last `readRepairWindowMs`**". That is the same currency guarantee a held block already carries. Say so.
- `network-transactor.ts:150-160`: same correction, one sentence. "By the time an unflagged absent reaches here there is nothing left for a transactor-level retry to discover" still holds: a retry against another coordinator would find the same cohort's same answer, except for a creation the cohort has not told this node about (see the tradeoff below).
- `:1376-1382` NOTE: the first sentence is no longer true for a confirmed absence. Keep the part about a persistently failing acquisition. That path ends `claimed`, stays unsettled, and still re-fetches on every read, which is correct.
- `:1158` (empty-cohort NOTE): add that it also returns `absenceSettled: false`, for the same reason.

### Accepted tradeoff — put this `NOTE:` on the `settledAbsences` declaration

A block created by a writer whose commit did not involve this node is reported absent for up to one `readRepairWindowMs` after this node settled its absence. "Did not involve this node" means this node is outside the cohort (a soft-served read) or missed the commit broadcast. This is the same bound, for the same reason, that a held block's content already has. A cohort member normally learns of a creation through the pend/commit it takes part in, and a local pend or commit clears the memo. Revisit if a caller ever needs create-visibility across coordinators that is tighter than one window. Such a caller needs a revision floor (backlog `feat-refresh-can-demand-a-revision-floor`), not a shorter window.

### What this does and does not buy

It collapses repeated absent reads *within one window* to a single consult, on every cohort shape. That covers founding bursts and back-to-back `queryCadrePeers` / insert-check reads.

It does **not** remove the idle loop on its own. The downstream reconcile pass runs every ~15 s, which is longer than the 10 s window, so each pass still pays one consult per absent block instead of several. That expectation comes from the interval arithmetic and has not been measured. Two other pieces of work cover the rest:

- On a solo node, the per-consult cost is almost all `findCluster`. The sibling plan ticket `a-solo-node-recomputes-a-constant-answer-and-our-gate-cannot-see-it` owns making that cheap.
- The downstream repository's own ticket owns reading `Revocation` less often.

This ticket owns only why an absent read was unbounded.

## Edge cases & interactions

Each of these should be a test in the new `coordinator-repo-absence-window.spec.ts`, unless noted otherwise. Count consults by `cluster-fetch:solo-self-skip` lines (`captureLog`) on solo fixtures and by `clusterLatestCallback` invocations on multi-peer fixtures. Use the `repo.now` clock seam, and follow the TRAP comment at the top of `coordinator-repo-solo-read-repair-window.spec.ts`: take reads *inside* the window, or the fix looks inert.

- **Gate first.** Write the solo case (nine reads of a never-written block inside one window) before touching `get`, run it at HEAD, and record the before-number in the review handoff. The expected before-number is 9 and the expected after-number is 1.
- **Solo, absent, inside window:** 1 consult in 9 reads. Every answer is `{ state: {} }` and unflagged.
- **Window lapse:** a read after `readRepairWindowMs` consults again.
- **Paranoid:** every read consults.
- **`off` mode:** windowed like `lazy`.
- **Sample rate:** with `rand` forced below `readRepairSampleRate`, a read inside the window consults.
- **Three-peer cohort, everyone answers "nothing":** one consult per window, and every read is authoritative and unflagged. This is the new-collection probe at `coordinator-repo-unavailable.spec.ts:275`, now windowed.
- **Partial silence** (one peer rejects, one answers): *every* read consults and *every* read carries `unavailable: 'peers-unreachable'`. It must never settle, or `NetworkTransactor` would take a guess as final.
- **Total silence / isolated:** every read consults, `cohort-unreachable`.
- **Claimed** (a lone peer claims a revision the quorum declines, or it is corroborated but acquisition fails): every read consults, `claimed-elsewhere`.
- **Consult throws** (`findCluster` rejects): every read consults, `peers-unreachable`, no memo.
- **Empty cohort:** every read consults, no memo.
- **Settled, then unsettled:** a settled absence whose next consult (after the lapse) comes back `unconfirmed` must delete the memo, so the read after that consults too, even inside the window.
- **Pend clears:** settle an absence, then `pend` a transform on that block (success *and* failure), then read inside the window. The read consults.
- **Commit clears:** same, via `commit`.
- **Block turns up locally** (mutate the storage double to hold it): it is served from local storage, and the memo entry is deleted. If it later vanishes again inside the original window, the next read consults. This proves the delete, not the timestamp, retired the memo.
- **Creation elsewhere inside the window** (a peer starts claiming the block after the absence settled): inside the window → authoritative absent. This pins the accepted tradeoff out loud, the way the held-block spec pins "costs at most one window when the cohort later grows". After the lapse → consulted and restored or flagged.
- **Cohort grows inside a solo-settled window:** not consulted until the window lapses, then the new peer is asked. This mirrors the solo spec's growth case and covers the ticket's "cohort of one about to stop being one" concern. `findCluster`'s mid-identify exclusion of an `unknown` peer resolves within one window by the same argument as the held-block solo exit.
- **Pending-only insert** (content, no `state.latest`) inside a settled window: content is served unflagged, and no consult runs.
- **Multi-block `get`:** one held-fresh, one settled-absent, one unsettled-absent in the same call. Only the third consults. Per-block independence.
- **`skipClusterFetch`:** never consults, never stamps, never reads the memo. The existing spec stays green.
- **Soft-served (non-responsible) block:** the memo applies. A settled absence means no cohort member holds it, so there was nothing to acquire; the `get` NOTE about soft-serve acquisition is unaffected. No test is needed beyond confirming the existing proximity specs stay green.
- **Swallowing callback** (`coordinator-repo-unavailable.spec.ts:416`): a callback that turns a dial failure into `undefined` is indistinguishable from "holds nothing", so it now settles for one window. It already produced an authoritative absent. The contract boundary is unchanged, but add one line to that spec's comment saying the absence is now also remembered for a window.
- **Flip the pinned spec:** `coordinator-repo-solo-read-repair-window.spec.ts:235` ("does not suppress reads of a block this node does not hold") asserts 9 consults. Its own comment says it exists to fail if the missing-block bypass narrows. Rewrite it to assert 1, and reword the comment so it still explains why the solo exit's `lastSeenCommitMs` stamp stays inert for a missing block (the absence decision reads `settledAbsences`, never `lastSeenCommitMs`).
- **Mesh exercise:** the mesh harness builds a real `CoordinatorRepo` through the `coordinatorRepo(...)` factory (`mesh-harness.ts:446`), so this change is live in mesh tests with no harness work. Add one mesh-level case: a 1-node mesh reads a never-written block N times through the transactor inside one window, and the `solo-self-skip` count stays at 1 rather than N. This is the "consults per absent read" gate at the layer shipped code runs.
- **LRU eviction** past 1000 settled blocks loses a memo and costs one extra consult, which is the safe direction. Note it in the declaration comment, as the sibling maps do. No test.

## Out of scope (owned elsewhere)

- Skipping `findCluster` itself on a solo node (the original ticket's "short-circuit before `findCluster`"): `plan/a-solo-node-recomputes-a-constant-answer-and-our-gate-cannot-see-it`. This ticket still calls `findCluster` on every *unsettled* consult.
- Held-block (trigger b) consults on a solo cohort: already bounded to one per window by 0.29.0. After the sibling ticket makes `findCluster` constant on solo, each costs a memo lookup and a log line. Not worth a separate rule.
- Reading `Revocation` less: the downstream repository's ticket.
- Gate 4's blindness to non-commit `findCluster` sites: the sibling plan ticket.

## TODO

- Write `coordinator-repo-absence-window.spec.ts`, starting with the solo nine-reads gate. Run it at HEAD and record the before-number.
- Add `settledAbsences` with its accepted-tradeoff `NOTE:`, and add `absenceIsSettled`.
- Add the required `absenceSettled` to `fetchBlockFromCluster`'s return type and every exit, per the table.
- Rework `get`'s per-block decision: delete the memo on present, skip on settled, stamp or delete after a consult.
- Clear the memo at the top of `pend` and `commit`.
- Update the comments listed under "Comments to update", including `network-transactor.ts`.
- Flip `coordinator-repo-solo-read-repair-window.spec.ts:235`, and add the one-line note to `coordinator-repo-unavailable.spec.ts:416`.
- Add the 1-node mesh gate.
- Run `yarn workspace @optimystic/db-p2p test` and the db-core transactor specs, then build.
- Append a one-paragraph measurement to backlog `debt-freshness-state-scattered-across-coordinator-repo`. This adds a sixth per-block map and a third required verdict field, and the field is the shape that ticket asked for. Record the `wc -l` line count.
- In the review handoff, flag for the **human** (outward-facing; do not post it yourself): reply on GitHub issue #8. `kjeib`'s statistic (254 `default/Revocation` consults, 0 preceded by a read-repair trigger) identified the missing-block path. `risavian`'s "`default/Revocation` may not be empty here" was the control. Say plainly that the empty-collection behaviour was a real defect, just not the mechanism either of them proposed, and that it bounds the consult rate without by itself fixing non-convergence.
