description: When the client follows a "talk to that peer instead" redirect, it tries to remember which peer handles a block so the next request can skip the lookup — but it records that note under a key that never matches how blocks are actually looked up, so the shortcut silently never helps, and for multi-block writes it even remembers the wrong block.
prereq:
files:
  - packages/db-p2p/src/repo/client.ts (extractKeyFromOperations ~101-119; recordCoordinatorForOpsIfSupported ~121-127; call site ~93)
  - packages/db-p2p/src/cluster/client.ts (recordCoordinatorForRecordIfSupported ~53-66; call site ~46)
  - packages/db-core/src/utility/block-id-to-bytes.ts (blockIdToBytes — sha256 of the block id; the real routing key encoding)
  - packages/db-core/src/transform/helpers.ts (blockIdsForTransforms — correct pend block-id derivation)
  - packages/db-core/src/transactor/network-transactor.ts (findCoordinator / recordCoordinator keyed via blockIdToBytes — the lookup side that must match)
  - packages/db-p2p/test/redirect.spec.ts (existing redirect tests; add the cache-hint key assertions here)
difficulty: medium
----

# Client coordinator-cache-hint keys: wrong block + wrong byte encoding

## Background

When a client dials a peer that turns out not to be responsible for a block, the peer replies
with a `redirect` payload naming the real coordinator(s). Both client paths follow the redirect
and, as an optimization, record a **coordinator-cache hint** ("peer P coordinates key K") into the
peer-network cache so a *follow-up* op can dial P directly instead of re-running `findCoordinator`:

1. `RepoClient.processRepoMessage` → `recordCoordinatorForOpsIfSupported` → `extractKeyFromOperations`
   (`packages/db-p2p/src/repo/client.ts`)
2. `ClusterClient.update` → `recordCoordinatorForRecordIfSupported`
   (`packages/db-p2p/src/cluster/client.ts`)

Both compute the cache key with the **same three defects** the service redirect path had (fixed in
`commit-redirect-key-anchors-on-wrong-block`):

### Defect 1 — encoding mismatch (makes the hint a no-op today)

The real routing key used by `findCoordinator` / `recordCoordinator` in `network-transactor.ts` is
`await blockIdToBytes(id)` — the **sha256 digest** of the block id (see
`packages/db-core/src/utility/block-id-to-bytes.ts`). Both client paths instead encode the key as
**raw UTF-8** via `new TextEncoder().encode(id)`. Raw UTF-8 bytes ≠ sha256 digest, so a hint
recorded by the client can never be retrieved by a lookup that hashes — the hint is effectively a
**no-op**, which is also what currently *masks* defects 2 and 3.

### Defect 2 — commit keyed on `tailId` instead of `blockIds[0]`

`extractKeyFromOperations` keys a commit on `op.commit.tailId`, and
`recordCoordinatorForRecordIfSupported` keys on `rmsg.commit.tailId`. The block a commit is actually
coordinated/verified on is `blockIds[0]` (see the prior fix: `CoordinatorRepo.commit` anchors
consensus + `verifyResponsibility` on `blockIds[0]`, not the collection tail). For a non-tail commit
batch (`blockIds[0] !== tailId`) the hint records the coordinator under the wrong block.

### Defect 3 — pend keyed on a structural field name instead of a block id

`extractKeyFromOperations` keys a pend on `Object.keys(op.pend.transforms)[0]`, and
`recordCoordinatorForRecordIfSupported` does the same on `rmsg.pend.transforms`. But `transforms` is a
`Transforms` object shaped `{ inserts, updates, deletes }` — so `Object.keys(...)[0]` yields the
**field name** `'inserts'`/`'updates'`/`'deletes'`, not a block id. The correct derivation is
`blockIdsForTransforms(transforms)[0]` (see `packages/db-core/src/transform/helpers.ts`).

## Why all three must be fixed together

These are *hints* (an optimization), so today's user-visible impact is only a missed cache hit, not a
hard failure — defect 1 neutralizes defects 2 and 3. But fixing the encoding *alone* (defect 1) would
turn the wrong-block keys (defects 2 and 3) into **live misroutes**: follow-up ops would be dialed
straight to the wrong cluster. So the encoding and block-selection fixes ship together. The goal:
the bytes the client records and the bytes `findCoordinator` looks up must be **identical** —
`blockIdToBytes(<the block the op is coordinated on>)`.

## Correct key derivation (target)

| op     | block to key on                          | encode with        |
|--------|------------------------------------------|--------------------|
| get    | `op.get.blockIds[0]`                      | `blockIdToBytes`   |
| pend   | `blockIdsForTransforms(op.pend.transforms)[0]` | `blockIdToBytes` |
| commit | `op.commit.blockIds[0]`                   | `blockIdToBytes`   |
| cancel | `op.cancel.actionRef.blockIds[0]`        | `blockIdToBytes`   |

`ClusterClient` carries the op inside `record.message` (a `RepoMessage`); apply the same commit/pend
selection there (it only handles commit/pend today; keep that scope).

## Type/import facts (verified)

- `blockIdToBytes` and `blockIdsForTransforms` are both exported from `@optimystic/db-core`
  (re-exported via the package index). Import them in both client files.
- `blockIdToBytes` is **async** (`Promise<Uint8Array>`), so `extractKeyFromOperations` becomes async,
  which makes `recordCoordinatorForOpsIfSupported` async too. The call site (`client.ts` ~93) is
  currently fire-and-forget; **await it** (the redirect retry that follows is async anyway, and a
  deterministic await keeps the hint ordering testable). For `ClusterClient`, `recordCoordinatorFor
  RecordIfSupported` likewise becomes async — await it at the call site (~46).
- `CommitRequest = ActionBlocks & {...}` → has `blockIds` and `tailId`. `PendRequest = ActionTransforms
  & {...}` → `transforms` is a `Transforms` (`{ inserts, updates, deletes }`).
- `recordCoordinator(keyBytes: Uint8Array, peerId)` is the cache API used on the peer-network — match
  the `network-transactor.ts` call shape exactly.

## Edge cases

- Preserve the existing `undefined`/empty guards: if the selected block id is missing (empty
  `blockIds`, empty transforms), record **nothing** (do not call `recordCoordinator` with a hashed
  empty/undefined id). `blockIdsForTransforms` returns `[]` for empty/absent transforms, so guard on
  `[0]` being defined before hashing.
- Keep `recordCoordinator` feature-detection (`typeof pn?.recordCoordinator === 'function'`) intact.
- Don't widen `ClusterClient` to handle get/cancel — it only ever records commit/pend today.

## TODO

- [ ] `RepoClient` (`packages/db-p2p/src/repo/client.ts`): rewrite `extractKeyFromOperations` to select
  the correct block per the table above and `return await blockIdToBytes(id)` for all four cases; make
  it `async` (return `Promise<Uint8Array | undefined>`). Guard each case so an absent id yields
  `undefined` and records nothing.
- [ ] `RepoClient`: make `recordCoordinatorForOpsIfSupported` async (await `extractKeyFromOperations`),
  and `await` it at the call site (~line 93). Add the `blockIdToBytes` / `blockIdsForTransforms`
  imports from `@optimystic/db-core`.
- [ ] `ClusterClient` (`packages/db-p2p/src/cluster/client.ts`): in
  `recordCoordinatorForRecordIfSupported`, select `rmsg.commit.blockIds[0]` for commit and
  `blockIdsForTransforms(rmsg.pend.transforms)[0]` for pend; encode via `await blockIdToBytes(id)`;
  make the method async and `await` it at the call site (~line 46). Keep the empty/undefined guard and
  the `recordCoordinator` feature-detection. Add the necessary imports.
- [ ] Tests (extend `packages/db-p2p/test/redirect.spec.ts`, or a sibling spec): assert the recorded
  key bytes equal `await blockIdToBytes(blockIds[0])` for
  (a) a **non-tail commit** (`blockIds[0] !== tailId`) — must record under `blockIds[0]`, NOT `tailId`,
  and NOT raw `TextEncoder().encode(...)`; and
  (b) a **real-shaped pend** (`transforms: { inserts: { 'block-A': ... }, updates: {}, deletes: [] }`)
      — must record under `block-A`, NOT the literal `'inserts'`.
  Drive `RepoClient`/`ClusterClient` with a fake `peerNetwork` exposing `recordCoordinator` that
  captures the `(keyBytes, peerId)` it receives, and a stubbed transport that returns a single
  `redirect` payload so the hint path runs once. Compare captured bytes against `blockIdToBytes` to
  prove the client and `findCoordinator` would share identical key bytes. (Mirror the digest helpers
  in `redirect.spec.ts` for assertions.)
- [ ] Build + typecheck `db-p2p` and `db-core` (`yarn workspace @optimystic/db-p2p build`, and db-core
  if touched — db-core is not expected to change). Stream output with `tee`.
- [ ] Run the `db-p2p` suite: `yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/db-p2p-test.log`;
  confirm green. The `reactivity / mesh — slow-subscriber isolation` test is a known pre-existing flake
  (unrelated to this change) — if it and only it fails, record it in `tickets/.pre-existing-error.md`
  per the stage rules rather than chasing it.

## Validation

- New tests prove recorded key bytes == `blockIdToBytes(blockIds[0])` for non-tail commit and pend.
- `db-p2p` build + typecheck clean; suite green (modulo the known unrelated flake).
