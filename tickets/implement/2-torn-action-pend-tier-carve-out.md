description: When a machine's write half-succeeds and it retries, the storage layer mistakes the machine's own already-saved work for a competitor's and refuses it forever; teach the three pend-tier checks to recognize their own action.
files:
  - packages/db-p2p/src/storage/storage-repo.ts:505-548 (StorageRepo.pend — the bare `latest.rev >= request.rev` rule; the site that actually refuses)
  - packages/db-p2p/src/storage/storage-repo.ts:659-700 (StorageRepo.commit — the `alreadyDone` partition at lines 672-699; the already-correct commit-tier sibling to copy)
  - packages/db-p2p/src/cluster/cluster-repo.ts:1235-1323 (ClusterMember.validatePendOperations — stale vote at 1246-1281; self-exclusion wording to mirror at 1294)
  - packages/db-p2p/src/repo/coordinator-repo.ts:1457-1501 (CoordinatorRepo.classifyStaleRejection — per-block exclusion in the highestStaleAt map)
  - packages/db-p2p/test/cluster-commit-staleness.spec.ts (harness to copy for the new vote spec)
  - packages/db-p2p/test/storage-repo.spec.ts (pend arm goes after the existing pend describe, ~line 293)
difficulty: medium
repro: verified
----

# Torn action, part 1 of 3: pend-tier own-action carve-out (db-p2p)

Split from `torn-action-must-recognize-its-own-durable-work` after a budget stop; parts 2 and 3
are `torn-action-own-entry-consumption` (db-core) and `torn-action-cleanup-and-mesh-validation`.
This part is self-contained and independently landable.

## Root cause (verified)

A write transaction touches several blocks, committed one group at a time — so it can end up
with SOME blocks durably committed and the rest refused (a **torn action**). Its retry reuses the
SAME actionId (`Collection.syncInternal` mints the id once, outside its retry loop —
`packages/db-core/src/collection/collection.ts:782-783`). Every commit-tier check already asks
"who holds the revision I want?" and treats "me" as an idempotent no-op
(`StorageRepo.commit`'s `alreadyDone` partition, `ClusterMember.validateCommitRevisions`,
`CoordinatorRepo.confirmCommitRivalAgainstLocal`). The pend tier never asks — it compares
revision numbers only — so a torn action's re-pend is refused by its own already-committed half,
forever (10 retries, `SyncRetryExhaustedError`, zero entries land).

Deterministic vote-tier repro was run and recorded on the source ticket: a pend
`{ actionId: A, rev: 1 }` against a member holding `latest = { rev: 1, actionId: A }` votes
reject with `stale revision: block own-orphan-block at rev 1, requested rev 1` — byte-identical
to the rival verdict.

## Design (settled — do not relitigate)

**Only `latest.rev === request.rev` is carved out.** Never `latest.rev > request.rev` (the
follow-on commit would take `StorageRepo.commit`'s `missedCommits` branch and refuse anyway —
approving such a pend only defers the refusal one round trip), and never reach for
`IRevisionActionReader` at the pend tier. `latest.actionId` off the same read already answers
the `===` case.

**`StorageRepo.pend`: an own-action-already-committed block is *satisfied*, not merely
non-stale.** In the per-block loop (lines 505-538): read `getLatest()` first (when
`request.rev !== undefined || transforms.insert`, as today); when
`request.rev !== undefined && latest.rev === request.rev && latest.actionId === request.actionId`,
add the block to a `satisfied` set and `continue` — skipping BOTH the stale/`missing`
collection AND the pendings listing for that block. Then filter `satisfied` blocks out of the
`savePendingTransaction` fan-out at lines 581-585. Why the pending must not be recorded:
`StorageRepo.commit`'s `alreadyDone` arm `continue`s past `internalCommit`, the only thing that
promotes (and thereby removes) a pending record — a pending saved for an already-committed block
would never be cleared and would sit as a permanent durable reservation the rival-pending checks
refuse every future writer against (a worse wedge than the one being fixed). The block STILL
belongs in the returned `blockIds` so `cancel` covers it (`deletePendingTransaction` on an
absent record is a no-op). Comment this against the `alreadyDone` partition.

**`ClusterMember.validatePendOperations`**: the stale vote at 1263-1279 currently reads only
`blockResult?.state?.latest?.rev`. Read the whole `latest` (it is an `ActionRev`
`{ actionId, rev }`); when `latest.rev === pendRequest.rev && latest.actionId === pendRequest.actionId`,
`continue` (approve). Word the comment to match the self-exclusion already documented on the
pending-rival check below it ("Self is excluded so a redelivered pend for this same action stays
approvable", line 1294). The rival reject prose is UNCHANGED — it is fed to
`computeSigningPayload` and carried as `Signature.rejectReason`; changing the text changes
signed bytes.

**`CoordinatorRepo.classifyStaleRejection`** (coordinator-repo.ts:1457-1501): in the
`highestStaleAt` map at 1474-1477, a block with
`latest.rev === requestedRev && latest.actionId === request.actionId` maps to `undefined` (not a
confirmed loss). Per-block exclusion — a confirmed rival on ANOTHER block still confirms; when
no rival is confirmed anywhere, the function returns `undefined` and the rejection stays a
throw, exactly as today. (Deliberately NOT the bail-entirely `'own-durable'` shape of
`confirmCommitRivalAgainstLocal` — that is the commit tier's contract.) With the two sites above
fixed this path should be unreachable for the own-action shape; mirror it anyway so all three
pend-tier sites agree.

## What must NOT change

- The rival case: every carve-out gated on actionId equality; rival refusals keep identical
  prose (signed bytes).
- Lagging-member tolerance (`latest.rev < request.rev`, or no latest → approve/abstain).
- The unavailable-block fail-closed reject in `validatePendOperations` (lines 1249-1262).

## Tests (write first, confirm they fail pre-fix)

New spec `packages/db-p2p/test/cluster-pend-staleness.spec.ts` — copy the harness of
`cluster-commit-staleness.spec.ts` verbatim (canonicalJson/makeKeyPair/computeMessageHash/
makeClusterPeers/StateRepo/MockPeerNetwork/voteOn* driving `member.update(record)`, vote read
from `record.promises[self]`; two declared peers keep the record in the Promising phase so only
the promise-round check runs). Deltas — a pend record instead of a commit record:

```ts
const BLOCK = 'own-orphan-block' as BlockId;
const makePendRecord = async (peers: ClusterPeers, pend: PendRequest): Promise<ClusterRecord> => {
	const message: RepoMessage = {
		operations: [{ pend }],
		coordinatingBlockIds: [BLOCK],
		expiration: Date.now() + 30000
	};
	return { messageHash: await computeMessageHash(message), message, peers, promises: {}, commits: {} };
};
const makePend = (over: Partial<PendRequest> = {}): PendRequest => ({
	actionId: OUR_ACTION,
	rev: 1,
	transforms: { inserts: {}, updates: { [BLOCK]: [['entries', 0, 0, ['x']]] }, deletes: [] },
	policy: 'c',
	...over
});
```

(`StateRepo` returns `{ state: { latest } }` with no `pendings`, so the pending-rival check
abstains and only the stale vote is exercised.) Cases:

- `latest = { rev: 1, actionId: OUR }`, pend `{ OUR, rev: 1 }` → **approve** (fails pre-fix)
- `latest = { rev: 1, actionId: RIVAL }`, pend `{ OUR, rev: 1 }` → reject, reason exactly
  `stale revision: block own-orphan-block at rev 1, requested rev 1`
- `latest = { rev: 2, actionId: OUR }`, pend `{ OUR, rev: 1 }` → reject (no carve-out past ===),
  reason `stale revision: block own-orphan-block at rev 2, requested rev 1`
- `latest = { rev: 1, actionId: RIVAL }`, pend `rev: 2` → approve (lagging tolerance)
- no latest → approve

`storage-repo.spec.ts` arm (insert after the pend describe, ~line 293; reuse
`makeInsertTransforms`, and the `BlockStorage`+`rawStorage` pattern from the rev-conflict test at
lines 142-166 to inspect pendings):
- pend block B `{ actionId: 'a1', rev: 1 }` (insert), commit `{ actionId: 'a1', blockIds: [B],
  tailId: B, rev: 1 }`, then RE-pend the same `{ actionId: 'a1', rev: 1 }` insert → must succeed,
  `blockIds` must still list B, and `new BlockStorage(B, rawStorage).listPendingTransactions()`
  must yield NOTHING (no permanent reservation).
- same setup, re-pend as `{ actionId: 'rival', rev: 1 }` → `success: false` with `missing`
  populated (unchanged rival behavior).

## Validation

`yarn workspace @optimystic/db-p2p test`; then `yarn build` and `yarn typecheck` from the root.
End-to-end (reference-peer diary) validation is owned by `torn-action-cleanup-and-mesh-validation`.

## Notes

- `tickets/fix/4-debt-pend-validation-is-skipped-instead-of-failing-closed` edits a different arm
  of `validatePendOperations`; whoever lands second gets a textual conflict, otherwise independent.
- `tickets/backlog/feat-sync-fail-fast-on-hopeless-revision` is adjacent but opposite in
  direction; do not implement it here.
- A draft of the vote spec existed and was removed at the budget stop (it would have sat red in
  the tree); the snippet above is distilled from it and matched the harness conventions.
