----
description: A tree collection reopened from storage doesn't undo half-finished edits when a change fails partway through, so a mid-change error can leave the tree in a partly-updated state — freshly created trees don't have this problem, and reopened ones should behave the same.
prereq:
files: packages/db-core/src/collections/tree/tree.ts, packages/db-core/src/collection/collection.ts, packages/db-core/src/btree/btree.ts, packages/db-core/src/transform/atomic.ts, packages/db-core/src/transform/atomic-proxy.ts, packages/db-core/src/collections/tree/collection-trunk.ts, packages/db-core/test/tree.spec.ts
difficulty: medium
----

## Problem

`Collection.internalTransact` (collection/collection.ts:95-107) wraps every action handler
in an `Atomic` store so a handler failure leaves no partial state:

```ts
private async internalTransact(...actions: Action<TAction>[]) {
    const atomic = new Atomic(this.tracker);          // all-or-nothing wrapper
    for (const action of actions) {
        const handler = this.handlers[action.type];
        if (!handler) throw new Error(...);
        await handler(action, atomic);                 // handler is HANDED `atomic`
    }
    atomic.commit();                                   // only reached on full success
}
```

The contract: a handler writes through the `atomic` store it is passed. If the handler
throws, `atomic.commit()` is never reached, the `Atomic` (a `Tracker` over `this.tracker`)
is discarded, and `this.tracker` is untouched — clean rollback.

The tree collection's `"replace"` handler **ignores** the passed store and mutates the
captured outer `btree` instead (collections/tree/tree.ts:45-54):

```ts
"replace": async ({ data: actions }, _trx) => {   // _trx ignored
    for (const [key, entry] of actions) {
        if (entry) await btree!.upsert(entry);      // writes to captured btree, not _trx
        else       await btree!.deleteAt(await btree!.find(key));
    }
}
```

Where that captured `btree` writes depends on how the collection was constructed, and this
is where reopened trees diverge from freshly created ones:

- **Freshly created** (tree.ts:57 `BTree.create`): installs an `AtomicProxy` as the btree's
  `_proxy` (btree.ts:52-57). Each mutating op (`upsert`/`deleteAt`) runs inside
  `this.atomic(fn)` → `_proxy.atomic(fn)` (btree.ts:34-36), which commits that op's node
  writes to the tracker all-or-nothing. So a mid-op failure rolls back that op's partial
  node writes. (Per-operation atomicity — see caveat below.)
- **Reopened** (tree.ts:69 `new BTree(collection.tracker, …)`): no `AtomicProxy`, so
  `_proxy` is undefined and `this.atomic(fn)` just calls `fn()` directly (btree.ts:35).
  A mid-op failure (e.g. a store error partway through a leaf split) leaves partial node
  mutations staged in `collection.tracker` with **no rollback**.

Net: the outer `Atomic` handed to the handler is **dead** for the tree collection in both
cases (the handler never writes to it), and the only thing standing between a reopened tree
and half-applied staged mutations — the `AtomicProxy` — is absent on the reopen path.
Reopened trees therefore have strictly weaker atomicity than freshly created ones.

## Recommended fix — make the handler honor the passed store (`_trx`)

Route the `"replace"` handler through the `Atomic` store it is handed, instead of the
captured outer btree. Build a throwaway `BTree` bound to `_trx` per action:

```ts
"replace": async ({ data: actions }, trx) => {
    const btree = new BTree<TKey, TEntry>(
        trx,
        new CollectionTrunk(trx, id),
        keyFromEntry,
        compare,
    );
    for (const [key, entry] of actions) {
        if (entry) await btree.upsert(entry);
        else       await btree.deleteAt(await btree.find(key));
    }
}
```

Why this is the right fix rather than the AtomicProxy patch:

- It makes `internalTransact`'s `Atomic` actually do its job — the wrapper stops being dead
  code. A handler throw now discards the whole action's staged writes (`atomic.commit()`
  never runs), so **both** created and reopened trees roll back cleanly and identically.
- It removes the reopen-vs-create divergence at the source: neither path relies on the
  btree's own `_proxy` for action atomicity anymore.
- No btree API change: the handler binds a `BTree` to the passed store, which the public
  constructor already supports.
- It upgrades atomicity from **per-operation** to **whole-action** (a multi-entry replace
  that fails on entry N rolls back entries 1..N-1 too). That is the correct transactional
  semantic for a single logical action and is strictly stronger than today's created-tree
  behavior — see the caveat.

Reads are unaffected: `Tree` keeps its persistent `this.btree` (over `collection.tracker`)
for all read methods; only the mutation path changes. After `atomic.commit()` folds the
action into `collection.tracker`, `this.btree`'s trunk re-reads the updated root from the
committed header, so subsequent reads observe the change. `createHeaderBlock` still uses
`BTree.create` to bootstrap the root on first creation; the outer `btree` variable is still
needed there and to seed the read btree passed to the `Tree` constructor.

### Caveat — per-operation vs whole-action atomicity (why the deterministic test works)

Today a freshly created tree only gets **per-operation** rollback (each `upsert`/`deleteAt`
is individually atomic via `_proxy`; a multi-entry replace that fails on entry 2 keeps
entry 1). The recommended fix makes the whole action atomic. This is what lets the
regression test below be deterministic without injecting a throwing block store: a
multi-entry replace whose *second* entry throws must leave *zero* staged mutations, which
distinguishes fixed (whole-action rollback) from broken (entry 1 staged). The alternative
fix (below) would only give per-op parity and would NOT pass that test — a point in favor
of the recommended fix.

## Alternative fix (fallback) — AtomicProxy on the reopen path

If whole-action semantics are deemed too large a change, restore parity with created trees
by giving the reopened btree an `AtomicProxy` wired as `_proxy` (per-op atomicity). This
needs a new factory because `_proxy` is private and only `BTree.create` sets it (and
`create` builds a *new* root, which reopen must not do). Add e.g. `BTree.open(store,
createTrunk, keyFromEntry, compare)` that wraps `store` in an `AtomicProxy`, builds the
trunk over the proxy (so root-pointer updates share the atomic batch), constructs the
btree over the proxy, and sets `tree._proxy = proxy`. Then tree.ts:69 becomes
`BTree.open(collection.tracker, s => new CollectionTrunk(s, collection.id), keyFromEntry, compare)`.
This matches created behavior exactly but leaves the dead outer `Atomic` in place and does
not fix the handler-ignores-its-store smell. Prefer the recommended fix; use this only if
whole-action rollback is rejected in review.

## Reproduction (deterministic, collection-level)

Exercises the real reopen path — no block-store injection or split tuning needed.

1. Create a tree, `replace` at least one entry, and let `updateAndSync` commit it to the
   `TestTransactor` (so a header exists to reopen against).
2. Reopen via a second `Tree.createOrOpen(network, sameId, keyFromEntry)` — this hits the
   `new BTree(collection.tracker, …)` reopen path.
3. Capture the reopened collection's baseline staged state:
   `const trk = reopened.getCollection().tracker;` — `trk.transforms` should be empty
   (reopen only reads; reads stage no transforms).
4. Issue a two-entry replace where processing the **second** entry throws before any commit.
   Cleanest trigger: a `keyFromEntry` that throws on a poison marker (e.g.
   `entry => { if (entry.value === 'POISON') throw new Error('boom'); return entry.key }`).
   `btree.upsert` calls `keyFromEntry` at the top of the op, so the good first entry is
   fully processed and the poison second entry throws:
   `await reopened.replace([[1, good], [2, poison]])` wrapped in expect-to-throw.
5. Assert no partial mutations remain staged: `isTransformsEmpty(trk.transforms)` is true
   (import from `../src/index.js`), and `reopened.getCollection().getPendingActions()` is
   empty (`act` pushes to `pending` only after `internalTransact` returns — a throw skips it).

Broken code fails step 5 (entry 1's node writes are staged in `collection.tracker`).
Fixed code passes (entry 1's writes went to the discarded `Atomic`).

Put the test in `packages/db-core/test/tree.spec.ts` (has the `TestTransactor` +
`TestEntry` harness). Note: `keyFromEntry` is shared by the whole tree, so use a fresh
tree/collectionId for this test so the poison-throwing extractor doesn't affect other cases.

## TODO

- [ ] Rewrite the `"replace"` handler in `collections/tree/tree.ts` to bind a `BTree` to the
      passed `trx` store (recommended fix). Confirm `id`, `keyFromEntry`, `compare`, and
      `CollectionTrunk` are all in scope inside the `init.modules` closure (they are).
- [ ] Keep the outer `btree` variable for `createHeaderBlock` bootstrapping and for the read
      btree handed to the `Tree` constructor; only the mutation path moves to `trx`.
- [ ] Add the deterministic reopen-rollback regression test to `test/tree.spec.ts` per the
      Reproduction section (fresh collectionId + poison `keyFromEntry`).
- [ ] Add a companion assertion that a *freshly created* tree rolls back the same way (create,
      do NOT sync, run the same poisoned two-entry replace, assert staged state unchanged from
      its pre-replace snapshot) so create/reopen parity is pinned by a test.
- [ ] Run `yarn test` in `packages/db-core` (stream with `2>&1 | tee`); ensure existing
      tree/btree/collection specs still pass — especially the "multiple tree instances" and
      "concurrent creation" reopen tests in `tree.spec.ts`.
- [ ] If `docs/internals.md` (or `docs/transactions.md`) documents Collection action
      atomicity / the `Atomic` handler wrapper, note that the tree `"replace"` handler now
      writes through the handed `Atomic` store, giving whole-action rollback for created and
      reopened trees alike. Skip if no such section exists — don't invent one.
