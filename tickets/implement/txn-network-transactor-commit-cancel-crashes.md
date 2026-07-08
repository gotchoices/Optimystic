description: Fix two crash-path defects in NetworkTransactor commit/cancel: fire-and-forget cancel calls missing .catch cause process-fatal unhandled rejections, and a non-null assert on an optional field masks real stale-failure reasons with a TypeError.
files:
  - packages/db-core/src/transactor/network-transactor.ts
difficulty: easy
----

Two small, localized fixes in `NetworkTransactor`. Both live in the commit-failure path.

## Part A — fire-and-forget cancel missing .catch (HIGH)

Two `Promise.resolve().then(...)` calls fire cancel without a `.catch`, so if `cancel`/`cancelBatch` rejects (exactly what happens when peers are unreachable after a commit failure) Node throws an unhandled rejection → process crash.

### Fix locations

**`pend` method, ~line 510:**
```ts
// BEFORE
void Promise.resolve().then(() => this.cancelBatch(batches, { blockIds, actionId: blockAction.actionId }));
// AFTER
void Promise.resolve().then(() => this.cancelBatch(batches, { blockIds, actionId: blockAction.actionId })).catch(e => log('WARN: cancel after pend failure rejected: %o', e));
```

**`commitBlock` method, ~line 623:**
```ts
// BEFORE
Promise.resolve().then(() => this.cancel({ blockIds, actionId }));
// AFTER
void Promise.resolve().then(() => this.cancel({ blockIds, actionId })).catch(e => log('WARN: cancel after commit failure rejected: %o', e));
```
(Also adds the missing `void` prefix that the linter expects.)

## Part B — non-null assert on optional `missing` (MEDIUM)

`StaleFailure.missing` is typed `ActionTransforms[] | undefined` (`network/struct.ts:61`).
`commitBlock` (~line 627) uses `.missing!` which asserts non-null; a reason-only stale failure yields `undefined` elements that `distinctBlockActionTransforms` then destructures → TypeError that hides the actual failure reason.

The `pend` method already applies the correct guard at line 516:
```ts
.filter((x): x is ActionTransforms => x !== undefined)
```

### Fix location

**`commitBlock` method, ~line 627:**
```ts
// BEFORE
return { missing: distinctBlockActionTransforms(stale.flatMap(b => (b.request!.response! as StaleFailure).missing!)), success: false as const };
// AFTER
return { missing: distinctBlockActionTransforms(stale.flatMap(b => (b.request!.response! as StaleFailure).missing).filter((x): x is ActionTransforms => x !== undefined)), success: false as const };
```

## TODO

- Open `packages/db-core/src/transactor/network-transactor.ts`
- Apply Part A fix at ~line 510 (pend cancelBatch): add `.catch(e => log(...))` after `.then(...)`
- Apply Part A fix at ~line 623 (commitBlock cancel): add `void` prefix + `.catch(e => log(...))`
- Apply Part B fix at ~line 627: remove `!` from `.missing!`, add `.filter((x): x is ActionTransforms => x !== undefined)`
- Run `yarn tsc --noEmit` (or equivalent) in `packages/db-core` to confirm no type errors
- Run relevant tests if available
