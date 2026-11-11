description: When two or three machines share a collection and every change to it needs all of them to agree, a machine that has stayed connected to the others cannot have missed a change, so it should stop asking them "anything newer?" every ten seconds while it reads unchanged data — that idle chatter keeps phones behind a relay busy. It still re-checks after any disconnect, while a change it agreed to is unresolved, and at least every five minutes.
prereq: a-node-reports-whether-a-cohort-has-stayed-connected
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-p2p/src/repo/coordinator-repo.ts (`FreshnessStamp`, `markBlocksSeen`, `shouldReadRepair`, `readRepairBlock`, `fetchBlockFromCluster`, the accepted-tradeoff NOTE ending "Revisit only if a cadence-independent freshness signal … ever exists"), packages/db-p2p/src/repo/quiet-cohort.ts (new: the pure decision), packages/db-p2p/src/storage/pending-claim.ts (`cohortCanMissAPend`), packages/db-p2p/src/storage/storage-repo.ts (`IPendingClaimReader`), packages/db-p2p/src/cluster/cluster-policy.ts (`resolveReadRepairWindowMs`, `MAX_READ_REPAIR_WINDOW_MS`, the `clusterPolicy` fields), packages/db-core/src/cluster/structs.ts (`ClusterConsensusConfig.readRepairWindowMs`), packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, docs/transactions.md, docs/internals.md, docs/debugging.md, docs/reactivity.md (§ The node's watch service), packages/db-p2p/docs/cluster.md
----

GitHub [#56](https://github.com/gotchoices/Optimystic/issues/56), the follow-up #43 left open. Plan ticket `a-quiet-watched-collection-is-read-without-consulting-its-cohort` chose this design; this ticket carries it.

## The problem, measured by the reporter

In `lazy` read-repair mode a held block read more than `readRepairWindowMs` (10 s) after its last consult or commit stamp starts a cohort consult behind the read (`shouldReadRepair` in `packages/db-p2p/src/repo/coordinator-repo.ts`: elapsed time is the only input). Nothing changing does not stop it. On the in-process mesh, ten reads of unchanged data 15 s apart cost 10 consults (2 s apart: 1). Taleus, two parties on one strand, Node, idle: each re-read of one tally (18 SQL statements, about 82 block gets) cost 16–22 consult requests to the partner. On phones, a party re-reading every table after a restart kept its partner (a Galaxy S7) at 100% JavaScript for about 10 s serving consults over the relay.

## Why this rule (and not the alternatives)

**The rule.** A held block's window-expired consult is skipped while all of the following hold, up to `readRepairQuietWindowMs` (new, default 300 000 ms) after the consult that last checked it:

1. That consult heard from **every** other cohort member (a stated holding, `BlockGets.askerHolds`, counts as heard) and found nothing ahead of this node's copy — this node was current then.
2. The cohort is one in which **every commit needs every member's promise**: `!cohortCanMissAPend(n, superMajorityThreshold)` (`packages/db-p2p/src/storage/pending-claim.ts`), n ≥ 2 — two and three members at the default threshold of 0.75.
3. The cohort is the whole serving network this node knows of, and **no member's connection to this node has broken since that consult**: `IKeyNetwork.connectedCohort` (prereq ticket) returns the same members and the same connection-run ids now as it did when the consult started.
4. This node holds **no pending record** for the block (`IPendingClaimReader.listPendingClaims` on the storage repo, probed with `typeof` as `ClusterMember` probes it; a repo without it gets no extension).

Why that is sound: by (2) and (3), every commit to the block since the consult needed this node's promise, from a coordinator whose cohort is this same set — nobody this node is not connected to could have coordinated one, and no member could have committed without it while apart, because being apart ends a connection run. A commit this node promised is either applied here, cancelled, or still unresolved; (4) covers the unresolved case the ordinary way (the window consults), since a member holds the action's pending record from the pend's apply until its commit or cancel lands. So the copy is current except for one interval the window never closed either: a commit decided but whose decision has not yet been applied here (see residuals). What a consult would add is only an answer to "did I miss something", and these four facts already answer it.

This is the "cadence-independent freshness signal" the accepted-tradeoff NOTE at the local-current exit of `fetchBlockFromCluster` names as the only reason to revisit single-voter arming. It is not a trust relaxation: the consult that starts the quiet span is the same consult the window runs, under the same rules; the span only decides when the next one is needed.

**Rejected: freshness from change notifications or the watch's verifying tick (the reporter's direction 1).** A notification names one collection's log tail at one revision. It proves nothing about a data block whose copy here missed an earlier commit, so extending it to the header and data blocks would need the repo to map blocks to collections and their tails — knowledge it does not have — and would still serve such a copy indefinitely. A `skipWindowConsult` on vtab reads "while the watch is healthy" serves copies the watch never checks (the watch reads tails only), and the watch exists only for tables tagged `optimystic.network_watch`. The rule above is per block and needs no collection knowledge, so it covers the header, the tail and every data block of every collection a statement touches (the table and each index), tagged or not — which answers the plan's "which blocks does the signal cover" question.

**Rejected: only raising the window (direction 3).** Already settable (`clusterPolicy.readRepairWindowMs`); it lengthens the staleness bound for every deployment, including cohorts of four or more where a commit can land without this node. Forwarding it from a Sereus strand is Sereus's change (handoff, below).

**Why a cap at all, and why five minutes.** The residuals below are each closed by something else, but the cap is the bound that holds if one of those somethings is missing. Five minutes is the watch service's own recovery bound for a commit nobody announced (`verifyEveryTicks` 10 × the 30 s Core tick, `ReactivityCollectionWatch` in `packages/db-p2p/src/reactivity/collection-watch.ts`), and the reporter's own experiment ran at 300 000 ms. `0` disables the extension (today's behaviour exactly); a value at or below `readRepairWindowMs` disables it in effect, and the docs say so.

## What changes for a reader — the staleness bound

- **While the extension holds:** a held block is served from this node's copy with no consult. It is current except for a commit whose decision has not yet been applied here.
- **When it lapses** — a member's connection breaks, the membership changes, an unknown or remembered-but-absent peer appears, a pending record is held, or the cap passes: the next read past the window starts the consult exactly as today, and the bound is today's (one window plus one consult).
- **Never extended:** `readRepairMode: 'paranoid'` and `'off'` (unchanged); a floor above the local copy (`floorDemandsConsult` still consults at once — the asker's evidence beats any stamp); a block this node does not hold (still consults on every read); a sample-triggered consult (`readRepairSampleRate`, an operator's request for random verification); cohorts of four or more at the default threshold; a soft serve for a block this node is not a member for.

### How it degrades when a signal is lost

- **A connection that flaps:** each break starts a new run, so the next read of each block past the window consults once. Never more consults than today, because the extension only ever removes consults the window would have started.
- **A dropped notification / a failed watch registration:** irrelevant — the rule reads no notification.
- **A commit decision delivered late or never:** while this node holds the pend's pending record, (4) makes the window consult as today, which finds the partner ahead and acquires. A decision for a commit whose pend this node never applied (it approved the commit record's promise without a pending transform, which `validateCommitOperations` permits by abstaining) lands through the commit's own apply, which refuses as behind and reconciles from the partner. If the coordinator gives up delivering while staying connected (commit-broadcast retries exhausted and no later request carries the owed record), the cap bounds it. Put a `NOTE:` at the pending-record check naming this residual and the remedy if it is ever seen: also consult while this node's cluster member holds a consensus record touching the block that it voted on and has not settled.
- **A partner whose cohort view excludes this node while connected** (it is still identifying this node after a reconnect, or its membership predicate dropped this node): it can commit alone; that commit names this node in its under-replication ledger (`absentCohortMembers` → `unconfirmed`), and the drain pushes the copy on `peer:identify`. A reconnect also started a new run here, so this node's next read consulted anyway. Residual bounded by the push or the cap; NOTE at the extension site.
- **A peer this node does not know about** (a third machine connected only to the partner): it shows in FRET's band as `unknown` or is remembered as serving, and `connectedCohort` answers `undefined`. If FRET never learns of it at all, the cap bounds it.
- **Restart:** stamps live in memory, so the first read of each held block after a restart consults, as today.

## Design

### The decision, as a pure function (`packages/db-p2p/src/repo/quiet-cohort.ts`)

Kept out of `CoordinatorRepo` (backlog `debt-freshness-state-scattered-across-coordinator-repo` asks that new freshness state not be added as more loose fields there):

```ts
/** Recorded on a FreshnessStamp by a consult that heard from every member and found this node current. */
export type QuietCohort = { readonly members: readonly string[]; readonly runs: Readonly<Record<string, number>> };

/** Whether a stamp's quiet cohort still vouches for the block now. Pure; the caller supplies the fresh snapshot and the pending check. */
export function quietCohortHolds(recorded: QuietCohort, now: ConnectedCohort | undefined, ageMs: number, quietWindowMs: number, superMajorityThreshold: number, pendingHeld: boolean): boolean
```

`true` only when `now` is defined, its members and runs equal the recorded ones exactly, `members.length >= 2`, `!cohortCanMissAPend(members.length, superMajorityThreshold)`, `ageMs <= quietWindowMs`, and `!pendingHeld`. Also export the stamp-time predicate (members ≥ 2 and unanimity) so the recording side asks the same question.

### Recording (`fetchBlockFromCluster`)

- Before the consult starts (after the solo-self and empty-cohort exits, ahead of `queryClusterForLatest`), take `keyNetwork.connectedCohort?.(routingKeyForBlock(blockId))`. Taking it before the consult means any connection break during the consult already shows as a different run.
- `FreshnessStamp` gains `quiet?: QuietCohort`. `markBlocksSeen` takes it as an optional argument.
- Record it at exactly these exits, and only when the snapshot is defined, its member set equals the consult's `peerIds` set, `silent.length === 0`, and the stamp-time predicate holds: the local-current exit; the converged exit (`converged === true`); the `cohort-too-small` arming exit when its currency is `nothing-ahead`. Every other `markBlocksSeen` caller (own commits, `noteCohortCommitApplied`, the solo-self exit) writes a stamp with no `quiet`, which replaces a quiet one: conservative, and a commit stamp is itself a fresh check. (A commit this node applied in an undeclared two-machine group writes no stamp at all, so the quiet stamp before it stands — correct, since this node applied that commit.)

### Reading (`readRepairBlock`)

`shouldReadRepair` must say *why* it demands a consult, so a sample-triggered consult is not skipped: return a reason (`'unstamped' | 'expired' | 'sampled'`, or `undefined`), or split the sample test out — implementer's choice, keep it small. Then, on the path where the window alone demands (`windowOnly`, lazy, no floor), after the existing `skipWindowConsult` branch and before the background-consult branch: when the reason is `'expired'` and the stamp carries `quiet`, take a fresh `connectedCohort`, check pending records, and ask `quietCohortHolds`. If it holds, serve exactly as the inside-window path does (`flagUnconfirmedCurrency`, return) and start nothing; the stamp is not refreshed, so the cap counts from the consult. `awaitWindowConsults` (the test seam that makes window consults blocking) is skipped the same way.

Log `cluster-tx:read-repair-quiet` (fields: `blockId`, `localRev`, `ageMs`, `members`) the first time a given stamp extends a read — a flag on the stamp — not on every read; an idle tally re-read touches about 82 blocks.

The check costs one cohort assembly (no network, about 0.01 ms per `findCluster` on Node) and one metadata read, paid only by a read that finds its window expired, in place of a network consult. NOTE at the site: if it shows in an on-device profile, memoize the snapshot per read (`get` already deduplicates block ids) rather than per block.

### Policy knob

`readRepairQuietWindowMs` on `ClusterConsensusConfig` (`packages/db-core/src/cluster/structs.ts`) and `clusterPolicy.readRepairQuietWindowMs` (`packages/db-p2p/src/cluster/cluster-policy.ts`), resolved by a `resolveReadRepairQuietWindowMs` beside `resolveReadRepairWindowMs`: default 300 000; `0` allowed and means off; anything not a finite number in `[0, MAX_READ_REPAIR_WINDOW_MS]` throws at node construction with a message in the style of the window's. Threaded to `CoordinatorRepo` the way `readRepairWindowMs` is, and through the direct constructor's `cfg` default. Read once at construction, like every other policy field.

## Edge cases & interactions

- **Unsettled-claim memo (`unconfirmedAheadRev`):** a quiet stamp is recorded only on a `nothing-ahead` verdict from a fully answered consult, which retires any memo; the quiet path still calls `flagUnconfirmedCurrency`, so honesty is unchanged. By inspection.
- **Silent-consult holds:** a hold already makes `shouldReadRepair` false; a consult with any silent peer records no `quiet`. By inspection.
- **Floors:** `floorDemandsConsult` is evaluated before and independently of the extension; a floored read past the window still consults blocking. Test arm (below) not needed — by inspection that the quiet branch sits inside `windowOnly`, which excludes `floorDemands`.
- **Concurrent reads of one block:** the check reads the stamp and two local sources; two reads racing both skip, or one skips and one starts the (deduplicated) consult. No new state is written on the skip path besides the log flag. By inspection.
- **A consult that converged by acquisition:** recording `quiet` there is right (the copy is now current), but only if the restore did not throw and `converged` is true. By inspection.
- **The cohort changing between the consult's `findCluster` and its `connectedCohort` snapshot:** the member-set equality check at recording refuses it. By inspection.
- **Remote coordinators:** a read routed to another machine is judged by that machine's own stamps and connections; nothing travels on the wire. By inspection.
- **The watch service's verifying tick** (`ReactivityCollectionWatch`, no `skipWindowConsult`): under the extension it no longer sends a consult either. Correct by the same argument; update the cost statement in docs/reactivity.md § The node's watch service.
- **`noteCohortCommitApplied` and own-commit stamps** replace a quiet stamp with a plain one (see Recording). Under a declared two-machine group that costs one consult per written block after each change, then quiet again. By inspection; say it in the docs paragraph.
- **Mixed versions:** nothing on the wire changes. A peer on an older build is consulted as before by its own repo.

## Tests

In `packages/db-p2p/test/coordinator-repo-read-repair.spec.ts` (fake clock, the repo's existing seams), one `describe` for the extension:

- **The reproduction:** a two-member cohort, the partner answering a first consult nothing ahead; ten reads of the held block 15 s apart start one consult in total (today: ten). Count sync requests to the partner. If the reporter's Node mesh repro (issue #56) is cheaper to port onto the mesh harness via the prereq's `connectedCohort`, use that instead of a unit fixture — one, not both.
- **Each way it lapses consults again:** after the quiet span starts, (a) the partner's connection run changes → the next read past the window starts a consult; (b) a pending record is held for the block → consults; (c) age past `readRepairQuietWindowMs` → consults; (d) a four-member cohort (where `cohortCanMissAPend` is true) never extends. One `it` per arm is fine; they are the branches of the rule.
- **A consult with a silent member records no quiet span** → the next expired read consults.

No test for the policy resolver beyond what the existing `resolveReadRepairWindowMs` specs pattern requires, if any (check whether that resolver has its own spec; mirror it only if so).

## Docs

- docs/transactions.md § Lazy read-repair window: a new paragraph after *So does a commit this node applied as a cohort member* — "A held block whose whole cohort has stayed connected is not re-checked" — stating the four conditions, the soundness argument in two sentences, the cap, what it never extends, and the degradation list in short. Amend *Worst-case staleness bound* with the bound while the extension holds. Add `readRepairQuietWindowMs` to the knob table (beside `readRepairWindowMs`).
- docs/internals.md, *Quereus vtab read path*: the sentence "plus one cohort consult per block per window" gains "— none while the block's whole cohort, of two or three machines, has stayed connected ([transactions.md § Lazy read-repair window](transactions.md#lazy-read-repair-window))".
- docs/debugging.md: an entry for `cluster-tx:read-repair-quiet` beside `cluster-tx:read-repair-triggered`.
- docs/reactivity.md § The node's watch service: the verifying tick's consult is skipped under the same rule.
- packages/db-p2p/docs/cluster.md: list the knob where the other read-repair `clusterPolicy` fields are listed.
- Update the accepted-tradeoff NOTE at the local-current exit ("Revisit only if a cadence-independent freshness signal…") to point at this rule as that signal, and say the single-voter arming decision stands.
- `yarn lint:docs`.

## Handoff note for the review/complete ticket

Out of scope here, for the maintainer to pass on to Sereus: `strandClusterPolicy` does not forward `readRepairMode`, `readRepairWindowMs` or now `readRepairQuietWindowMs`; the extension needs nothing forwarded to work (defaults apply), but a strand that wants a different cap or the old behaviour needs them forwarded. Separately, a strand that declares its size (`repairCorroborationClusterSize` from its membership records) gets commit stamps as well, which this rule does not need but does not conflict with.

## TODO

- Add `quiet-cohort.ts` with `QuietCohort`, `quietCohortHolds` and the stamp-time predicate.
- Policy knob: type, resolver, threading, direct-constructor default.
- `FreshnessStamp.quiet`; `markBlocksSeen` argument; record at the three exits in `fetchBlockFromCluster` under the stated conditions.
- `shouldReadRepair` reports its reason; the quiet branch in `readRepairBlock`; the once-per-stamp log line; the residual `NOTE:`s at the pending check, the extension site (partner view), and the cost site.
- Tests as above.
- Docs as above; `yarn lint:docs`.
- `yarn build`, `yarn test` in `packages/db-p2p` (and `packages/db-core` for the struct change), `yarn typecheck` from root; `yarn test:integration` in `packages/db-p2p` if the mesh integration specs touch read repair (grep them for `readRepair`).
