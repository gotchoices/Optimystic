description: A storage machine with no room left now votes "I am out of space" when its group is asked to store a write, instead of agreeing and only discovering the problem when its disk fails — and the writer is told its group is full rather than being sent round a retry loop that cannot succeed.
architecture: docs/correctness.md, docs/transactions.md
files: packages/db-core/src/cluster/structs.ts, packages/db-core/src/network/struct.ts, packages/db-core/src/network/stale-failure.ts, packages/db-core/src/network/cohort-out-of-space-error.ts, packages/db-core/src/network/index.ts, packages/db-core/src/collection/write-attempts.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/transaction/coordinator.ts, packages/db-core/src/transactor/network-transactor.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/storage/storage-pressure.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/cluster-pend-out-of-space.spec.ts, packages/db-core/test/cluster-vote-payload.spec.ts, docs/correctness.md, docs/transactions.md, docs/debugging.md, docs/blobs.md, docs/internals.md, docs/right-is-right.md, packages/db-p2p/docs/cluster.md, packages/db-p2p/docs/storage.md
----

# A full cohort member refuses a pend

A cohort member whose storage has filled the space its operator gave it answers a pend with a signed `out-of-space` vote, instead of approving and discovering the problem at apply or filling its disk. The vote carries no payload — its type is the whole message — and is counted apart from approvals and rejections at every threshold, exactly as `conflict` and `held` are, so one full member can never push a record into the permanent `Rejected` phase. The writer's answer is a typed `OutOfSpaceFailure` naming the refusing members, returned rather than thrown, which no write path retries.

Landed as `ticket(implement): a-full-cohort-member-refuses-a-pend`, with this review's fixes on top.

## What shipped

**The vote.** `Signature` gained `{ type: 'out-of-space'; signature: string }`, signing the bare tag `<hash>:out-of-space` — the form it shares with `approve`. `PromiseVerdict` gained a fourth kind; `voteFor` maps it; `refusalLogTag` gained `cluster-member:validation-out-of-space`.

**The member's gate** sits at the very end of `ClusterMember.validatePendOperations`, behind a flag so only a record that actually asked this member to store something can draw it, and reads `StoragePressure.refusingNewData()` — the last sample, never a scan. `out-of-space` joined `getTransactionPhase`'s retryable refusals beside `conflict` and `held`, and is absent from the rejection count.

**The coordinator** throws `CohortOutOfSpaceError` from a new branch in `ClusterCoordinator.executeTransaction`, after conflict and held and before the generic shortfall, and includes the out-of-space votes in the sum that gates its abandonment broadcast.

**The writer's answer** is `OutOfSpaceFailure`, modelled field for field on `ShortfallFailure` and told apart by `isOutOfSpaceFailure`; `CoordinatorRepo.pend` returns it rather than letting it escape. A cohort of one casts no vote, so `refuseSoloPendForSpace` builds the same answer directly — exempting a write from the program on this machine, whose limit is the allotment rather than the refusal threshold.

Four write-path sites in db-core carry it to the writer without a retry loop: `WriteAttempts.recordRefusal`, `refusalFrom`, `pendRefusalError` and the `CoordinationResult` chain behind `cleanFailureError`.

## Review findings

### Checked and sound, no change

- **The ordering claim, re-derived rather than taken on trust.** "`out-of-space` is only ever the answer for a record the member would otherwise have approved" holds all the way up. The gate is after every other refusal in `validatePendOperations`; `batchShapeFault` makes a multi-operation message all pends or all commits and a single-operation one one or the other, so a record that can reach the gate carries no commit operation; and each of the four commit-side checks `evaluatePromise` runs after it (`validateCommitRevisions`, `validateCommitAgainstRefusedPend`, `validateCommitBaseDeclarations`, `validateCommitOperations`) skips every non-commit operation, so all four are no-ops on such a record. Read and confirmed at each site.
- **Equivocation, penalties and round decision.** `equivocationKey` keys on the vote's type, so a member that voted out-of-space and later approves is caught as a type flip like any other. The promise-round penalty is `ConsensusTimeout` on a failed delivery, never on a vote type, so an honest out-of-space vote is penalised nowhere a `conflict` is not. `promiseRoundDecided` counts approvals only, so such a vote makes a round decided *out of reach* with no change. Each re-verified by reading the named function.
- **The three decisions the handoff asked a reviewer to weigh are ratified as built.** One `CohortOutOfSpaceError` in db-core, thrown in db-p2p, converted at the coordinating repo, is the precedent `PromiseShortfallError` and `TransactionExpiredError` already set. The three unnamed db-core write-path sites are each required by the ticket's stated goal — without `WriteAttempts.recordRefusal` in particular the single-collection write path burns its whole retry budget and reports contention for a cohort that is simply full, which is the symptom the ticket exists to remove. `refusalFrom`'s placement of out-of-space last of the four follows the ordering rule already written there and matters only for a write whose batches mix a shortfall with a full cohort; the opposite order is arguable and the comment says so, which is enough.
- **The solo gate's `localWriter` exemption is kept, and now tested.** On a cohort of one it is load-bearing: what clears a full cohort is its members shedding to peers with room, and a cohort of one has no peer to shed to, so refusing here would stop a single-machine deployment writing at 95 % of its allotment with no path back but its operator raising the number. `localWriter` is set only by a transactor in this process and never travels on the wire, so a remote writer cannot claim it. The consequence the handoff states plainly — a solo node's own block writes are then gated by nothing until the disk itself fails — is the status quo rather than a regression. Weighing it did surface a real asymmetry, below.

### Found and fixed in this pass

- **The solo refusal claimed an approval it never cast.** `refuseSoloPendForSpace` reported one approval, so an operator's log line read "1/1 member(s) have no room left (1/1 approvals)" — self-contradictory, and the opposite of a cohort's shape, where the members that refused are exactly the ones missing from the approval count. Now zero, with the field's doc corrected to match.
- **`CohortOutOfSpaceError`'s peer list was documented "Never empty"** while the solo path can hand it an empty one (a hand-wired repo with no local peer id). The doc now says what `CohortOutOfSpace` already said correctly.
- **A wrong citation.** `libp2p-node-base.ts` pointed at `StoragePressureGate` "in `cluster/cluster-repo.ts`", which only imports it; it is declared in `storage/storage-pressure.ts`.
- **A stale doc comment.** `verdictOf` still said `validatePendOperations` produces "the `held` kind and a marked `invalid`"; it produces `out-of-space` too.
- **A missing `NOTE:` in the one place that enumerates how each refusal kind lands.** The re-send classifier in `Collection` carries a NOTE per failure kind saying which arm it falls into and whether it can clear; out-of-space now has its one, in the "can clear" arm, saying it cannot clear within one write's budget and what to do if a full cohort is ever seen holding torn writes.

### Docs the change left behind, and fixed

The ticket's `files:` line named three documents. Five more were made stale by the same change, each at a place that counts or enumerates:

- **`packages/db-p2p/docs/storage.md` §10 is the owner document for what a full node refuses, and it still said three doors.** The pend door is now a fourth row in that table — with the cohort-of-one arm and the `localWriter` exemption on it — and the four "three doors" counts around it are corrected. The "deliberately NOT gated" bullet about applying an approved commit no longer forward-references a vote that now exists; it points at the door.
- **`packages/db-p2p/docs/cluster.md` reproduces the `Signature` union and said "exactly one of four signed vote kinds".** Five now, with the new variant in the code block and the "`conflict` and `held` are the two transient refusals" sentence widened to three. Its `ConflictSuperseded` prose also still said "conflict votes make super-majority unreachable" in three places — stale since the `held` ticket, not only this one — and now says what the code comment says.
- **`docs/internals.md`** listed the refusals that are not a prose `reject`; out-of-space was missing.
- **`docs/right-is-right.md`**'s "which rejections are disputes" table classified every member refusal into four classes with no room for this one. It has a fifth, **capacity**, which starts no dispute — kept as its own row rather than folded into *transient*, because that row's "retry can win" is exactly what this refusal tells a writer not to try.
- **`docs/blobs.md`** called the announce refusal "one of the three doors".

### Filed as tickets

- **`bug-a-nodes-own-block-write-is-refused-by-its-own-cohort-vote`** (backlog). The repository's stated rule is that a node's own writes are refused later than everybody else's — at the allotment, not at the refusal threshold, with the headroom between the two explicitly reserved for them. The solo gate honours it; a cohort member cannot, because the mark that says "my own program wrote this" is set in the writer's process and must never travel on the wire. So the same write is accepted when this node is the whole cohort and refused when it is one of three — and on a three-node deployment, where every cohort holds every node, one node crossing 95 % stops every write to its slice, its own application's included. Reachable now rather than conditional, which is why it is a ticket and not a tripwire; the ticket carries the two fix shapes worth weighing and the honest alternative of deciding the rule does not extend to block pends at all. Recorded at both doc sites that state the rule.
- **`bug-a-full-cohort-refusal-reaches-the-offline-drain-unclassified`** (backlog). The handoff parked this as a `NOTE:` reading "conservative and safe, less specific than the facts allow". It is more than that: `unknown` is a signal in its own right — the offline drain increments `unclassifiedFailures`, which `docs/offline-sync.md` documents as "zero in a correct deployment" and the Quereus plugin surfaces as a health reading, and logs the failure as one nothing could name. Filed with both arms: the mapping decision (genuinely a decision about drain behaviour, so not fixed inline), and the rung-2 guard that pays regardless — a test enumerating the error classes a write path raises and asserting each sorts to something other than `unknown`, since this is the second instance of the same shape. The site's `NOTE:` now points at it.

### Parked as a tripwire

- **The promise-vote test harness is now copied into a third spec.** The hundred lines from `canonicalJson` to `voteVerifies` are the same in `cluster-pend-staleness.spec.ts`, `cluster-pend-held-vote.spec.ts` and the new spec. Not this ticket's sin and not worth touching three files for now, so the new spec carries a `NOTE:` naming the trigger: a fourth spec that needs it moves it to `test/support/`, where `capture-log.ts` already lives.

### Explicitly empty

- **No accepted tradeoff was re-litigated.** Read around each site before filing; the only `NOTE:`s at the sites touched are this ticket's own tripwires, and the `OwnWriteRoom` reasoning the solo exemption cites, which the new ticket extends rather than contradicts.
- **No test was cut.** Each of the implementer's six cases pins a distinct named claim — the vote's signed form, the terminal-but-retryable phase that is the headline, the control that keeps the gate from passing unconditionally, both halves of the ordering rule, and the writer's end-to-end answer — and none restates the implementation or verifies a mock. The `cluster-vote-payload` case is one line in an existing test.
- **No file-size finding.** `cluster-repo.ts` (4028 lines) and `coordinator-repo.ts` (4623) are both over any reasonable bar, measured with `wc -l`, but both are already claimed by open debt tickets (`debt-cluster-coordinator-owed-delivery-outgrew-its-file`, `debt-freshness-state-scattered-across-coordinator-repo`) and this change adds some forty lines between them. Nothing new to file.
- **No pre-existing failures surfaced,** so no pre-existing-failure report was written.

### Tests added

Two cases on a new solo tier of `packages/db-p2p/test/cluster-pend-out-of-space.spec.ts`, which had none. The handoff asked a reviewer to decide whether the gate warranted one, and the `localWriter` exemption decided it: it is a second behaviour, it is the implementer's own rather than the ticket's, and a later refactor deleting one clause would silently stop a single-machine deployment accepting its own application's writes. One case pins the refusal (typed answer, naming itself, no approval claimed, nothing reaching local storage), one pins the exemption. Both run through the real `CoordinatorRepo` over a cohort of one.

## Verification

Full suites once, after the fixes above, per `tickets/rules/testing.md`.

- `yarn workspace @optimystic/db-core test` — 2124 passing.
- `yarn workspace @optimystic/db-p2p test` — 3924 passing, 84 pending.
- `yarn workspace @optimystic/quereus-plugin-optimystic test` — 1458 passing, 16 pending, smoke ok (db-core and db-p2p both reach it).
- `yarn workspace @optimystic/db-p2p test:integration` — 60 passing, 2 pending. Run because the change touches cohort assembly and consensus voting.
- `yarn check:rn` — passed. Run because the change adds a db-core module exported from its network barrel, and db-core ships to React Native.
- `yarn lint`, `yarn lint:docs` (49 documents, 900 anchored citations, 863 links, all resolve), `yarn lint:deps`, `yarn typecheck` (all 13 packages) — clean.
