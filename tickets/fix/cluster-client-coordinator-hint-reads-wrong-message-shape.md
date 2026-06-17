description: A peer-to-peer routing optimization that's supposed to remember which group handled a write never actually records anything, because it looks for the write details in the wrong place on the message — so the optimization silently does nothing for cluster updates.
prereq:
files:
  - packages/db-p2p/src/cluster/client.ts (recordCoordinatorForRecordIfSupported — lines ~53-66)
  - packages/db-core/src/network/repo-protocol.ts (RepoMessage = { operations: [...] } — the real shape)
  - packages/db-core/src/cluster/structs.ts (ClusterRecord.message: RepoMessage — line 20)
  - packages/db-core/src/transform/helpers.ts (blockIdsForTransforms — the canonical block-id derivation)
  - packages/db-p2p/src/repo/client.ts (extractKeyFromOperations — the sibling that reads the shape correctly, for reference)
difficulty: medium
----

# `ClusterClient` coordinator-affinity hint reads `message.pend` / `message.commit` that never exist

## Root cause

`ClusterClient.recordCoordinatorForRecordIfSupported` (`packages/db-p2p/src/cluster/client.ts:53-66`)
is meant to cache "peer X is the coordinator for key K" after a redirect hop, so later requests for K
can be sent straight to X. It derives the key like this:

```ts
const rmsg: any = (record as any)?.message
let tailId: string | undefined
if (rmsg?.commit?.tailId) tailId = rmsg.commit.tailId
else if (rmsg?.pend?.transforms) {
  const keys = Object.keys(rmsg.pend.transforms)
  if (keys.length > 0) tailId = keys[0]
}
if (tailId) { /* ...recordCoordinator(utf8(tailId), peerId)... */ }
```

But `record.message` is a `RepoMessage` (`packages/db-core/src/cluster/structs.ts:20`), whose shape is
`{ operations: [ { get } | { pend } | { cancel } | { commit } ], ... }`
(`packages/db-core/src/network/repo-protocol.ts:3`). There is **no top-level `.pend` or `.commit`** —
those live at `message.operations[0].pend` / `message.operations[0].commit`. Because `rmsg` is cast to
`any`, the compiler never flags it, so both branches read `undefined`, `tailId` stays `undefined`, and
`recordCoordinator` is **never called**. The entire coordinator-affinity hint for cluster updates is
dead code.

This was surfaced while reviewing `pend-redirect-key-uses-structural-field-not-block-id` (the sibling
`RepoService.deriveBlockKey` / `RepoClient.extractKeyFromOperations` fixes). `extractKeyFromOperations`
in `repo/client.ts` reads the shape correctly (`ops[0].pend`) — this one does not.

## Two defects, one fix

1. **Wrong message shape** (the live bug): read `record.message.operations[0]`, not `record.message`,
   and switch over its op variants the same way `extractKeyFromOperations` / `RepoService.deriveBlockKey`
   do. Until this is fixed the hint records nothing.

2. **Structural-field-name pend key** (latent behind #1): once the shape is corrected, the pend branch
   must derive the key from `blockIdsForTransforms(operation.pend.transforms)[0]` — a real block id —
   **not** `Object.keys(transforms)[0]`, which yields the structural field name `'inserts'`/`'updates'`/
   `'deletes'`. This is the identical bug just fixed in `RepoService.deriveBlockKey` and
   `RepoClient.extractKeyFromOperations`.

The commit branch currently keys on `commit.tailId`; note `RepoService.deriveBlockKey` and
`RepoClient.extractKeyFromOperations` key commit on `blockIds[0]` (per the earlier
`commit-redirect-key-anchors-on-wrong-block` fix). Decide whether this hint should match that
(`blockIds[0]`) for cache coherence with the other coordinator-key derivations, or whether tailId is
intentional here — and document the choice.

## Open question for the implementer

Confirm the **key encoding** is coherent end-to-end. `extractKeyFromOperations` and this function use
`TextEncoder().encode(id)` (raw utf8 of the block id), whereas `network-transactor.ts`
records/looks-up coordinators via `blockIdToBytes(blockId)` = `sha256(utf8(id))`
(`packages/db-core/src/transactor/network-transactor.ts:372,379`). A hint recorded under `utf8(id)`
will never be found by a lookup keyed on `sha256(utf8(id))`. This raw-utf8 convention is documented as
intentional in `reactivity-membership-gate.ts:29-44`, but verify the coordinator-hint writers and the
`getCoordinator`/`getCluster` readers actually agree on one encoding — otherwise fixing the shape still
leaves the hint non-functional. This encoding question spans get/cancel/commit too, not just pend.

## Acceptance

- `recordCoordinatorForRecordIfSupported` reads `record.message.operations[0]` and records a coordinator
  hint for at least the pend and commit cases.
- Pend key is `blockIdsForTransforms(...)[0]`; commit key choice (blockIds[0] vs tailId) is decided and
  documented.
- Encoding coherence between hint-write and coordinator-lookup is confirmed (or a follow-up filed if it
  turns out to be a broader mismatch).
- Add a unit test that feeds a real `ClusterRecord` (pend + commit) and asserts `recordCoordinator` is
  invoked with the expected key bytes. Today no test covers this path — its deadness went unnoticed.
