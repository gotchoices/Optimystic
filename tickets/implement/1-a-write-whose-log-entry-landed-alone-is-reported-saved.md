description: A write can be reported as saved when only its log record was stored and the table data it changed never was, so the row is silently lost on every machine. The client's retry sees its own log record and wrongly decides the whole write is finished.
files:
  - packages/db-core/src/collection/collection.ts (`syncAttempts`, `updateInternal`, `consumeOwnEntry`, `inFlightActionId`)
  - packages/db-core/src/transaction/coordinator.ts (multi-collection retry loop; the NOTE near line 1044 describing the same own-entry consume)
  - packages/db-core/src/transactor/network-transactor.ts (`commit`: tail first, then `commitBlocks` sweep; returns early when the tail answers failure)
  - packages/db-core/src/transactor/transactor-source.ts (`transact`: cancels the pend on a failed commit)
  - packages/db-core/src/testing/test-transactor.ts (`CommitLandsButReportsStale` — lands the WHOLE action, which is not what the network transactor does; `getStatus`)
  - packages/db-core/test/collection-own-action-replay.spec.ts, packages/db-core/test/coordinator-own-action-replay.spec.ts (existing own-entry specs built on that double)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`refuseCommitNotDurable`, and the NOTE at ~2539 promising a same-action retry "converges either way")
  - packages/db-p2p/src/storage/storage-repo.ts (`isOwnRevision` carve-outs in `pend` ~657 and `commit` ~850)
difficulty: hard
repro: verified
----

# What happens

A write to a collection touches several blocks: the collection's **log tail** (the block that records "action X at revision N changed these blocks") and the **data blocks** (tree leaves etc.). `NetworkTransactor.commit` commits the log tail first and only then sweeps the remaining blocks. If the tail commit answers `success: false`, it returns immediately and the sweep never runs.

A failed tail commit does not mean the tail is absent. The coordinator's durability gate (`CoordinatorRepo.refuseCommitNotDurable`) answers `commit-not-durable` (`conflict: true`) whenever fewer than a majority of the cohort report holding the revision, even if some members did store it; its own NOTE says so ("not confirmed durable at a quorum, never guaranteed absent").

Then, in `Collection.syncAttempts`:

1. The attempt fails; `TransactorSource.transact` cancels the pend. The cancel removes the data blocks' pending records everywhere. Nothing ever commits them.
2. After backoff, `updateInternal` refreshes, finds a log entry with this sync's own action id (`inFlightActionId`), and `consumeOwnEntry` drops the pending actions and resets the tracker, on the assumption that a visible own entry means the action is durable.
3. `hasUnsyncedChanges()` is now false, so the sync returns success.

Result: the writer is told the write succeeded. The collection's revision advances to the entry's revision. The log records the action. Every data block still holds the previous revision, on every node. The row is permanently missing, and readers get no error.

`TransactionCoordinator`'s multi-collection retry consumes own entries the same way (see its NOTE near line 1044), so session-mode commits almost certainly have the same hole. That is unverified; confirm it with the same kind of test.

# How it was found and confirmed

Downstream symptom (sereus, `strand-chat-participants-converge.integration.ts`, test "a joiner that writes IMMEDIATELY after addStrand resolves…"): a two-machine strand. The joining machine inserts its `Participant` row, the insert returns success, and the next statement's foreign-key check fails with `CHECK constraint failed: _fk_Message_ParticipantId`. Rerun on 2026-09-16 against HEAD `17440946`, with the warm-restart fix landed and everything rebuilt: **4 passed, 5 failed on the foreign-key check, and 1 failed on the 30 s convergence timeout, out of 10 runs.** The timeout is the same loss seen from the other side: the lost row never replicates because it was never written.

Trace, from a failing run with temporary logging in the plugin's point lookup (since removed):

- Joiner action `_w3dxg…`, rev 2, touches log tail `pbbo…` and leaf `vE9Fb…`.
- Both nodes pend both blocks. The joiner coordinates, and its own member refuses the tail: `commit:missing-base … local latest none is not the declared base 1 of rev 2` (the joiner never stored the log tail locally). The host lands the tail. `commit-not-durable { durableHolders: 1, cohortSize: 2 }`. The transactor cancels.
- No `block-storage commit` for `vE9Fb…` under that action exists on either node. Its pendings are cancelled.
- The joiner's Participant tree then reports `rev=2 action=_w3dxg… unsynced=false`. The point lookup for `'joiner'` finds 0 rows. A **freshly opened** tree at rev 2 also finds only `["host","Host","member"]`. Raw gets show the log tail at rev 2 (action `_w3dxg…`) and the leaf at rev 1.

Why it is intermittent in that scenario: the joiner's local member refuses the tail only when the joiner has never stored the log tail block. Its reconcile pulls from the host, and the host may not have applied yet (see `backlog/bug-a-two-member-cohort-refuses-a-commit-both-members-hold`). The durability loss itself is deterministic once a tail commit lands but answers failure.

In-repo deterministic repro (db-core, no network). This was run and failed as shown, then deleted. Add it as the regression spec:

```ts
import { expect } from 'chai'
import { Tree } from '../src/collections/tree/index.js'
import { TestTransactor, DelegatingTransactor } from '../src/testing/test-transactor.js'
import type { CommitRequest, CommitResult } from '../src/index.js'

// Models NetworkTransactor.commit when the TAIL lands but the durability gate answers
// commit-not-durable: the tail is durable, the sweep of the remaining blocks never runs.
class TailLandsButReportsNotDurable extends DelegatingTransactor {
	injections = 1
	constructor(inner: TestTransactor) { super(inner) }
	override async commit(request: CommitRequest): Promise<CommitResult> {
		if (this.injections > 0 && request.blockIds.length > 1) {
			this.injections--
			const tail = await this.inner.commit({ ...request, blockIds: [request.tailId] })
			if (!tail.success) return tail
			return { success: false, conflict: true, reason: 'commit-not-durable: injected' }
		}
		return this.inner.commit(request)
	}
}

interface Row { key: string; value: string }

it('an acknowledged write is readable afterwards', async () => {
	const inner = new TestTransactor()
	const host = await Tree.createOrOpen<string, Row>(inner, 'participants', r => r.key)
	await host.replace([['host', { key: 'host', value: 'Host' }]])

	const wrapped = new TailLandsButReportsNotDurable(inner)
	const joiner = await Tree.createOrOpen<string, Row>(wrapped, 'participants', r => r.key)
	await joiner.update()
	await joiner.replace([['joiner', { key: 'joiner', value: 'Joiner' }]])   // resolves: "saved"
	expect(wrapped.injections).to.equal(0)

	await joiner.update()
	expect(await joiner.get('joiner')).to.deep.equal({ key: 'joiner', value: 'Joiner' })
	const fresh = await Tree.createOrOpen<string, Row>(inner, 'participants', r => r.key)
	expect(await fresh.get('joiner')).to.deep.equal({ key: 'joiner', value: 'Joiner' })
})
// Observed at HEAD: replace resolves, joiner.committedRevision() === 2, both gets return undefined.
```

Run it alone with `node --import ./register.mjs node_modules/mocha/bin/mocha.js test/<file>.spec.ts` from `packages/db-core`.

# Why the existing tests missed it

`CommitLandsButReportsStale` (test-transactor.ts) delegates the **whole** commit to the inner transactor and then reports failure, so every block lands. Its own doc says it models `NetworkTransactor.commit`'s torn action, where the tail is committed before the sweep. But in that torn shape the blocks after the tail did **not** land. The double makes "own entry visible" and "action fully durable" the same thing, which is the exact assumption `consumeOwnEntry` makes. Both own-entry specs therefore pass over the hole.

# The contract to enforce

A sync or transaction commit may report success only if **every block the action's log entry names holds that action's revision.** Finding the action's own log entry proves only that the tail landed.

# Recommended fix

Keep the consume, but make it finish the action instead of assuming it is finished:

- When the refresh after a failed attempt finds this sync's own entry, do not drop `pending` / reset the tracker yet. Keep the failed attempt's `transforms`, `rev` and `tailId` (all are in scope in `syncAttempts`).
- Find which of the entry's blocks lack the commit. `ITransactor.getStatus([{ actionId, blockIds }])` exists on both `NetworkTransactor` and `TestTransactor`. Alternatively, re-drive the whole action: the storage layer already accepts a retry of the same action at the same revision (`isOwnRevision` carve-outs in `StorageRepo.pend` and `commit`, plus the member and coordinator pend checks).
- Re-pend and commit the missing blocks at the **same** `actionId` and `rev`, with the transforms retained from the attempt. Do not use `getNextRev()`: the refresh has already advanced the context past it. Only after that succeeds, consume the entry and report the merged durability.
- If a missing block's revision is now held by a **different** action, the write cannot be completed. Throw a named, non-retryable torn-action error that names the collection, action, revision and blocks. Never report success, and never re-drive under a new revision (that would record the entry twice).
- Apply the same rule to `TransactionCoordinator`'s retry loop (the consume described near coordinator.ts:1044), or route both paths through one helper.
- Fix the test double: make `CommitLandsButReportsStale` model tail-first landing (only `tailId` lands before the failure), or add a tail-only sibling and move both own-entry specs to it. Keep one case where every block really did land, so the consume path stays covered.

An alternative is to never let the network transactor return a bare failure after its tail may have landed, and have it run the sweep anyway. It was rejected as the primary fix: the transactor cannot tell "tail absent" from "tail present on a minority", and the sweep would then commit data blocks under a tail that may never reach a majority. The collection-level check works from what storage actually holds.

Do not add sleeps or retries in sereus. Do not serve stale local data (see `backlog/more-design/a-live-read-on-an-isolated-node-fails-instead-of-serving-what-it-holds`).

# TODO

- Add the repro above as a db-core spec (e.g. `test/own-entry-completes-the-action.spec.ts`); confirm it fails at HEAD.
- Add the same shape for `TransactionCoordinator` (session mode, one and two collections); confirm whether it fails at HEAD.
- Make `CommitLandsButReportsStale` (or a new sibling) model tail-first landing; update `collection-own-action-replay.spec.ts` and `coordinator-own-action-replay.spec.ts`; keep a whole-action-landed case.
- Implement the completion rule in `Collection.syncAttempts` / `updateInternal` (retain attempt transforms, rev, tail; complete missing blocks at the same revision; named torn-action error on a rival).
- Apply it to the `TransactionCoordinator` retry path.
- Update the NOTE comments that promise convergence (network-transactor.ts ~754–774, coordinator-repo.ts ~2539–2548, collection.ts `consumeOwnEntry`) to state the new rule.
- If the new error type is exported, document it where sync errors are documented (`docs/` — grep `SyncRetryExhaustedError`).
- `yarn lint`, `yarn build`, `yarn workspace @optimystic/db-core test`, `yarn workspace @optimystic/db-p2p test`, `yarn workspace @optimystic/quereus-plugin-optimystic test`.
- Downstream confirmation (not agent-owned, ~30–60 s per run): with optimystic rebuilt (`yarn build`), from `../sereus/packages/integration-tests` run `npx vitest run --reporter=verbose src/scenarios/strand-chat-participants-converge.integration.ts -t "IMMEDIATELY"` at least 10 times; expect no `_fk_Message_ParticipantId` failure. Tell sereus so it can unblock `tickets/blocked/device-shape-join-write-blocked-on-optimystic-read-after-write.md`.
