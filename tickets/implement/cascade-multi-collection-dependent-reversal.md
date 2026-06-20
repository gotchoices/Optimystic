description: When a transaction that wrote to more than one collection is automatically undone as part of a cascade, only one of its collections actually gets undone — the others are silently left with the bad data still committed. This fixes the cascade so every affected collection is undone.
prereq:
files: packages/db-p2p/src/dispute/cascade.ts, packages/db-p2p/test/cascade.spec.ts
difficulty: medium
----

# Implement: cascade must revert a multi-collection dependent in every collection

## Confirmed root cause (reproduced)

`cascadeInvalidate` (`packages/db-p2p/src/dispute/cascade.ts`) dedups invalidated work by **`actionId`
alone** (`const invalidatedIds = new Set<ActionId>([input.rootActionId])`). In Optimystic a transaction that
touches multiple collections is written to **every** affected collection's log under the **same** `actionId`
(`TransactionCoordinator.commitToCollection` → `coordinator.ts:540-548`, which passes `transaction.reads`
verbatim and uses `actionId = transaction.id` for every collection). Each collection's entry carries that
collection's own `blockIds`/`rev` but the **same full read set** — verified during this fix.

So a multi-collection read-dependent surfaces as a separate `CascadeCandidate` per collection (same
`actionId`, different `collectionId`/`blockIds`/`rev`). The engine processes the first one (lowest
`(rev, collectionId)`), calls `applyInvalidation` against that collection, adds `actionId` to
`invalidatedIds`, and every sibling collection-entry is then skipped — both at the candidate-loop top
(`if (invalidatedIds.has(cand.actionId)) continue;`) and at `collectCandidates`' exclusion
(`invalidatedIds.has(action.actionId)`). The transaction's writes in all but one collection are never
reverted and no child `InvalidationEntry` is appended there — a silent partial reversal.

### Reproduction (confirmed, then reverted)

A temporary spec was added, run, and the bug observed, then the spec was removed and the fix below was
applied + validated against it and the full existing `cascade.spec.ts` (11 passing) before reverting the
source so this ticket carries the clean recipe. Harness: two collections `A`, `B`; root `tinv` writes `X`
in `A` (rev 2); a multi-collection dependent `t2` writes `P` in `A` (rev 3) **and** `Q` in `B` (rev 2),
both reading `X@2`. Pre-fix: `t2` reverted in `B` only (lower rev processed first), `A.findInvalidation('t2')`
is `undefined`. Post-fix: both collections carry a `t2` child entry.

## The fix (validated)

Make the "already reverted this entry" identity **`(collectionId, actionId)`**, not `actionId` alone, while
keeping the root excluded globally (the caller drives the root reversal through consensus across *all* its
collections, so the cascade must never re-process the root in any collection). Track the transaction horizon
by **distinct transaction** so a multi-collection transaction counts once (consistent with the root counting
once) and is never split across the budget.

Concretely, in `packages/db-p2p/src/dispute/cascade.ts`:

**1. Add an `entryKey` helper** (next to `pairKey`):

```ts
/**
 * Dedup identity for a reverted log entry: the (collectionId, actionId) pair, not the actionId
 * alone. A transaction spanning N collections has one entry per collection (same actionId,
 * different collection/blockIds/rev) — each must be reverted independently, tracked separately.
 */
function entryKey(collectionId: CollectionId, actionId: ActionId): string {
	return `${collectionId} ${actionId}`;
}
```

**2. Replace the dedup/counter state** in `cascadeInvalidate`:

```ts
// was: const invalidatedIds = new Set<ActionId>([input.rootActionId]);
//      let totalInvalidated = 1;
const rootActionId = input.rootActionId;
const processedEntries = new Set<string>();          // entryKey() of collection-entries reverted this cascade
const invalidatedTxns = new Set<ActionId>([rootActionId]); // distinct transactions, for the horizon
```

**3. Candidate-loop skip** — dedup per collection-entry:

```ts
if (processedEntries.has(entryKey(cand.collectionId, cand.actionId))) {
	continue; // diamond: an ancestor pass already reverted this collection-entry
}
```

**4. Horizon check** — count distinct transactions; an already-counted transaction's remaining entries pass
freely so the cascade never reverts some collections of a transaction while escalating the rest:

```ts
if (!invalidatedTxns.has(cand.actionId) && invalidatedTxns.size + 1 > config.maxCascadeTransactions) {
	const remainder = await collectCandidates(input.envs, pairs, rootActionId, processedEntries);
	escalation = makeEscalation('max-transactions', affectedCollections, remainder, unevaluable);
	horizonHit = true;
	break;
}
```

**5. On successful invalidate** — record the entry + the transaction:

```ts
processedEntries.add(entryKey(cand.collectionId, cand.actionId));
invalidatedTxns.add(cand.actionId);
progressed = true;
```

**6. `unevaluable` dedup** — also per `(collectionId, actionId)`:

```ts
if (!unevaluable.some(u => u.collectionId === cand.collectionId && u.actionId === cand.actionId)) {
	unevaluable.push(standing(cand));
}
```

**7. `collectCandidates` signature + exclusion** — exclude the root globally and processed entries per pair;
update both call sites (the `maxCascadeDepth` remainder call and the per-round call):

```ts
async function collectCandidates(
	envs: ReadonlyArray<CollectionEnv>,
	pairs: Map<string, InvalidatedPair>,
	rootActionId: ActionId,
	processedEntries: Set<string>
): Promise<CascadeCandidate[]> {
	...
	const action = entry.action;
	// Exclude the root (invalidated by the caller across all its collections) and any
	// collection-entry already reverted this cascade — but a not-yet-reverted entry of the
	// same transaction in a different collection is still a live candidate.
	if (!action || action.actionId === rootActionId || processedEntries.has(entryKey(env.collectionId, action.actionId))) {
		continue;
	}
	...
}
```

Call sites become `collectCandidates(input.envs, pairs, rootActionId, processedEntries)` (three places: the
two `await collectCandidates(...)` inside the loop, plus none elsewhere — grep `collectCandidates(` to be sure).

### Why this preserves existing semantics (all 10 current tests verified green with this patch)

- **Diamond** (one entry, one collection, two ancestors): still evaluated exactly once — its single
  `(collectionId, actionId)` lands in `processedEntries` after the first invalidate.
- **Idempotent restart** (per collection-entry): `applyInvalidation` still returns `already-applied` per
  collection log; each entry dedups independently — no duplicate child entries on re-run.
- **`assertForwardOnly`** is already per-collection (only compares revs within the same collection), so the
  same transaction's cross-collection entries (`A:t2@3`, `B:t2@2`) never trip it — confirm with the new
  multi-collection tests.
- **Root counts once / horizon**: `invalidatedTxns` is seeded with the root and counts distinct
  transactions, matching the prior "root counts once" semantics. A multi-collection dependent counts once,
  and because a counted transaction's remaining entries bypass the horizon, the engine cannot produce the
  partial-reversal-at-the-horizon variant of this very bug.

## Horizon decision (documented per ticket request)

`maxCascadeTransactions` counts **per transaction (actionId)**, not per collection-entry. Rationale: the
config is named "transactions", the root already counts once, and — critically — counting/atomicity per
transaction is what guarantees a multi-collection dependent is reverted all-or-nothing even at the budget
edge. (Per-entry counting was rejected: it would let the horizon revert some of a transaction's collections
and escalate the rest, re-introducing a partial reversal — the exact failure this ticket closes.)

## Tests to add to `packages/db-p2p/test/cascade.spec.ts`

The harness already supports multi-collection transactions: call `a.seed({ actionId: 't2', rev: 3, ... })`
and `b.seed({ actionId: 't2', rev: 2, ... })` with the **same** `actionId` and the **same** `reads`. Give
each block a genesis revision in its own collection before the dependent rewrites it (e.g. genesis `P` in
`A` and `Q` in `B` at rev 1, so the revert computes a real `restore` rather than a deferred-delete).

- **Multi-collection dependent reversal** (the core regression): root `tinv` writes `X` in `A` (rev 2);
  `t2` writes `P` in `A` (rev 3) and `Q` in `B` (rev 2), both reading `X@2`. After `cascadeInvalidate`:
  both `a.log.findInvalidation('t2')` and `b.log.findInvalidation('t2')` are defined; `countInvalidationEntries(a) === 2`
  (root + t2), `countInvalidationEntries(b) === 1`; `result.invalidated` includes both `A:t2` and `B:t2`.
  (This is the exact scenario reproduced and validated during the fix.)

- **Idempotent restart of a multi-collection dependent**: run `cascadeInvalidate` twice from the same root;
  the second run produces **no duplicate** child entries in either collection (counts stay `A:2`, `B:1`) and
  still reports `t2` invalidated in both.

- **Multi-collection dependent under `maxCascadeTransactions`**: with budget = root + 1, the single
  multi-collection `t2` must be reverted in **both** collections (it is one transaction) without tripping
  `max-transactions`. Add a second, *independent* dependent `t3` (distinct actionId) to confirm it is the
  one escalated — proving the horizon counts `t2` once, not once-per-collection-entry, and never splits it.

## TODO

- [ ] Apply the seven edits above to `packages/db-p2p/src/dispute/cascade.ts`.
- [ ] Add `entryKey` and confirm `CollectionId`/`ActionId` are already imported (they are).
- [ ] Update both `collectCandidates` call sites to the new signature; grep `collectCandidates(` to verify none missed.
- [ ] Add the three regression tests to `packages/db-p2p/test/cascade.spec.ts`.
- [ ] Run `cd packages/db-p2p && yarn test:verbose 2>&1 | tee /tmp/cascade-test.log` (stream output); confirm
      the new tests pass and the existing 10 cascade tests stay green.
- [ ] Run `cd packages/db-p2p && yarn build 2>&1 | tee /tmp/cascade-build.log` (tsc) to confirm types.
- [ ] Hand off to review noting: the engine is not yet wired into a live composition root (handoff gap #4),
      so this remains a latent (pre-wiring) correctness fix; no production data path exercises it yet.
