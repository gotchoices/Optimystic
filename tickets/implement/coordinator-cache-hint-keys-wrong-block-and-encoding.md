<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-06-16T23:51:51.811Z (agent: claude)
  Log file: C:\projects\optimystic\tickets\.logs\coordinator-cache-hint-keys-wrong-block-and-encoding.implement.2026-06-16T23-51-51-811Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.

  STATE (verified 2026-06-16 by the fix-stage consolidation pass): the prior run was killed during
  exploration (idle-timeout while reading package.json / .mocharc) and made **NO code changes**.
  `cluster/client.ts` is fully original; `repo/client.ts` carries only the earlier sibling fix
  (pend `blockIdsForTransforms`, still raw `utf8` encoding, commit still on `tailId`). Start the code
  work fresh from the TODO below — nothing is half-applied. The ticket body was substantively enriched
  in this pass (Defect 0 added, encoding/commit-key questions resolved); re-read it before coding.
<!-- /resume-note -->
description: When the client follows a "talk to that peer instead" redirect, it tries to remember which peer handles a block so the next request can skip the lookup — but it records that note under a key that never matches how blocks are actually looked up, so the shortcut silently never helps; for multi-block writes it even remembers the wrong block, and on the cluster path it reads the write details from the wrong place entirely and so records nothing at all.
prereq:
files:
  - packages/db-p2p/src/repo/client.ts (extractKeyFromOperations ~101-119; recordCoordinatorForOpsIfSupported ~121-127; call site ~93)
  - packages/db-p2p/src/cluster/client.ts (recordCoordinatorForRecordIfSupported ~53-66; call site ~46)
  - packages/db-core/src/network/repo-protocol.ts (RepoMessage = { operations: [...] } — the real shape ClusterClient must read)
  - packages/db-core/src/cluster/structs.ts (ClusterRecord.message: RepoMessage — line 20)
  - packages/db-core/src/utility/block-id-to-bytes.ts (blockIdToBytes — sha256 of the block id; the real routing key encoding)
  - packages/db-core/src/transform/helpers.ts (blockIdsForTransforms — correct pend block-id derivation)
  - packages/db-core/src/transactor/network-transactor.ts (findCoordinator / recordCoordinator keyed via blockIdToBytes — the lookup side that must match)
  - packages/db-p2p/src/libp2p-key-network.ts (recordCoordinator/findCoordinator/toCacheKey — cache keyed on exact input bytes, base64url of whatever is passed)
  - packages/db-p2p/test/redirect.spec.ts (existing redirect tests; add the cache-hint key assertions here)
difficulty: medium
----

# Client coordinator-cache-hint keys: wrong block + wrong byte encoding + wrong message shape

> **Consolidation note (2026-06-16):** this ticket now also absorbs the fix-stage ticket
> `cluster-client-coordinator-hint-reads-wrong-message-shape`, whose investigation confirmed a
> **fourth** defect specific to `ClusterClient` (Defect 0 below: it reads `record.message.pend` /
> `record.message.commit`, which never exist) and resolved the two open questions that ticket raised
> (encoding → `blockIdToBytes`; commit key → `blockIds[0]`). Both tickets rewrite the *same* private
> function, so they were merged here to avoid a conflicting double-edit. The fix ticket has been
> deleted. **Scope is unchanged for `RepoClient`; the `ClusterClient` instructions below are now
> corrected to read the real message shape.**

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
`commit-redirect-key-anchors-on-wrong-block`) — and `ClusterClient` carries an **additional, more
fundamental** defect (Defect 0) that reads the wrong part of the message entirely.

### Defect 0 — `ClusterClient` reads the wrong message shape (cluster hint is dead code)

`ClusterClient.recordCoordinatorForRecordIfSupported` (`packages/db-p2p/src/cluster/client.ts:53-66`)
inspects `record.message.commit?.tailId` and `record.message.pend?.transforms`. But `record.message`
is a `RepoMessage` (`packages/db-core/src/cluster/structs.ts:20`), whose shape is
`{ operations: [ { get } | { pend } | { cancel } | { commit } ], ... }`
(`packages/db-core/src/network/repo-protocol.ts:3`). There is **no top-level `.pend` / `.commit`** —
those live at `record.message.operations[0].pend` / `.commit`. `rmsg` is cast to `any`, so the
compiler never flags it: both branches read `undefined`, `tailId` stays `undefined`, and
`recordCoordinator` is **never called**. The entire cluster coordinator-affinity hint is dead code,
which is why Defects 2 and 3 went unnoticed on this path.

**Fix:** read `record.message.operations[0]` and switch over its op variants exactly the way
`RepoClient.extractKeyFromOperations` and `RepoService.deriveBlockKey` do. The `RepoClient` path
(`extractKeyFromOperations`) already reads the shape correctly — `ClusterClient` must mirror it
(restricted to the commit/pend variants it handles; see scope note below).

### Defect 1 — encoding mismatch (makes the hint a no-op today)

The real routing key used by `findCoordinator` / `recordCoordinator` in `network-transactor.ts` is
`await blockIdToBytes(id)` — the **sha256 digest** of the block id (see
`packages/db-core/src/utility/block-id-to-bytes.ts`). Both client paths instead encode the key as
**raw UTF-8** via `new TextEncoder().encode(id)`. Raw UTF-8 bytes ≠ sha256 digest, so a hint
recorded by the client can never be retrieved by a lookup that hashes — the hint is effectively a
**no-op**, which is also what currently *masks* defects 2 and 3.

**Confirmed end-to-end (resolves the open encoding question):** the cache is keyed on the *exact
input bytes*. `Libp2pKeyPeerNetwork.recordCoordinator`/`getCachedCoordinator` derive the map key via
`toCacheKey(key) = u8ToString(key, 'base64url')` (`packages/db-p2p/src/libp2p-key-network.ts:114`) —
a pure encoding of whatever bytes are passed, no hashing inside. Every real `findCoordinator` caller
passes `await blockIdToBytes(blockId)` (sha256) — verified at `network-transactor.ts:106,145,155,300,
372,444,524,560,582`. So for a recorded hint to ever be found, the writer must record under
`blockIdToBytes(id)` too. (The raw-`utf8(id)` convention in
`packages/db-p2p/src/cohort-topic/reactivity-membership-gate.ts:29-48` is a **different subsystem** —
it feeds `reactivityTopicId` hashing, *not* the coordinator cache — and is correctly left alone.)

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

`ClusterClient` carries the op inside `record.message` (a `RepoMessage`). **First fix the shape**
(Defect 0): read `const op = record.message.operations[0]`, then apply the same commit/pend selection
on `op` (`op.commit.blockIds[0]`, `blockIdsForTransforms(op.pend.transforms)[0]`). It only handles
commit/pend today — keep that scope (don't widen to get/cancel). **Do not** read `record.message.commit`
or `record.message.pend`; those properties do not exist and are the live dead-code bug.

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
  `recordCoordinatorForRecordIfSupported`, **first read the correct shape** —
  `const op = record.message.operations[0]` (NOT `record.message.commit` / `record.message.pend`,
  which never exist — Defect 0). Then select `op.commit.blockIds[0]` for the commit variant and
  `blockIdsForTransforms(op.pend.transforms)[0]` for the pend variant (use `'commit' in op` /
  `'pend' in op` discrimination like `RepoClient.extractKeyFromOperations`). Encode via
  `await blockIdToBytes(id)`; make the method async and `await` it at the call site (~line 46). Keep
  the empty/undefined guard (empty `operations`, missing op, empty `blockIds`/transforms → record
  nothing) and the `recordCoordinator` feature-detection. Add the `blockIdToBytes` /
  `blockIdsForTransforms` imports from `@optimystic/db-core`. Drop the `any` cast on `record.message`
  where practical so the shape is type-checked (or at minimum index `operations[0]` rather than
  top-level `.pend`/`.commit`).
- [ ] Tests — `RepoClient` (extend `packages/db-p2p/test/redirect.spec.ts`, or a sibling spec): assert
  the recorded key bytes equal `await blockIdToBytes(blockIds[0])` for
  (a) a **non-tail commit** (`blockIds[0] !== tailId`) — must record under `blockIds[0]`, NOT `tailId`,
  and NOT raw `TextEncoder().encode(...)`; and
  (b) a **real-shaped pend** (`transforms: { inserts: { 'block-A': ... }, updates: {}, deletes: [] }`)
      — must record under `block-A`, NOT the literal `'inserts'`.
  Drive `RepoClient` with a fake `peerNetwork` exposing `recordCoordinator` that
  captures the `(keyBytes, peerId)` it receives, and a stubbed transport that returns a single
  `redirect` payload so the hint path runs once. Compare captured bytes against `blockIdToBytes` to
  prove the client and `findCoordinator` would share identical key bytes. (Mirror the digest helpers
  in `redirect.spec.ts` for assertions.)
- [ ] Tests — `ClusterClient` (**new coverage; the cluster hint path had none, which is how its
  dead-code shape bug went unnoticed**): feed a real `ClusterRecord` whose `message` is a properly
  shaped `RepoMessage` (`{ operations: [{ commit: {...} }] }` and, separately,
  `{ operations: [{ pend: { transforms: { inserts: { 'block-A': ... }, updates: {}, deletes: [] } } } ]}`),
  drive `ClusterClient.update` against a stubbed transport returning a single `redirect`, and assert
  `recordCoordinator` **is invoked** (it is never called today) with `keyBytes ===
  await blockIdToBytes(blockIds[0])` for the non-tail commit case and `await blockIdToBytes('block-A')`
  for the pend case. Build the `ClusterRecord` from `packages/db-core/src/cluster/structs.ts` (minimal
  valid `peers`/`promises`/`commits`/`messageHash` are fine). This both proves Defect 0 is fixed and
  locks the shape so a future `any`-cast regression can't silently kill the hint again.
- [ ] Build + typecheck `db-p2p` and `db-core` (`yarn workspace @optimystic/db-p2p build`, and db-core
  if touched — db-core is not expected to change). Stream output with `tee`.
- [ ] Run the `db-p2p` suite: `yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/db-p2p-test.log`;
  confirm green. The `reactivity / mesh — slow-subscriber isolation` test is a known pre-existing flake
  (unrelated to this change) — if it and only it fails, record it in `tickets/.pre-existing-error.md`
  per the stage rules rather than chasing it.

## Validation

- New `RepoClient` tests prove recorded key bytes == `blockIdToBytes(blockIds[0])` for non-tail commit
  and pend.
- New `ClusterClient` test proves `recordCoordinator` is now **invoked at all** (Defect 0) and with
  `blockIdToBytes(blockIds[0])` — covering a path that previously had zero coverage.
- `db-p2p` build + typecheck clean; suite green (modulo the known unrelated flake).
