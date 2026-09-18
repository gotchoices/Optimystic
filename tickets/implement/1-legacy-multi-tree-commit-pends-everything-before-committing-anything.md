description: In the default commit mode, a write that touches a table and its indexes saves each one separately, so when two machines race on the same unique value the loser's row is saved before its unique index refuses it, leaving two rows under one unique value. Make that commit reserve every piece first and save only once all pieces are accepted, the way the other commit mode already does, so a refused write leaves nothing behind.
files:
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (`commitTransaction`, `commitDirtyTreesLegacy` and its pre-flight, `DirtyTree`, `PartialCommitError`, the `CoordinatorPartialCommitError` branch, `mapCommitRefusal`)
  - packages/db-core/src/transaction/coordinator.ts (`commit`, `commitAttempts`, `commitOnceLatched`, `applyActionsToCollection`, `pendPhase`, `pendCollection`)
  - packages/db-core/src/transaction/transaction.ts (`createTransactionStamp`, `createTransactionId` — to build the legacy commit's transaction identity)
  - packages/db-p2p/src/cluster/race-resolution.ts (reads `pend.validation?.transaction?.priority ?? pend.priority` — why a pend without `validation` must carry `priority` itself)
  - packages/db-p2p/src/pend-validation.ts (`checkPendValidation` — what a member does with a pend that carries no `validation`)
  - packages/quereus-plugin-optimystic/test/concurrent-secondary-unique-refusal.spec.ts (the "racing" case currently tolerates the tear; tighten it)
  - packages/quereus-plugin-optimystic/test/legacy-commit-atomicity.spec.ts (injected pend/commit failures; expectations change)
  - packages/quereus-plugin-optimystic/test/mesh-node-harness.ts (`startMockMesh`, `createMeshDbNode` — the two-node harness the new regression spec uses)
  - docs/transactions.md (the "Legacy (single-node) commit is not atomic across trees" warning and its "Planned narrowing" paragraph)
  - docs/internals.md (the paragraph naming backlog `feat-optimystic-legacy-commit-two-phase` as the full close)
difficulty: hard
repro: verified
----

# Legacy multi-tree commit: pend everything, then commit everything

## What was measured

Reported by sereus (`../sereus/tickets/blocked/concurrent-unique-value-race-commits-both-rows.md`, 6 of 6 rounds, two real nodes). Reproduced here on the in-process two-node mock mesh (`startMockMesh(2)` + `createMeshDbNode`, no sockets), in about a second per six rounds:

| commit mode | table shape | rounds torn |
|---|---|---|
| legacy (default) | `T(id pk, g, v unique)` | 6 of 6 |
| legacy (default) | same plus `create index T_g on T (g)` | 6 of 6 |
| session (coordinator wired on both nodes) | `T(id pk, g, v unique)` | 0 of 6 |
| session (coordinator wired on both nodes) | same plus plain index | 0 of 6 |

Legacy loser: `PartialCommitError` naming the main table (and the plain index when present) as persisted and `_uniq_1.v` as not persisted; both rows `[1, 2]` are then readable on both nodes. Session loser: `UNIQUE constraint failed: T.v`, and exactly one row on both nodes, every round.

Two-handles-over-one-directory (the shape `concurrent-secondary-unique-refusal.spec.ts` uses) also tears; that spec's "racing" case already admits it in a comment and only asserts that the value stays enforced afterwards.

## Why it happens

`TransactionBridge.commitDirtyTreesLegacy` flushes each dirty tree with its own `tree.sync()`, and `Collection.sync` (via `TransactorSource.transact`) does pend then commit back to back for that one tree. The two writers' main-table inserts touch the same blocks, so one loses the first attempt — but the main-table replay of a *different primary key* succeeds, so the loser's row commits on its retry. Only when the sweep reaches the unique-index tree does the replay hit the `absentRange` guard (`TreeRangeTakenError`), and by then the main table (and any earlier plain index) is final. The pre-flight from `3.5-concurrent-secondary-unique-guard` cannot help: at pre-flight time neither rival has committed.

## Answers to the fix-stage questions

**1. Is pend-all-then-commit-all the right cure? Yes, and it already exists.** `TransactionCoordinator.commit` appends each participant's log entry, pends every participant (`pendPhase`, fanned out), and commits only when every pend succeeded. Two writers' pends collide on the shared log-tail and leaf blocks, so the loser's pend fails while nothing of its is final; `pendPhase` cancels the pends that did land; `commitAttempts` refreshes between attempts, and the refresh's replay throws the guard error, which the bridge already maps to `UNIQUE constraint failed: T.v`. The session-mode rows in the table above are that mechanism working on exactly this race.

**2. Is there a narrower cure? No.** Two candidates, both rejected:
- *Flush the unique-index trees first.* Closes this race but opens its mirror: the main table carries its own guards (a rival's same primary key → `TreeKeyTakenError`; a rival's change to a row an UPDATE read → `TreeEntryChangedError`). Writers `(1,'x')` and `(1,'y')` would both land their unique-index entries and one would then be refused on the main table, leaving an index entry with no row — a value refused forever (the symptom `backlog/bug-stale-index-entry-causes-false-unique-refusal` describes). With two guard-carrying trees in one write, no flush order is safe. (Reasoned from the guard sites, not run.)
- *Check the unique index inside the base table's pend.* A pend carries one collection's transforms and a member checks them against that collection only; there is no mechanism for a member to consult another collection's contents, and adding one is a bigger change than the cure.

**3. Does session mode have the same shape? No** — measured above, 0 of 6 in both shapes. So the fix belongs in the bridge's legacy branch, not in db-core's commit machinery. db-core needs only a small addition (below) so legacy can reuse the coordinator without the session's validation payload.

## Decided approach: route the legacy multi-tree commit through the coordinator

The backlog ticket `feat-optimystic-legacy-commit-two-phase` weighed two implementations: splitting `Collection.sync` into pend and commit halves ("the most safety-critical sync loop in db-core"), or reusing the coordinator. Its objection to the coordinator was that `commit()` "reads raw tracker transforms and does not call `Log.addActions`". **That is no longer true**: `commitOnceLatched` appends each participant's log entry through `applyActionsToCollection` → `Log.addActions` before pending. So reuse is the lower-risk path, and it is the path that is already exercised by every session-mode test. That backlog ticket is folded into this one and deleted. It carried one more field report worth keeping: GitHub issue #17 (VoteTorrent, four machines, legacy mode) hit the same tear on an ordinary membership write — `CadrePeer` persisted, `_uniq_7.stampid` not — triggered by a pend conflict that exhausted its retries rather than by a unique-value race. The issue body contains their no-mesh reproduction, `legacy-multi-tree-tear.test.mjs` (three tests, exported plugin API only, index tree name derived via `uniqueEnforcementTreeName`); run it against the fix as a second witness. Its trigger (the pend-conflict family, GitHub #18) is owned elsewhere; this ticket makes that trigger leave nothing behind rather than making it rarer.

### What legacy must NOT inherit from session mode: the validation payload

`pendCollection` always sends `validation: { transaction, operationsHash }`. A member with a validator configured re-executes that transaction's SQL statements; a legacy commit has no statements to re-execute, so a validating member would refuse it (`validator-fault`). Today's legacy pends carry no `validation` (the `Collection.sync` shape), which members accept under the default `unvalidatablePendPolicy: 'accept'` (`checkPendValidation`). Legacy through the coordinator must keep that shape:

- Give `TransactionCoordinator` a way to commit **without** a validation payload — e.g. a commit option, or a separate public method sharing `commitAttempts`. `pendCollection` then omits `validation` and puts the aged retry priority on `PendRequest.priority` directly, because `resolveRace` reads `pend.validation?.transaction?.priority ?? pend.priority` and would otherwise lose the priority aging.
- Nothing else on the member side keys on `validation` (checked: `race-resolution.ts` and `pend-validation.ts` are the only readers). Members configured `unvalidatablePendPolicy: 'reject'` refuse legacy pends today and will continue to — no change.
- The coordinator still needs a `Transaction` for `id` (the action id), `stamp` (expiration, the one-open-stamp check) and `reads`. Build one in the bridge per commit: a stamp from `createTransactionStamp` (engine id naming legacy, empty schema hash), no statements, and a fresh id. Decide `reads`: legacy entries today record none (`Collection.syncAttempts` calls `addActions` without reads); `[]` keeps that, the collections' recorded reads would add invalidation-cascade data. Either is acceptable; say which in the handoff.

### Bridge wiring

- Only when **more than one** tree is dirty. A single-tree commit is already all-or-nothing through `tree.sync()`; leave that path unchanged (keeps the common single-table, no-index write byte-identical).
- The coordinator is constructed per commit over a map of **only the dirty trees' collections**, not the whole `collectionRegistry`: `commitAttempts` refreshes every collection in its map between attempts and `stagedCollections` commits every staged one, and legacy's commit set has always been the dirty set. `DirtyTree` needs a way to reach its `Collection` (a `Tree` has `getCollection()`); make it part of the interface and update the test doubles, or resolve through the registry by id — implementer's call.
- Transactor: every dirty collection exposes `collection.transactor`. If they are all the same instance, use it. If not (tables declared on different transactors in one SQL transaction), one pend batch is impossible; keep the existing per-tree sweep for that case and leave a `NOTE:` at the branch saying so.
- The pre-flight (`update()` over every staged tree before the first flush) becomes redundant on the coordinator path — a stale pend is refused, the refresh between attempts replays, and the guard fires there. Remove it from that path rather than keep two mechanisms; keep the `NOTE:` history in the docs, not the code.
- Failure mapping, which mostly already exists in `commitTransaction`:
  - clean pend-time refusal → coordinator restores the pre-append snapshots and throws; the bridge's generic catch runs `rollbackTransaction` (restores `dirtyTrees` snapshots) and `mapCommitRefusal` turns a `TreeRangeTakenError` / `TreeKeyTakenError` / `TreeEntryChangedError` into the ordinary constraint message. This is the case sereus needs.
  - commit-sweep split → `CoordinatorPartialCommitError`, handled by the existing branch (latch degraded, tear down without restoring). Decide whether legacy should keep surfacing `PartialCommitError` for callers who catch it by class (VoteTorrent's GitHub issue #17 quotes its message); the simplest honest answer is to let `CoordinatorPartialCommitError` through and update `PartialCommitError`'s doc to say it now only arises from the per-tree fallback. Record the decision in `docs/transactions.md`.

### Known consequences to carry, not fix here

- **Log entry shape.** Coordinator-appended entries carry the participant list (`collectionIds`) and a reads field; legacy entries did not. Session mode already writes this shape and every reader handles it, so the backlog ticket's "byte-for-byte equivalent" requirement is replaced by: a reopen after a legacy multi-tree commit reads the same rows through a fresh handle, and a mixed history (old legacy entries then new ones) reopens cleanly.
- **`backlog/debt-a-failed-refresh-can-leave-a-collection-half-restaged` becomes reachable in default mode.** Its `tradeoffs:` said "only session-mode commits reach it"; after this lands, legacy multi-tree commits do too. An arm has been appended there; don't fix it in this ticket unless it shows up in the new tests.
- **`backlog/debt-session-mode-bridge-coverage`** — the `CoordinatorPartialCommitError` branch it says is untested becomes the legacy residual path, so the tests here partly cover it. Note that in the handoff.
- The session-mode residual window (a permanent stale loss in the commit phase after every pend succeeded) now applies to legacy multi-tree commits too; that is the same narrowing the backlog ticket promised, not a new exposure.

## Regression spec (the reproduction, to be kept)

Two-node mock mesh, not the libp2p integration harness: `startMockMesh(2)` gives each node its own transactor over a real in-process cluster (pend conflicts, cancels, race resolution all run), it reproduced 6/6 in about a second, and it runs under plain `yarn test`. The two-handles-one-directory shape also tears but has no cohort, so it proves less. The sketch that measured the table above:

```ts
for (const shape of ['unique-only', 'with-plain-index'] as const) {
	it(`${shape}: same-instant unique-value loser is refused with nothing stored`, async () => {
		for (let round = 0; round < 6; round++) {
			const { transactorFor } = await startMockMesh(2);
			const a = createMeshDbNode(transactorFor(0));
			const b = createMeshDbNode(transactorFor(1));
			const uri = `tree://race/${shape}-${round}`;
			const ddl = `create table T (id integer primary key, g text not null, v text not null unique) using optimystic('${uri}')`;
			for (const n of [a, b]) {
				await n.db.exec(ddl);
				if (shape === 'with-plain-index') await n.db.exec(`create index T_g on T (g)`);
			}
			const results = await Promise.allSettled([
				a.db.exec(`insert into T (id, g, v) values (1, 'g', 'x')`),
				b.db.exec(`insert into T (id, g, v) values (2, 'g', 'x')`),
			]);
			// assert: exactly one fulfilled; the other rejects matching /UNIQUE constraint failed: T\.v/
			// and is NOT a PartialCommitError / CoordinatorPartialCommitError;
			// on both nodes `select id from T` is exactly the winner's id;
			// countTreeEntries (mesh-node-harness) on the main tree and each index tree is 1 on both nodes
			// — the direct read of what was stored, around the vtab.
		}
	});
}
```

Also run the mirror race (same primary key, different unique values) to confirm no orphan unique-index entry: exactly one row, one entry in each index tree, loser refused with the primary-key message.

## TODO

- Add the two-node regression spec above (plus the same-pk mirror case); confirm it fails 6/6 on the current code before changing anything.
- db-core: let `TransactionCoordinator` commit without a `validation` payload, carrying priority on `PendRequest.priority`; unit-test in db-core that such a pend has no `validation` and does carry the aged priority on a retry.
- Bridge: route multi-tree legacy commits through a per-commit coordinator over the dirty trees' collections on their shared transactor; keep the per-tree sweep for single-tree commits and for the mixed-transactor case (with a `NOTE:`); drop the pre-flight from the coordinator path.
- Decide and implement the partial-commit error class legacy surfaces; keep the degraded latch behaviour.
- Tighten `concurrent-secondary-unique-refusal.spec.ts`'s "racing" case: exactly one row on both handles, loser gets the plain UNIQUE message, no `not atomic` text. Remove its comment excusing the tear.
- Update `legacy-commit-atomicity.spec.ts`: add "pend of the second collection fails → nothing persisted, clean rollback, plain error, reopen shows the pre-transaction state"; move the commit-failure case to whatever the residual now raises; add a successful two-tree commit that reopens to identical rows through a fresh handle.
- Keep green: `deferred-constraint-rollback`, `savepoint-rollback`, `update-pk-move-uniqueness`, `secondary-unique*`, `concurrent-*-refusal`, `two-node-*`, `session-mode-commit`, and the whole plugin suite (`yarn workspace @optimystic/quereus-plugin-optimystic test`, after `yarn build`), plus db-core's coordinator specs.
- Rewrite the `docs/transactions.md` legacy warning: multi-tree legacy commits now pend all before committing any; what remains is the commit-phase residual shared with session mode, and the mixed-transactor fallback. Update the comments in `commitTransaction` and above `commitDirtyTreesLegacy` that describe the old sweep.
- The deleted backlog slug `feat-optimystic-legacy-commit-two-phase` is still cited in `docs/internals.md`, `docs/transactions.md`, the pre-flight `NOTE:` in `txn-bridge.ts` and the racing case's comment in `concurrent-secondary-unique-refusal.spec.ts`; replace each with the new behaviour (and `yarn lint:docs`).
- Handoff: tell sereus's ticket owner the unblock condition (a same-instant unique-value loser refused with nothing stored) is met, with the spec name.
