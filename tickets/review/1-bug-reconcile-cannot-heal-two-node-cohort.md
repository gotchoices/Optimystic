----
description: When a node was missing a piece of data, its repair step insisted that two different peers hand over the same copy before it would trust it — so in a two-machine setup, where only one other machine exists, the repair always refused and the node stayed empty. It now asks for only as many copies as the group can actually supply.
files: packages/db-p2p/src/cluster/reconcile-block.ts (new), packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/reconcile-block.spec.ts (new), packages/db-p2p/test/quorum-restore.spec.ts, docs/internals.md, docs/transactions.md
----

# Review: reconcile must be able to heal a two-node cohort

Continuation of `bug-member-commits-unmaterializable-revision` (`d6a22d2`), which routes a
refused `missing-base-revision` commit into `ClusterMember.reconcileDivergentCommit` so the node
pulls what it is missing. This ticket asked whether that pull can actually succeed at two nodes.

## What was reproduced

The premise held, and the reproduction found **more** than the ticket predicted. The commit-path
reconcile has two sequential quorum gates, and *both* were on the strict floor of two:

1. `selectQuorumRev(revClaims, threshold)` — called with **no** `corroboratorCapacity` at all.
   `50af693` added that parameter and threaded it through the read-repair caller
   (`CoordinatorRepo.queryClusterForLatest`) but not through the reconcile caller, so the
   revision gate declined first, before the content gate was ever reached.
2. `selectQuorumBlock(hashCandidates, threshold)` — the gate the ticket named. Verified to be a
   real second blocker: with gate 1 relaxed in isolation, a two-node heal still declined here.

Both are now capped by `corroboratorCapacity = max(cohort peers excluding self, clusterSize − 1)`,
the same shape `50af693` used, computed in one place (`reconcile-block.ts`) and passed to both.

## The hash-verification question — the ticket's premise was WRONG

The ticket asked the implementer to confirm, before relying on it, that "a content block is
content-addressed, so a peer supplying block bytes for a given block id cannot substitute
different content without the id changing." **It is not.**

- `packages/db-core/src/blocks/structs.ts:1` — `export type BlockId = string; // base64url encoded (256-bit random)`
- `packages/db-core/src/transactor/transactor-source.ts:33-36` — `generateId()` returns
  `randomBytes(32)` base64url. Ids are minted randomly at block creation; they are unrelated to
  content, and must be, since a block's content changes across revisions while its id does not.
- Receive path: `libp2p-node-base.fetchArchiveFromPeer` → `SyncClient.requestBlock` →
  `response.archive`, returned unexamined. Nothing between the socket and
  `StorageRepo.saveReplicatedBlock` (`storage-repo.ts:637`) compares anything to `blockId`.
- `canonicalBlockHash` (`quorum-restore.ts`) hashes the block, but only to group peers by
  agreement; its output is never compared to the requested id.

So the asymmetry the ticket hoped for does not exist, and the ticket's edge case "peer supplies
content whose hash does not match the requested id: must reject" is **not implementable as
written** — there is no id-derived hash to check against. It is not in the test suite for that
reason, and the closest reachable behaviours are covered instead (a content liar in a cohort
large enough to outvote it; an even split declining rather than picking a side).

**The relaxation is still right, for a different reason than the ticket gave.** At capacity 1 the
sole peer's *content* is believed on its word — but that same peer's `(rev, actionId)` claim is
already believed on its word at that size, deliberately, per `50af693`'s documented exposure. A
two-member cohort has no honest majority to appeal to, so the content gate was buying nothing
there while costing permanent unavailability. The `max(observed, clusterSize − 1)` form is what
keeps this confined to cohorts that are *genuinely* two-node: a shrunken view of a larger cohort
still faces the floor of two, which is pinned by a spec.

## What changed

- **New `packages/db-p2p/src/cluster/reconcile-block.ts`.** The reconcile logic was a ~60-line
  closure inline in `createLibp2pNode`, which is why it had no unit coverage and why the missing
  capacity argument went unnoticed. Extracted to `createReconcileBlock(deps)` with
  `fetchArchive` / `saveReplicatedBlock` / `reputation` injected; `libp2p-node-base` now wires the
  same `fetchArchiveFromPeer` into it. Decomposed into `toCandidate`, `hashCarriers`,
  `penalizeContradictingContent`, `corroboratorCapacity`.
- **`selectQuorumBlock` takes an optional `corroboratorCapacity`**, mirroring `selectQuorumRev`.
- **`selectQuorumBlock` now counts one vote per distinct peer** per hash group (it counted raw
  candidates, so a peer appearing twice could have seconded itself). Not reachable today —
  `cohortPeerIds` comes from `Object.keys(record.peers)` — but it now matches `selectQuorumRev`'s
  stated semantics instead of relying on the caller.
- **Decline logging.** `reconcile:no-rev-quorum` / `reconcile:no-content-quorum` /
  `reconcile:restored`. Previously every outcome was silent, and `cluster-repo` logs
  `cluster-member:consensus-commit-reconciled` regardless of whether anything was restored (see
  *Known gaps*).
- **`quorum-restore.ts` had a literal NUL byte** in the group-key template
  (`` `${c.rev}\0${c.actionId}` `` written as a raw control character), which made git classify
  the file as **binary** — `git diff` and `git blame` were unusable on it across `50af693` and
  `d6a22d2`. Replaced with the `\0` escape; identical runtime value.
- Docs: `docs/internals.md` (behind-member reconcile bullet) and `docs/transactions.md`
  (§ *What a repair pass will and will not accept*) state the two-gate cap, the `clusterSize: 2`
  operator requirement for two-node deployments, and that the content check compares peers to
  each other and never to the requested id.

## Testing

`packages/db-p2p/test/reconcile-block.spec.ts` (new, 11 specs) drives the real callback:

- heals a two-node cohort from its sole peer (**the reproduction** — failed before the fix,
  `expected 1, actual 0` saves);
- adopts a peer revision ahead of the committed one;
- *still* declines the same single observed peer when `clusterSize: 10` (shrunken-view guard);
- single-node cohort makes no fetch and does not throw (`[]` and `[self]` both);
- no peer holds the block → declines, persists nothing, and re-queries on the next attempt
  (nothing cached or marked, so retries are neither suppressed nor hot);
- peer behind the committed rev → declines rather than regressing;
- peer corroborates the rev but carries no block bytes → declines;
- content liar outvoted in a larger cohort, honest content persisted, liar penalized;
- even content split declines; inflated revision outvoted; throwing reputation sink tolerated.

`packages/db-p2p/test/quorum-restore.spec.ts` gains 3 specs for the new `selectQuorumBlock`
parameter: lone block accepted at capacity 1, refused at capacity 4; the proportional term still
governs a 6-carrier split at capacity 1; a repeated peer cannot second itself.

**Results.** `packages/db-p2p`: **1359 passing, 41 pending, 0 failing** (baseline was 1345/41/0;
+14 new). Root `yarn lint` exit 0. Root `yarn build` clean.

## Known gaps — read before signing off

- **The downstream acceptance signal was NOT obtained.** The real check is
  `control-db-two-node-convergence` in the sibling `sereus` repo. It aborted before running:
  `Stale build detected … @serfab/cadre-core: dist is stale`. Another agent was editing that repo
  concurrently, and rebuilding it was out of bounds. **Convergence at two nodes is therefore
  demonstrated only at the unit level.** Re-run it once `sereus` is buildable:
  `cd packages/integration-tests && npx vitest run src/scenarios/control-db-two-node-convergence.integration.ts`
  (after `yarn build` at the optimystic root). If it still fails, this ticket's mechanism was
  necessary but not sufficient and the next failure is somewhere else again — that has now been
  true of three consecutive fixes to this path, so do not assume.
- **`cluster-member:consensus-commit-reconciled` is still logged unconditionally**, on every
  reconcile that did not throw, whether or not anything was restored
  (`cluster-repo.ts` `reconcileOneBlock`). This is the same false-positive shape `d6a22d2`
  removed from `cluster-fetch:synced` — anyone reading a trace for evidence of healing will be
  misled by it. Left alone here to keep the diff on the quorum defect; worth a follow-up, and the
  new `reconcile:restored` line is the trustworthy one in the meantime.
- **`mesh-harness.ts` still has its own hand-rolled reconcile analogue** (no quorum at all, first
  peer wins). It is a test double, so it does not exercise the code that just changed — a spec
  passing through the harness proves nothing about these gates.
- The exposure at capacity 1 (sole peer believed for both rev and content) remains open by
  design; commit-cert verification is tracked in backlog
  `debt-read-repair-commit-cert-verification`.
