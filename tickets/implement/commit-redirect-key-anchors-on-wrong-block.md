description: A peer deciding whether to forward an incoming write to a different group checks the wrong block, so multi-block writes can be bounced to a group that can't handle them. Latent today (only large multi-cluster networks hit it); fix the routing key and add a regression test.
prereq:
files:
  - packages/db-p2p/src/repo/service.ts (commit redirect keyed on tailId — line ~210-217; key-derivation wiring in handleIncomingStream)
  - packages/db-p2p/src/repo/coordinator-repo.ts (commit consensus anchors blockIds[0], guards verifyResponsibility(blockIds) — line ~402-419)
  - packages/db-core/src/transactor/network-transactor.ts (per-block commit routing via findCoordinator; tailId threaded into every batch — ~455-525)
  - packages/db-core/src/network/struct.ts (CommitRequest type — blockIds via ActionBlocks + required tailId — line ~67)
  - packages/db-p2p/test/redirect.spec.ts (RepoService redirect tests; commit case passes blockKey explicitly, so it does NOT exercise key-derivation)
difficulty: medium
----

# Commit redirect key anchors on the collection tail, not the block(s) being committed

## Problem (validated against the code)

`RepoService.handleIncomingStream` (`packages/db-p2p/src/repo/service.ts`) runs a responsibility-driven
**redirect** check before handling each op: it derives an op-specific `blockKey`, calls
`checkRedirect(blockKey, …)`, and if this peer is not a member of `H(blockKey)`'s cluster (and the mesh
isn't "small"), it redirects the caller to that cluster. The key derivation per op:

- `get`    → `operation.get.blockIds[0]`
- `pend`   → `Object.keys(operation.pend.transforms)[0]`
- `cancel` → `operation.cancel.actionRef.blockIds[0]`
- **`commit` → `operation.commit.tailId`**  ← the bug (service.ts ~line 211)

The handler the redirect protects — `CoordinatorRepo.commit` (coordinator-repo.ts:402-419) — anchors its
consensus on `blockIds[0]` (`getClusterSize(blockIds[0])`, `executeClusterTransaction(blockIds[0], …)`)
and guards with `verifyResponsibility(blockIds)` (every block in the request). So the **consensus anchor
and responsibility guard are keyed on `blockIds`, but the redirect is keyed on `tailId`** — a different
block for any per-block commit batch that isn't the tail.

`NetworkTransactor.commit` (network-transactor.ts:455-494) splits one collection commit into per-block
batches routed by `findCoordinator(blockId)` (header batch, tail batch, remaining-blocks batch — each
potentially a different coordinator/cluster), and threads the collection's `tailId` into **every** batch
(`commitBlocks` sends `{ actionId, blockIds: batch.payload, rev, tailId }`, network-transactor.ts:512-525).
For the **tail** batch `blockIds[0] === tailId`, so redirect-on-tailId happens to be correct. For the
**header** and **remaining-blocks** batches `blockIds[0] !== tailId`: the receiving peer (coordinator for
*those* blocks) gets redirect-checked against the **collection tail's** cluster. If it isn't in the tail's
cluster and the mesh isn't small, it redirects the commit to the tail's cluster — which then fails
`verifyResponsibility(blockIds)` because that cluster isn't responsible for the non-tail block.

### Why latent

Every current test runs in a "small mesh" (`cluster.length < responsibilityK`), where `checkRedirect`
returns `null` regardless of key, so neither the old garbage key (pre-13.5, `tailId` was `undefined` on
the wire → `H("")` constant) nor the new tail key ever redirects. It only manifests on a large,
multi-cluster mesh where a collection's blocks span clusters. Not a regression of currently-exercised
behavior, but a real correctness bug in redirect routing for distributed collections, newly reachable
since `tailId` became a real block id on the wire (the 13.5 reactivity-tail seam).

## Fix

Key the commit redirect on the **same block the handler coordinates and verifies** — `blockIds[0]` —
consistent with `get`/`pend`/`cancel` and with `CoordinatorRepo.commit`'s `blockIds[0]` consensus anchor.

In `service.ts`, the `'commit' in operation` branch:

```ts
const blockKey = operation.commit.blockIds[0]!   // was: operation.commit.tailId
```

`CommitRequest` (struct.ts:67) carries `blockIds` (via `ActionBlocks`) and required `tailId`, and
`NetworkTransactor` only ever sends non-empty `blockIds` batches, so `blockIds[0]!` is safe (matches the
`get`/`cancel` branches' use of `blockIds[0]!`).

### Validation already done (no need to redo)

- `CoordinatorRepo.commit` anchors consensus + responsibility on `blockIds`, not `tailId`. ✓
- `NetworkTransactor` routes each per-block batch by `findCoordinator(blockId)`; `tailId` is threaded
  purely for the `CollectionChangeEvent` stamp, not for routing. ✓
- `checkRedirect` takes an opaque `blockKey: string`; nothing downstream depends on the commit key being
  `tailId` — the keying decision lives entirely at service.ts ~line 211. ✓ (so the tail-keying was not a
  deliberate co-location intent; it was the inert/garbage-key artifact described above.)

## Test gap to close

The existing commit redirect test (`redirect.spec.ts` ~line 202) calls
`service.checkRedirect('block-1', 'commit', message)` with the key passed **explicitly**, so it never
exercises the key-*derivation* in `handleIncomingStream` — exactly where the bug is. No current test
would catch `tailId` vs `blockIds[0]`.

`handleIncomingStream` is private and stream-based (libp2p `Stream`), so testing it end-to-end is heavy.
Prefer extracting the per-op `blockKey` derivation into a small pure, testable method on `RepoService`
(e.g. `private deriveBlockKey(operation): { blockKey: string | undefined, opName: string }` or similar),
have `handleIncomingStream` call it, then unit-test the derivation directly. This both fixes the bug in
one place and makes all four op-key derivations regression-testable.

The new test must assert, for a commit op where `blockIds[0] !== tailId`, that the derived key is
`blockIds[0]` (NOT `tailId`) — i.e. a commit routed to a non-tail block's coordinator is redirect-checked
against *that* block's cluster. Add the `!smallMesh && !isMember` redirect-fires assertion the current
commit suite lacks (drive `checkRedirect` with the derived key and a `networkManager` whose cluster
excludes self), confirming the redirect targets the cluster of `blockIds[0]`.

## TODO

- [ ] In `packages/db-p2p/src/repo/service.ts`, extract the per-op `blockKey` derivation out of
      `handleIncomingStream` into a pure, testable method (covering `get`/`pend`/`cancel`/`commit`), and
      fix the `commit` case to derive from `operation.commit.blockIds[0]!` instead of
      `operation.commit.tailId`. Keep `handleIncomingStream`'s dispatch behavior otherwise unchanged
      (e.g. `cancel`'s "no blockKey → handle locally without redirect" fallback).
- [ ] In `packages/db-p2p/test/redirect.spec.ts`, add a test that exercises the extracted derivation:
      a commit op with `blockIds: ['block-A', …]` and `tailId: 'tail-Z'` (where `'block-A' !== 'tail-Z'`)
      derives `blockKey === 'block-A'`. Then drive `checkRedirect` with that key against a
      `networkManager` cluster that excludes self and `cluster.length >= responsibilityK`, asserting a
      redirect fires toward `block-A`'s cluster (the `!smallMesh && !isMember` path the commit suite
      currently never hits). Keep/adjust the existing explicit-key commit test or fold it in.
- [ ] Build + typecheck `db-p2p` and `db-core`; run the `db-p2p` redirect suite (and the broader
      `db-p2p` test suite) and confirm green. Stream long-running output via `| tee` per the runner's
      idle-timeout rule.
- [ ] Sanity-check no other call site relies on the commit redirect keying on `tailId`
      (`checkRedirect` / `blockKey` usages for commits) — already surveyed during fix; reconfirm after edit.
