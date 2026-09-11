description: When a read asks for something this machine already has, it is served locally with no network chatter — that part works as designed. But when a read asks for something this machine does not have, it asks the network every single time, with nothing limiting how often, even on a one-machine deployment where there is nobody to ask. An app that checks for an as-yet-uncreated record on every operation therefore pays a full network lookup per check, forever.
prereq:
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts:766 (the two consult triggers, one of which the comment itself labels "legacy behavior")
  - packages/db-p2p/src/repo/coordinator-repo.ts:794 (`isStale` is computed only when `!isMissing` — the window never gates a missing block)
  - packages/db-p2p/src/repo/coordinator-repo.ts:1062 (`shouldReadRepair` — the window a missing block never reaches)
  - packages/db-p2p/src/repo/coordinator-repo.ts:1175 (the solo-self exit; its `markBlocksSeen` cannot help a block that never consults the window)
  - packages/db-p2p/src/repo/coordinator-repo.ts:707 (`getClusterPeerIds` — the `findCluster` each of these consults pays first)
  - packages/quereus-plugin-optimystic/test/cold-apply-cost.spec.ts (gate 4 counts `findCluster` per commit; nothing counts consults per absent read)
difficulty: medium
tradeoffs: Remembering that a block is absent is a negative cache, and negative caches fail in the direction users notice — a block that has since been created stays invisible for the life of the memo. The conservative variant avoids that entirely by short-circuiting only where the consult provably cannot learn anything (a cohort of exactly this node), which costs no staleness at all but helps only small deployments. The general variant helps everyone and needs a real answer for how an absence is retired.
----

# A block this node does not hold is consulted on every single read, with no rate limit

## Correcting the record first

This ticket replaces `every-read-re-derives-its-routing`, filed earlier the same evening. That ticket's premise — that every read re-derives its routing — **is wrong**, and the code says so plainly. Reads of a block this node holds, inside the read-repair window, do no cluster work at all:

```ts
const isMissing = !localEntry?.state?.latest;
const isStale   = !isMissing && this.shouldReadRepair(blockId);
if (!isMissing && !isStale) {
    this.flagUnconfirmedCurrency(localResult, blockId, blockGets.context);
    continue;                       // ← no findCluster, no consult
}
```

So the maintainer's instinct — *"why can't we stay on our last known revision; if we turn out to be stale we'll be notified at commit or cache-missed read time"* — is **already the design** for held blocks. That question is what produced this ticket, by pointing at the one case where the answer is "we don't".

## The actual defect

`isStale` is computed **only when the block is present**. A block that is absent locally skips the window entirely and consults the cluster on every read, forever. The comment above the branch names the asymmetry without flagging it as a problem:

```
//   (a) Missing — block isn't present locally at all (legacy behavior).
//   (b) Stale-by-policy — block is present but read-repair policy says verify.
```

Trigger (b) is rate-limited by `readRepairWindowMs` (10 s). **Trigger (a) is rate-limited by nothing.**

This is the same defect class that 0.29.0 fixed, still live on the neighbouring path. 0.29.0 made the solo-self exit call `markBlocksSeen` so the window arms — but a missing block never consults the window, because `isMissing` short-circuits ahead of it. **Arming cannot help the absent case, and nothing else bounds it.**

On a solo cohort each of those consults is provably incapable of learning anything: `findCluster` returns self only, and the exit logs `cluster-fetch:solo-self-skip` and returns without asking anyone. We pay a full cohort lookup to discover we are the only one who could have answered, on every read of every block we do not have.

## The reporters' data already contains the proof, read the other way round

`kjeib` measured, on 1.0.0-beta.2 (GitHub issue #8):

```
solo-self-skip total           626
  of which default/Revocation  254
  preceded by a read-repair trigger    0
read-repair-triggered          290
```

He offered **zero of 254** as evidence *against* a loop, and he was right that it refutes the unarmed-window mechanism he had proposed. But the same statistic also identifies which path those consults took: a consult with no preceding `read-repair-triggered` line is by construction **not** the `isStale` path. All 254 were missing-block consults. The totals agree — 626 skips against 290 triggers leaves ~336 consults that no trigger accounts for.

`default/Revocation` is empty on a fresh party, which is exactly why it dominates his capture.

And the control is already on the record. `risavian`, who does **not** reproduce the `default/Revocation` behaviour, volunteered the reason without knowing it was one:

> our create runs against a store that already holds several prior networks, so `default/Revocation` may not be empty here. If the "empty block" hypothesis is right, that would fit.

It fits. A block you hold takes the windowed path; a block you do not hold takes the unbounded one.

## Why this is worth doing before, or instead of, more of the batch-hook work

`feat-schema-batch-hooks-for-apply-schema` reduces how many coordinated operations a schema apply performs. This removes work from reads that should not be doing any — and unlike the hooks it is not specific to `APPLY SCHEMA`. Any hot read of a not-yet-created record pays it: existence checks, optional rows, an index probe that misses, a party-scoped record before first write.

It also has a much smaller blast radius than the routing memo the superseded ticket proposed, which needed an invalidation story tied to membership change. The conservative option here needs none at all.

## Measured in-process (2026-09-11) — the mechanism is confirmed and the headline number was being read wrong

The section above said the design need not wait on a measurement. It has one anyway, from a real solo `CadreNode` driven through `start()` → `ensureOwnerKey()` → `foundStrand()` against the linked workspace, counting the exact `debug` tags from the device report. Repeat runs identical.

### The reported 626 is not the cost of four tables

| app tables in the strand schema | founding consults | founding commits |
|---|---|---|
| 1 | 86 | 18 |
| 4 | **89** | **18** |
| 24 | 109 | 18 |

The slope is **1 consult per app table and 0 commits per app table**. The app's tables ride the one catalog commit the strand's schema apply already pays. So of the reporter's 4-table strand: **4 of 89 consults are his, and none of the commits are.** The rest is control-plane work.

And the total does not come from founding at all. Idle, after founding, a solo node produces **~46 consults per minute forever** — 4 `Revocation` + 4 `CadrePeer` per ~15 s reconcile pass, both absent, with **zero damping**. Founding (89) plus 14 minutes of idle (~640) lands at ~730 against his 626, and the block mix his capture shows is the mix this run produces.

**These counters scale with wall-clock time on a run that never converges, not with schema size.** Every reading of "626 consults to apply four tables" — ours included — had the causality backwards: the consults are not why it is slow, they are what a stalled node emits while it waits. That does not make them harmless (they are unbounded, and each is a native-bridge crossing on the reporting platform), but it does mean removing them is not by itself the fix for non-convergence.

### The absent-versus-held asymmetry, isolated

Same query shape, two tables, six consecutive calls:

| collection | ever written? | consults |
|---|---|---|
| `OwnerKey` | yes, at genesis | **1** on call 1, then **0** |
| `Revocation` | never | **2 on every call**, 6 of 6 |

A held block arms the window and goes quiet. An absent one never does. That is this ticket's claim, measured directly rather than inferred from the device capture.

### Why it is hot enough to matter

`Revocation` is not read occasionally. It is read *before the row read* on the common path: `queryRevokedStamps` is called unconditionally by `queryCadrePeers` and `queryPeerRecord`, so every membership or address lookup pays an extra absent-block consult. `ControlDatabase.queryCadrePeers()` measures **exactly 4 consults on every call, flat across 20 consecutive calls**. Beyond the TypeScript callers, six control-plane tables carry `NotRevoked` insert checks that subquery `Revocation`, so **every control-plane insert reads an absent block too**.

That half is the downstream repository's to fix, and a ticket has been filed there. This ticket owns the reason an absent read is unbounded in the first place.

### The coverage gap, stated precisely

Gate 4 in `cold-apply-cost.spec.ts` counts `findCluster` **per commit** — a ratio. An absent-read consult happens with **no commit at all**, so it divides into nothing and the gate is structurally incapable of seeing this class. The downstream repository's two storage budgets are blind for a different reason: they count `IRawStorage` calls *below* a write-through cache, and an absent-block consult never reaches raw storage. A regression that doubled cohort consults would leave every existing gate in both repositories green.

This is why the TODO below puts the consults-per-absent-read gate before the fix rather than after it.

## What a design pass has to settle

**1. The conservative option: skip a consult that provably cannot learn.** When the cohort is exactly this node, no consult of any kind — (a) or (b) — can return information this node does not already have. Short-circuit before `findCluster` rather than after it, so the cohort lookup is saved too. This carries **no staleness risk whatsoever**: there is no peer whose answer we are declining to hear, and a peer appearing is an observable event. Decide whether this ships alone, and whether it subsumes enough of the reported pain to defer the rest.

**2. The general option: may an established absence be remembered, and for how long?** `AbsenceVerdict` already distinguishes a *confirmed* absence (the cohort answered and nobody holds it) from `unconfirmed` and `isolated`. A confirmed absence is the only shape that could be safely remembered, and even then the memo must not outlive the cohort view that produced it. Note the asymmetry against trigger (b): a stale revision is a wrong answer, whereas a remembered absence is a **missing** answer, which callers experience differently and often worse.

**3. What retires an absence memo — and the trap.** The schema-apply workload reads a block, finds it absent, then creates it. A memo that survives this node's own write would hide our own data from us. Any absence memo must be invalidated by the local write path, not only by a timer. Confirm where that hook goes and that it cannot be bypassed by a write that reaches storage through a different seam.

**4. Whether `NetworkTransactor.get`'s authoritative-absent handling changes.** There is an existing coupling recorded at `coordinator-repo.ts:780`: the transactor treats an authoritative absent as final and stops retrying, *relying on this cluster reconciliation having already run*. A short-circuit that skips the consult must not turn a not-yet-reconciled absence into an authoritative one. This is the correctness question of the ticket; settle it explicitly rather than by inspection.

**5. Whether trigger (b) should also be skipped for a solo cohort.** Today a held block on a solo node still consults once per 10 s window to learn nothing. Same argument as question 1, lower volume. Probably the same fix; confirm it is.

## Edge cases and interactions

- **A cohort of one that is about to stop being one.** The `findCluster` membership comment notes a same-network peer is invisible while still `unknown` mid-identify. A solo short-circuit must re-evaluate when identify completes, or a node that just gained a peer keeps behaving as though alone.
- **Absence versus emptiness.** `!localEntry?.state?.latest` is "no latest revision here", which is not the same as "this block does not exist". Make sure the design does not conflate a block awaiting its first write with one whose revisions this node simply lacks.
- **`flagUnconfirmedCurrency` on the skipped path.** The held-and-fresh branch still flags recorded doubt when it skips. Any new skip path must decide the same question rather than silently serving a clean answer.
- **Restoration and soft serves.** `get` can acquire a block durably on a soft-served read (see the NOTE at the top of `get`); a short-circuit that skips the consult also skips that acquisition. Establish whether that matters for a node that is not responsible for the block.
- **Mesh harness coverage.** `createMesh` injects its own key network, so a short-circuit added at the `Libp2pKeyPeerNetwork` layer would not appear in mesh tests. Put it where the mesh exercises it, or the gate measures a configuration nothing ships.

## Measurement

Unlike the superseded ticket, the mechanism here is established from the code and corroborated by two independent captures, so the design need not wait on a measurement. Still gate it: count **consults per absent read** — nothing does today. `cold-apply-cost.spec.ts` gate 4 counts `findCluster` per commit and would not have caught this.

A cheap reproduction should exist on Node: read the same never-written block N times on a solo coordinator and assert the consult count does not scale with N.

## TODO

- [ ] Settle questions 1–5; emit implement ticket(s). Question 4 is the one that can make this unsafe — if it has no defensible default, route to `blocked/` rather than guessing.
- [ ] Add the consults-per-absent-read gate before the fix, so the before/after is measured rather than asserted.
- [ ] Reply on GitHub issue #8 once this lands: `kjeib`'s 254/0 statistic identified the path, and `risavian`'s "may not be empty here" was the control. Both should be told their data was decisive, and told plainly that the `default/Revocation` behaviour was a real defect after all — just not the one either of them named.
- [ ] Delete `every-read-re-derives-its-routing` from `plan/`; its premise does not survive. Carry forward only the observation that `recordCoordinator` ignores self picks, if question 5 turns out to want it.
