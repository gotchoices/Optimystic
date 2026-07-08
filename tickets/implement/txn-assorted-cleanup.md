description: Tidy up five small transaction-layer issues — a peer set that fails to deduplicate, one component reaching into another's private fields, data passed through untyped escape-hatch casts, a dead deprecated code path, and one lookup that crashes when a storage backend returns a partial result.
files:
  - packages/db-core/src/transaction/coordinator.ts
  - packages/db-core/src/transaction/context.ts
  - packages/db-core/src/transaction/index.ts
  - packages/db-core/src/collection/collection.ts
  - packages/db-core/src/transactor/network-transactor.ts
  - packages/db-core/src/transactor/transactor-source.ts
  - packages/db-core/src/network/i-repo.ts
  - packages/db-core/src/network/i-key-network.ts
  - packages/db-p2p/src/repo/coordinator-repo.ts
  - packages/db-p2p/src/libp2p-key-network.ts
difficulty: medium
----

# Assorted transaction-layer cleanliness and one real crash

Five small items in the transaction layer. Four are low-severity tidy-ups; the
last (sparse-result crash) is reachable on a live path. All live around the same
coordinator/transactor seam, so they land as one pass.

Each section below states the problem, the exact site, and the intended shape of
the fix. None is speculative — the research is done; this is a build-it ticket.

---

## 1. Deduplicate GATHER nominees by peer identity (not object identity)

`TransactionCoordinator.gatherPhase` (`coordinator.ts:630-660`) queries each
critical block's cluster for its nominees and merges them into one
`Set<PeerId>`:

```ts
const supercluster = results.reduce((acc, result) => {
    result.nominees.forEach(nominee => acc.add(nominee));
    return acc;
}, new Set<PeerId>());
```

`queryClusterNominees` returns `{ nominees: PeerId[] }` (`transactor.ts:4-7`),
and the network implementation builds each `PeerId` with `peerIdFromString`
(`network-transactor.ts:521-525`) — a **fresh object per call**. A JS `Set` keys
objects by reference, so when the same physical peer is a nominee of two
different critical clusters, it lands in the supercluster **twice**. Those
duplicates then flow into `pendPhase` as `superclusterNominees` and onto every
`PendRequest.superclusterNominees` (`coordinator.ts:682-703`).

**Fix.** Dedupe by `peerId.toString()`. Build a `Map<string, PeerId>` keyed by
the string form, then return `new Set(map.values())`. Keep the return type
`ReadonlySet<PeerId> | null` — the single downstream consumer only does
`Array.from(...)` (`coordinator.ts:682`), so a plain `Set` of unique peers is
sufficient.

## 2. Route collection revision/actionContext through Collection methods

The coordinator reaches into `Collection`'s **private** `source` field via
bracket access — `collection['source'].actionContext` — in several places,
duplicating the "next revision = current + 1" and the "append committed
ActionRev, bump rev" logic:

- Read-only `(collection['source'].actionContext?.rev ?? 0) + 1`:
  `coordinator.ts:533`, `:692`, `:759`.
- Read-and-write (bump + append committed entry):
  `coordinator.ts:196-203` (in `commit`) and `:466-474` (in `execute`).

`Collection` already does the identical bump inline in `syncInternal`
(`collection.ts:335-337`), so the shape is known.

**Fix.** Add two public methods to `Collection` (`collection.ts`) and route all
five sites through them:

```ts
/** Next revision this collection would commit at (current committed rev + 1). */
getNextRev(): number { return (this.source.actionContext?.rev ?? 0) + 1; }

/** Record a just-committed action: append its ActionRev to the committed list
 *  and advance the revision. Returns the new revision. Mirrors the inline bump
 *  in syncInternal. */
recordCommitted(actionId: ActionId): number {
    const rev = this.getNextRev();
    this.source.actionContext = {
        committed: [...(this.source.actionContext?.committed ?? []), { actionId, rev }],
        rev,
    };
    return rev;
}
```

Then in the coordinator: replace the three read-only sites with
`collection.getNextRev()`, and replace the two read-write blocks with
`collection.recordCommitted(transaction.id)` (the `commit` path still calls
`applyCommittedToCache(...)` / `tracker.reset()` / `clearPendingActions()`
around it — only the `source` poke moves into the method). Import `ActionId`
into `collection.ts` if not already present.

Note the coordinator also pokes `this.coordinator['collections']` from
`context.ts:41` — that goes away entirely with item 4 (the file is deleted).

## 3. Give the escape-hatch casts real typed homes

`NetworkTransactor.pend` smuggles two things through `as any`:

- **`coordinatingBlockIds` on the pend options** (`network-transactor.ts:434-441`):
  the options object is cast `as any` because `MessageOptions`
  (`i-repo.ts:3-16`) has no `coordinatingBlockIds`. The consumer then reads it
  back through another cast: `(options as any)?.coordinatingBlockIds`
  (`coordinator-repo.ts:391`).
- **`recordCoordinator` on the key network** (`network-transactor.ts:448-455`):
  `this.keyNetwork` is cast `as any` to feature-detect and call
  `recordCoordinator`, which exists on the libp2p implementation
  (`libp2p-key-network.ts:302`) but is absent from the `IKeyNetwork` type
  (`i-key-network.ts:10-24`).

**Fix.**

- Add `coordinatingBlockIds?: BlockId[]` to `MessageOptions` (`i-repo.ts`).
  Drop the `as any` at `network-transactor.ts:440`; drop the `(options as any)`
  cast at `coordinator-repo.ts:391` (read `options?.coordinatingBlockIds`
  directly — keep the `?? allBlockIds` fallback).
- Add an optional method to `IKeyNetwork` (`i-key-network.ts`):
  `recordCoordinator?(key: Uint8Array, peerId: PeerId, ttlMs?: number): void;`
  (import `PeerId` from `./types.js` — already imported there). Then at
  `network-transactor.ts:448-455`, drop the `pn: any` alias and call
  `this.keyNetwork.recordCoordinator?.(await blockIdToBytes(b.blockId), b.peerId)`.
  The libp2p impl signature (`ttlMs = 30*60*1000` default) already matches the
  optional-`ttlMs` interface shape, so no impl change is required — verify it
  still structurally satisfies `IKeyNetwork`.

## 4. Delete the dead deprecated TransactionContext / commitTransaction path

`TransactionContext` (`context.ts`) and
`TransactionCoordinator.commitTransaction(context)` (`coordinator.ts:331-372`)
are the deprecated pre-`TransactionSession` path. Confirmed dead: there is **no
`new TransactionContext(...)`** anywhere in the repo, and the only reference to
the advertised `coordinator.begin()` factory is a stale doc comment in
`context.ts` — the method does not exist. Production commits go through
`TransactionSession` → `coordinator.commit()` / `coordinator.execute()`. (The
`TransactionBridge.commitTransaction()` and vtab `commit()` in
`quereus-plugin-optimystic` are unrelated same-named methods — do **not** touch
them.)

**Fix.** Delete:

- `packages/db-core/src/transaction/context.ts` (the whole file).
- `TransactionCoordinator.commitTransaction` (`coordinator.ts:331-372`).
- The `import { TransactionContext } from "./context.js";` in `coordinator.ts:5`.
- The `export { TransactionContext } from './context.js';` in
  `transaction/index.ts:29`.

After removal, check whether `createActionsStatements`, `createTransactionStamp`,
`createTransactionId`, and `ActionsEngine` are still used elsewhere in
`coordinator.ts` — `commitTransaction` was a consumer. Trim any now-unused
imports (`coordinator.ts:6-7`) that TypeScript/lint flags. The
`transaction.spec.ts` comments already note "TransactionContext tests removed",
so no live test depends on it — but run the db-core suite to confirm.

**Coordination note.** The ticket brief flagged tx-4 and tx-7 as also touching
this seam. Design as if their work lands; if a merge conflict surfaces in
`coordinator.ts` around the commit/execute actionContext handling, prefer the
method-based accessors from item 2.

## 5. Sparse-result TypeError in TransactorSource.tryGet (real crash)

`TransactorSource.tryGet` (`transactor-source.ts:28-38`):

```ts
const result = await this.transactor.get({ blockIds: [id], context: this.actionContext });
if (result) {
    const { block, state } = result[id]!;   // <-- crashes if key `id` absent
    ...
}
```

`transactor.get` returns a keyed results object. The Network transactor always
populates the requested key, but other transactors can return a **sparse**
result that omits `id` (e.g. block genuinely not found). `result` is then a
truthy object, so the guard passes, `result[id]` is `undefined`, and destructuring
`undefined` throws `TypeError: Cannot destructure property 'block' of ... as it is
undefined`.

**Fix.** Guard the per-key entry instead of asserting non-null:

```ts
const result = await this.transactor.get({ blockIds: [id], context: this.actionContext });
const entry = result?.[id];
if (entry) {
    const { block, state } = entry;
    this.readDependencies.push({ blockId: id, revision: state.latest?.rev ?? 0 });
    return block as TBlock;
}
// fall through -> returns undefined (block not present)
```

Preserve the existing read-dependency recording and the `// TODO: state.pendings`
comment; only the missing-key case changes (return `undefined` rather than crash).

## Expected behavior after this ticket

- A peer nominated by multiple critical clusters appears **once** in the
  supercluster.
- The coordinator no longer bracket-accesses `Collection`'s private `source`;
  revision handling lives on `Collection`.
- No `as any` on the pend options or the key network — both ride typed members.
- The deprecated `TransactionContext` / `commitTransaction` path is gone.
- A sparse transactor `get` result yields `undefined` instead of a `TypeError`.

Severity: LOW for items 1-4; item 5 is a reachable crash.

---

## TODO

- [ ] Item 1: rewrite `gatherPhase` merge to dedupe nominees by `toString()`
      (`coordinator.ts:650-659`); build `Map<string, PeerId>`, return
      `new Set(map.values())`.
- [ ] Item 2: add `getNextRev()` and `recordCommitted(actionId)` to `Collection`
      (`collection.ts`); route `coordinator.ts:533,692,759` through `getNextRev()`
      and `coordinator.ts:196-203,466-474` through `recordCommitted(...)`. Import
      `ActionId` into `collection.ts` if needed.
- [ ] Item 3a: add `coordinatingBlockIds?: BlockId[]` to `MessageOptions`
      (`i-repo.ts`); drop the `as any` at `network-transactor.ts:440` and the
      `(options as any)` cast at `coordinator-repo.ts:391`.
- [ ] Item 3b: add optional `recordCoordinator?(key, peerId, ttlMs?)` to
      `IKeyNetwork` (`i-key-network.ts`); drop the `pn: any` alias and use
      `this.keyNetwork.recordCoordinator?.(...)` at `network-transactor.ts:448-455`.
      Confirm `Libp2pKeyPeerNetwork` still satisfies `IKeyNetwork`.
- [ ] Item 4: delete `context.ts`, `coordinator.commitTransaction`, its import
      (`coordinator.ts:5`) and the `transaction/index.ts` re-export; trim any
      now-unused imports in `coordinator.ts`.
- [ ] Item 5: guard the sparse-result case in `TransactorSource.tryGet`
      (`transactor-source.ts:28-38`) — `result?.[id]` + `if (entry)`, return
      `undefined` on miss.
- [ ] Add a focused test for item 5: a stub transactor whose `get` returns an
      object missing the requested id; assert `tryGet` resolves `undefined`
      rather than throwing. (db-core test dir.)
- [ ] Build + typecheck db-core and db-p2p; run the db-core transaction suite
      (`packages/db-core/test/transaction.spec.ts`) and stream output with `tee`.
