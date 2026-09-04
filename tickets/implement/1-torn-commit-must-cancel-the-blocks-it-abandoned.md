description: When a write spans several blocks and only some of them get stored, the system tells the writer the whole write succeeded and then leaves a permanent "write in progress" marker on the blocks that were skipped. Those blocks refuse every later write from every machine, forever. Fix the one place that reports success while walking away from that leftover state.
files: packages/db-core/src/transactor/network-transactor.ts, packages/db-core/src/transactor/transactor-source.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/test/concurrent-diary-append-acknowledgement.spec.ts
difficulty: hard
repro: verified
----

# A tolerated non-tail sweep failure reports success and strands the pends it abandoned

## The invariant to establish

> When `NetworkTransactor.commit` returns, every block in `request.blockIds` is either **committed**
> or has had its pending record **cancelled**. No block is left holding a pending record that no
> future call will ever promote or remove.

That invariant is violated today on exactly one path, and the violation is permanent.

## Root cause — one site

`NetworkTransactor.commit` (`packages/db-core/src/transactor/network-transactor.ts`) commits in two
stages. The tail block is committed first, on its own, through `commitBlock`. Every other block of
the action is then committed by a **second** call to `commitBlocks` — the "sweep". A sweep failure
is split by shape:

- a **returned** `success: false` from a cohort coordinator is a confirmed conflict, so
  `staleFromBatches` returns it, `commit` reports the failure, and `TransactorSource.transact`
  cancels every block of the action. Correct, and not the bug.
- a **transport-shaped** failure (a throw, no returned refusal) is *tolerated*: `commit` logs
  `WARN: non-tail commit had errors; proceeding after tail commit` and returns `{ success: true }`.

The tolerance rests on a premise stated in the comment right there — "the commit consensus for these
blocks exists, so lagging peers converge via reconciliation paths". **That premise is not implied by
the failure shape.** A throw out of the sweep also covers the case where the sweep's cluster
transaction reached *nobody*: no consensus record exists, no reconciliation will ever run, and every
cohort member is still holding the pending record its pend wrote for those blocks.

Because `commit` reported success, `TransactorSource.transact` never reaches its cancel. And the
pending record is removed by exactly three things, none of which can fire here:

| remover | why it cannot fire |
| --- | --- |
| `StorageRepo.cancel` | only a client sends it, and the client was told it succeeded |
| `StorageRepo.dropUnpromotablePendings` | only on a divergence-shaped commit refusal, which never happened |
| `BlockStorage.saveForwardRevision`'s same-action delete | only on a forward write carrying that same action id |

There is no age bound and no sweep. The record is permanent.

From then on `ClusterMember.validatePendOperations` votes **reject** — a real, signed rejection, not
the `conflict` vote kind — on every later pend touching the block, from any writer on any machine.
A three-member cohort therefore answers `2/3 rejected` for writes that are in no race at all.

## Reproduction (verified, deterministic, in-process)

Two arms, both on the existing mesh harness. The second one is the production path end to end: the
only thing injected is a failing sweep RPC.

Build `db-core` first (`packages/db-p2p` resolves `@optimystic/db-core` through its `dist`), then run
with the db-p2p test runner.

```ts
import type { BlockHeader, BlockId, IBlock, Transforms, IRepo, PeerId as DbPeerId, CommitRequest, MessageOptions } from '@optimystic/db-core';
import { NetworkTransactor } from '@optimystic/db-core';
import { createMesh } from '../src/testing/mesh-harness.js';

const makeHeader = (id: string): BlockHeader => ({ id: id as BlockId, type: 'test', collectionId: 'wedge-collection' as BlockId });
const makeBlock = (id: string): IBlock => ({ header: makeHeader(id), entries: [] } as unknown as IBlock);
const insertsFor = (...ids: string[]): Transforms => ({ inserts: Object.fromEntries(ids.map(id => [id, makeBlock(id)])), updates: {}, deletes: [] });
const updatesFor = (tag: string, ...ids: string[]): Transforms => ({ inserts: {}, updates: Object.fromEntries(ids.map(id => [id, [['entries', 0, 0, [tag]]]])), deletes: [] });

const mesh = await createMesh(3, { responsibilityK: 3, clusterSize: 3, superMajorityThreshold: 0.67 });

// Wrap every node's repo so a commit that does NOT carry the tail — i.e. the sweep — throws.
let dropSweeps = false;
const repoByPeer = new Map<string, IRepo>();
for (const node of mesh.nodes) {
  const inner = node.coordinatorRepo as unknown as IRepo;
  repoByPeer.set(node.peerId.toString(), {
    get: g => inner.get(g),
    pend: (r, o) => inner.pend(r, o),
    cancel: (r, o) => inner.cancel(r, o),
    commit: (r: CommitRequest, o?: MessageOptions) =>
      dropSweeps && !r.blockIds.includes(r.tailId)
        ? Promise.reject(new Error('injected: sweep RPC failed'))
        : inner.commit(r, o)
  } as IRepo);
}
const transactor = new NetworkTransactor({
  timeoutMs: 5_000, abortOrCancelTimeoutMs: 5_000, keyNetwork: mesh.keyNetwork,
  getRepo: (p: DbPeerId) => repoByPeer.get(p.toString())!
});

// rev 1: both blocks exist and are committed.
await transactor.pend({ actionId: 'a1', transforms: insertsFor('T', 'S'), rev: 1, policy: 'c' });
await transactor.commit({ actionId: 'a1', blockIds: ['T', 'S'], tailId: 'T' as BlockId, rev: 1 });

// rev 2: touch both, and let the sweep for S fail.
dropSweeps = true;
await transactor.pend({ actionId: 'a2', transforms: updatesFor('x', 'T', 'S'), rev: 2, policy: 'c' });
await transactor.commit({ actionId: 'a2', blockIds: ['T', 'S'], tailId: 'T' as BlockId, rev: 2 });
dropSweeps = false;
```

Measured output, every run:

```
COMMIT2 {"success":true}
NODE 0 T {"latest":{"actionId":"a2","rev":2},"pendings":[]}  S {"latest":{"actionId":"a1","rev":1},"pendings":["a2"]}
NODE 1 T {"latest":{"actionId":"a2","rev":2},"pendings":[]}  S {"latest":{"actionId":"a1","rev":1},"pendings":["a2"]}
NODE 2 T {"latest":{"actionId":"a2","rev":2},"pendings":[]}  S {"latest":{"actionId":"a1","rev":1},"pendings":["a2"]}
LATER 1 {"success":false,"conflict":true,"reason":"pending conflict: block(s) held by unresolved rival action(s) a2","missing":[]}
LATER 2 {"success":false,"conflict":true,"reason":"pending conflict: block(s) held by unresolved rival action(s) a2","missing":[]}
LATER 3 {"success":false,"conflict":true,"reason":"pending conflict: block(s) held by unresolved rival action(s) a2","missing":[]}
```

The write was acknowledged, `S` never advanced, all three members hold `a2` on `S`, and every later
write to `S` is refused. Nothing in the system will ever change that.

The same wedge is reachable one layer down without the transactor at all — pend both blocks through
consensus, then call the coordinator's `commit` with only the tail in `blockIds` — which is worth
keeping as the mechanism-level arm because it is independent of how the tear was produced.

## Two facts that correct the source ticket's framing

The source ticket asked "why does one member commit both blocks and the others only one?" and
assumed one commit operation was applied unevenly. It is not one operation:

- **A multi-block commit is already two or more cluster transactions by design.** Tail first, then a
  sweep, and the sweep can be split further across coordinators. So per-block commit counts differing
  within one action is the normal shape of a sweep that failed, not evidence of a member applying
  half of an atomic apply. The traced block with three pends and one commit is a sweep that reached
  one member — its coordinator's own local apply, or a consensus whose broadcast landed on one node.
- **The `save`-path tripwire in `packages/db-p2p/src/storage/block-storage.ts` predicted the wrong
  shape and does not apply.** It anticipated orphans "on blocks whose committing action id differs".
  Here the committing action id is the *same* id as the orphan's; the commit for that block simply
  never ran. A sweep keyed on "already committed under another action" would not find this record.
  Neither would a sweep keyed on "the block has passed this pend's revision": the wedged block sits at
  revision 1 while the orphaned pend is for revision 2, so it is still nominally promotable.
  **Only an explicit cancel, or a time bound, can clear it.**

## What to build

The fix is at the tolerated arm in `NetworkTransactor.commit`, and it must not disturb the two
behaviours around it: a confirmed conflict still returns and lets the caller cancel everything, and a
transport-shaped failure still does not report the acknowledged tail as a failure.

**Cancel the blocks the sweep abandoned, before returning success.** `NetworkTransactor.cancel`
already exists and routes per block through consensus. Cancel is safe in both directions and that is
what makes it the right instrument:

- if the sweep's commit actually *did* land on a member (a lost response), that member promoted the
  record already and the cancel is a no-op there;
- if it did not, the cancel is exactly the repair;
- if the sweep's consensus is still in flight and lands *after* the cancel, that member reports a
  missing pend, which `ClusterMember.applyConsensusOperation` already treats as "behind" divergence
  and cures by reconciling the block from a cohort peer.

Cancel only the blocks that did not confirm success — the batch statuses `commitBlocks` returns
already carry that. Do not cancel the tail (it committed) and do not cancel on the confirmed-conflict
path (the caller owns that cancel; double-cancelling is wasted consensus traffic).

Two things to weigh and record whichever way you go:

- **The cancel is itself best-effort over the network.** If it fails, the wedge persists. That is the
  residual, and it is the node-side backstop's job, tracked in
  `debt-unpromotable-pending-records-need-a-sweep` (an arm recording this instance has been appended
  there). Say so at the site rather than implying the cancel closes the hole completely.
- **Representation.** The deeper flaw is that `CommitResult` cannot express "the tail landed, these
  blocks did not", so no caller can be *required* to handle it. Widening the result so a torn commit
  is representable and forced to be handled is the stronger fix and is worth costing before settling
  for the cancel — but the cancel alone establishes the invariant at the top of this ticket, and a
  representation change is only worth it if a caller would actually do something different with the
  information.

## A neighbouring arm that keeps pends on purpose

While reproducing, an unrelated malformed transform made `StorageRepo.commit` fail mid-batch with a
plain reason (not a divergence), which takes the documented "genuine fault" arm and **deliberately
keeps** the batch's pending records so a retry can replay them. That arm is correct as written and is
not part of this fix, but it is a second producer of the same durable state whenever the retry never
comes. It is worth one sentence in whatever comment you leave, so the next reader does not conclude
the cancel here covers every producer.

## Documentation

`docs/repository.md` carries Invariant P (a block never holds a pending record and a committed record
for the same action). The rule this ticket adds is its missing sibling — a pending record's lifetime
is bounded by its writer — and belongs beside it. `StorageRepo.commit`'s doc comment already lists the
pending-record fates for the *member* side; the transactor side now has a stated rule too.

## TODO

- [ ] Land the mechanism-level repro (pend two blocks through consensus, commit only the tail, assert
      every member still holds the sibling's pending record and that later writes to it are refused)
      as a spec in `packages/db-p2p/test/`.
- [ ] Land the end-to-end repro above in the same spec — the injected-sweep-failure arm is the one
      that proves the production path, and it is the arm that must go green with the fix.
- [ ] In `NetworkTransactor.commit`'s tolerated non-tail-sweep arm, cancel the blocks whose batches
      did not confirm success, before returning `{ success: true }`.
- [ ] Keep the confirmed-conflict path unchanged: it must still return the stale failure and leave
      cancellation to `TransactorSource.transact`.
- [ ] Assert the invariant, not the mechanism: after any `NetworkTransactor.commit` return, no block
      of the action holds a pending record for that action on any member unless it committed there.
- [ ] Replace the comment's "the commit consensus for these blocks exists" premise with what is
      actually true of a transport-shaped failure, and name the residual (a failed cancel) plus the
      backlog slug that owns the node-side backstop.
- [ ] Add the pending-record-lifetime rule to `docs/repository.md` next to Invariant P.
- [ ] `yarn build && yarn typecheck && yarn test` at the repo root — db-core must be built before the
      db-p2p specs will pick up a db-core change.
