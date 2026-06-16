description: A peer deciding whether to forward an incoming write to a different group sometimes checks the wrong piece of data, so writes that touch several blocks could get bounced to a group that can't handle them. Only shows up on large networks; small test networks hide it.
prereq:
files:
  - packages/db-p2p/src/repo/service.ts (checkRedirect call for the commit op — line ~210-217)
  - packages/db-p2p/src/repo/coordinator-repo.ts (commit anchors consensus on blockIds[0], not tailId — line ~402-419)
  - packages/db-core/src/transactor/network-transactor.ts (per-block commit routing via findCoordinator — commit/commitBlock/commitBlocks ~455-525)
difficulty: medium
----

# Commit redirect key anchors on the collection tail, not the block(s) being committed

## Background — surfaced by the reactivity tail seam (13.5)

`RepoService.handleIncomingStream` runs a responsibility-driven **redirect** check before handling each
op. For every op it derives a `blockKey` and asks `checkRedirect(blockKey, …)`: if this peer is not a
member of `H(blockKey)`'s cluster (and the mesh isn't "small"), it redirects the caller to that cluster.
The key is op-specific:

- `get`    → `operation.get.blockIds[0]`
- `pend`   → `Object.keys(operation.pend.transforms)[0]`
- `cancel` → `operation.cancel.actionRef.blockIds[0]`
- **`commit` → `operation.commit.tailId`**  ← the odd one out

`CoordinatorRepo.commit` — the handler the redirect protects — anchors its consensus on
`blockIds[0]` (`getClusterSize(blockIds[0])`, `executeClusterTransaction(blockIds[0], …)`) and guards
with `verifyResponsibility(blockIds)` (every block in the request). So the **consensus anchor and the
responsibility guard are keyed on `blockIds`, but the redirect is keyed on `tailId`** — a different
block for any per-block commit batch that isn't the tail.

`NetworkTransactor.commit` splits one collection commit into per-block batches routed by
`findCoordinator(blockId)` (header batch, tail batch, remaining-blocks batch — each potentially a
different coordinator/cluster). It now threads the collection's `tailId` into **every** per-block
commit (the 13.5 seam — needed so the committing node can stamp `CollectionChangeEvent.tailId`). For the
**tail** batch `blockIds[0] === tailId`, so redirect-on-tailId is correct. For the **header** and
**remaining-blocks** batches, `blockIds[0] !== tailId`: the receiving peer (the coordinator for *those*
blocks) gets redirect-checked against the **collection tail's** cluster. If it isn't in the tail's
cluster and the mesh isn't small, it will redirect the commit to the tail's cluster — which then fails
`verifyResponsibility(blockIds)` because that cluster isn't responsible for the non-tail block.

## Why it was dormant before, and why it matters now

Before the 13.5 seam, `NetworkTransactor` per-block commits carried **no** `tailId`, so on the wire
`operation.commit.tailId` was `undefined`. `new TextEncoder().encode(undefined)` encodes the empty
string, so `blockKey` was the constant `H("")` for *every* commit — a meaningless, non-block key. The
commit redirect was effectively inert/garbage (and would have mis-redirected in a large mesh just the
same). The seam makes `tailId` a real block id on the wire, so the path is now **active** and keyed on
the collection tail.

This is **latent**: every current test runs in a "small mesh" (`cluster.length < responsibilityK`), where
`checkRedirect` returns `null` regardless of key, so neither the old garbage key nor the new tail key
ever redirects. It will only manifest on a large, multi-cluster mesh where a collection's blocks span
clusters. It is therefore **not a regression of currently-exercised behavior** — but it is a real
correctness bug in the redirect routing for distributed collections, newly reachable.

## Expected behavior

The commit redirect should be keyed on the **same block the commit handler actually coordinates and
verifies** — i.e. `operation.commit.blockIds[0]` — consistent with `get`/`pend`/`cancel` and with
`CoordinatorRepo.commit`'s `blockIds[0]` consensus anchor. A peer should be asked to forward a commit
only when it is not responsible for the blocks *in that request*, not for some other (tail) block.

## Candidate fix (validate, don't assume)

`packages/db-p2p/src/repo/service.ts`, the `'commit' in operation` branch:

```ts
const blockKey = operation.commit.blockIds[0]!   // was: operation.commit.tailId
```

This is a one-line change but it alters consensus-adjacent routing, so it must be validated against a
**multi-cluster** scenario, not just the existing small-mesh suites:

- Confirm a multi-block, multi-cluster collection commit routes each per-block batch to the right
  cluster without spurious redirects, and that the tail batch is unaffected (`blockIds[0] === tailId`
  there).
- Add a redirect test that exercises `!smallMesh && !isMember` for a commit op (the current suite never
  does), asserting redirect targets the cluster of the block(s) in the request.
- Double-check nothing else relies on the commit redirect keying on `tailId` specifically (search uses of
  `checkRedirect`/`blockKey` for commits).

If investigation shows the tail-keying was deliberate (e.g. an intent to co-locate a collection's commit
in the tail's cluster), then the real bug is instead in `NetworkTransactor` routing non-tail blocks to
independent coordinators — resolve the inconsistency in whichever direction the consensus design
actually intends, and document it.
