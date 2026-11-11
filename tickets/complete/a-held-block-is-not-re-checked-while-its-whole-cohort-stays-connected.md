description: When two or three machines share a collection and every change to it needs all of them to agree, a machine that has stayed connected to the others can no longer have missed a change, so it now stops asking them "anything newer?" every ten seconds while it reads unchanged data. It still re-checks after any disconnect, while a change it agreed to is unresolved, and at least every five minutes.
prereq: a-node-reports-whether-a-cohort-has-stayed-connected
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-p2p/src/repo/quiet-cohort.ts, packages/db-p2p/src/repo/coordinator-repo.ts (`FreshnessStamp`, `ReadRepairDemand`, `readRepairDemand`, `readRepairBlock`, `startHeldBlockConsult`, `markBlocksSeen`, `connectedCohortBeforeConsult`, `quietSpanStartedBy`, `quietCohortStillVouches`, `livePendingClaims`, `fetchBlockFromCluster`), packages/db-p2p/src/cluster/cluster-policy.ts (`DEFAULT_READ_REPAIR_QUIET_WINDOW_MS`, `resolveReadRepairQuietWindowMs`), packages/db-core/src/cluster/structs.ts (`ClusterConsensusConfig.readRepairQuietWindowMs`), packages/db-p2p/test/coordinator-repo-read-repair.spec.ts, docs/transactions.md, docs/internals.md, docs/debugging.md, docs/reactivity.md, packages/db-p2p/docs/cluster.md
----

GitHub [#56](https://github.com/gotchoices/Optimystic/issues/56). The rule and its soundness argument are in docs/transactions.md § Lazy read-repair window, paragraph *A held block whose whole cohort has stayed connected is not re-checked*.

## What was built

In `'lazy'` mode, a held block whose read-repair window has expired is served from the local copy with no cohort consult while its **quiet span** holds. A span is started by a consult that heard from every other member, found nothing ahead of this node's copy, and ran in a cohort where every commit needs every member's promise (two or three members at the 0.75 default). The span holds while `IKeyNetwork.connectedCohort` reports the same members on the same connection runs as it did just before that consult, and while this node holds no live pending record for the block. It lasts at most `readRepairQuietWindowMs` (default 300 000; `0` turns it off) after the consult that started it. Any other stamp ends it. The pure decision is in `quiet-cohort.ts`; the recording is in `fetchBlockFromCluster`'s three window-arming exits; the read-time check is in `readRepairBlock` / `quietCohortStillVouches`. The first read a span answers logs `cluster-tx:read-repair-quiet`. Implemented in `ticket(implement): a-held-block-is-not-re-checked-while-its-whole-cohort-stays-connected`.

## Review findings

**What was checked.** I read the whole implement diff before the handoff, and then read the surrounding `fetchBlockFromCluster`, `ConsultRound` and stamp writers.

- **Soundness of the rule.** `members` (with this node) and the consulted `peerIds` (with this node) are compared like for like. A soft serve leaves this node out of `peerIds`, so the sizes differ and no span starts. I traced a two-member write with a deferred pend decision. This node applies the pend before it votes on the commit record, so between its commit vote and the delivery of the commit decision it holds a pending record, and that blocks the span. The only gaps are the two NOTE residuals. A member apply that does not stamp (an undeclared two-machine group, where `commitQuorumRulesOutRivals` is false) leaves the span running. That is still sound, because this node promised and applied that commit. The docs' "each change costs one consult" is stated for a declared group only, so the docs are accurate.
- **Seat handover in the read's consult round.** The quiet check takes its seat before its await. Every path afterwards releases or hands over that seat: the hold path readies it; `startHeldBlockConsult` hands it to the pass that starts, or readies it on `running` or `deferred`; the blocking path hands it to `leavingSeat`. The code between the await and those calls (`askerStatementFor`, the log line) is synchronous and pure.
- **Other stamp writers.** Commit arming, member apply, solo-self and the test seam all write a stamp without `quiet`, so each ends a span as the docs say.
- **Knob wiring.** The default and its validation go through `resolveClusterPolicy` and `CoordinatorRepo`'s own resolver. The value is off unless the mode is `'lazy'`, the quiet window is above `readRepairWindowMs`, and `connectedCohort` exists. `MAX_READ_REPAIR_WINDOW_MS` = 2³¹ − 1 matches the knob table.
- **Docs.** I read the changed sections of transactions.md, internals.md, debugging.md, reactivity.md and cluster.md against the code, and `yarn lint:docs` passes. The renamed `readRepairDemand` is the name now used everywhere it is cited.

**Found and fixed in this pass.**

- **Test gap the handoff named.** No test covered a read naming several blocks where one block's quiet span holds and another block consults. A seat that was never readied there would hang the other block's request and the read. I added *a read whose span holds for one block still consults another block alongside it* to `coordinator-repo-read-repair.spec.ts`, and gave the fixture's `readAfter` an optional block list. Mutation check: deleting `reserved?.ready()` on the hold path makes this test time out (10 s); restored, it passes.
- **Stale comment.** In `resolveClusterPolicy`, the comment now says both read-repair windows throw on a bad declaration.

**Considered and left alone.**

- `quietCohortHolds` re-checks `cohortCommitsNeedEveryMember` on the recorded size, which `quietCohortFor` already checked when the span started. It costs nothing and keeps the pure function's contract complete on its own.
- A consult of a block missing locally takes a `connectedCohort` snapshot it often cannot use. I kept it, because an acquisition that converges on such a consult does start a span. The per-read cost tripwire stays the existing `NOTE:` at `quietCohortStillVouches`; it is unmeasured on a device, as the handoff says.

**Major findings:** none, so no tickets were filed. **New tripwires:** none; the three `NOTE:`s at `quietCohortStillVouches` already cover the residuals and the cost.

**Known gaps carried from implement.** The `cohort-too-small` and converged-acquisition recording exits, the sample-rate and floor exclusions, and concurrent reads were checked by reading the code, not by tests. `members` on the log line is a count, not the peer list.

**Validation.** Lint, doc lint and the db-p2p build all pass. `yarn test` in db-p2p: 3654 passing, 75 pending. The only source change outside tests is a comment, so I did not re-run the db-core and plugin suites (the implement stage ran them green).

## Handoff note for the maintainer, to pass to Sereus

`strandClusterPolicy` does not forward `readRepairMode`, `readRepairWindowMs` or `readRepairQuietWindowMs`. Nothing has to be forwarded for the feature to work, since the defaults apply. A strand that wants a different cap, or the old behaviour (`0`), needs the fields forwarded. A strand that declares its size (`repairCorroborationClusterSize`) also gets commit stamps. Those carry no quiet cohort, so each one ends a span, and the next expired read consults once and starts a new one.
