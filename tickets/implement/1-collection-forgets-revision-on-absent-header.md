----
description: When a node asks storage "does this collection exist?" and gets back "no" — even though it does exist elsewhere in the cluster — the node quietly forgets the revision number it already knew, and every later save asks to write revision 1 again. Ten saves in a row get rejected for the same reason, taking about twenty seconds, and the error that comes out looks like ordinary traffic contention instead of the real problem.
files: packages/db-core/src/collection/collection.ts, packages/db-core/src/log/log.ts, packages/db-core/test/absent-header-wedges-revision.spec.ts
difficulty: medium
repro: verified
----

# `Collection` drops a known-good revision when a header read answers "absent"

## What was measured

`packages/db-core/test/absent-header-wedges-revision.spec.ts` (new, passing, 2 tests) drives a
`TestTransactor` wrapped so that reads of one block id are rewritten to an **authoritative absent**
answer (`{ state: {} }` — an entry that is present, carries no `block`, and sets no `unavailable`
flag), while `pend`/`commit` still see real state. Both tests reproduce, on the mock transactor,
in-process:

| Test | Result |
| --- | --- |
| A collection opened over a log already at rev 3 loses that context the moment one `update()` sees an absent header — `getNextRev()` goes **4 → 1** | reproduces |
| A collection whose header always reads absent re-requests **rev 1 on every one of its retries** and dies with `SyncRetryExhaustedError` | reproduces |

The second test asserts on the recorded pend revisions directly: every attempt carried `rev: 1`.
That is the shape the embedding application (sereus) reports —
`stale revision: block … at rev 3, requested rev 1`, ten times, ~20 s — recorded in
`fix/cross-node-convergence-sereus-signature-not-reproducible` (now closed by this ticket and its
sibling).

## The code site

`Collection.updateInternal` — [collection.ts:188-252](../../packages/db-core/src/collection/collection.ts#L188-L252).

```ts
const header = await tracker.tryGet(this.id) as CollectionHeaderBlock | undefined;
if (header) {
    await Collection.bootstrapContext(source, this.transactor, header);
}
// …
const collectionLog = await Log.open<Action<TAction>>(tracker, this.id);
const latest = collectionLog ? await collectionLog.getFrom(actionContext?.rev ?? 0) : undefined;
// …
this.source.actionContext = latest?.context;   // ← line 251, unconditional
```

Two decisions combine into the defect:

1. **An absent header is treated as authoritative and silently no-ops** (the `if (header)` guard).
   The doc comment above it argues this is safe because an unretrievable header throws
   `BlockUnavailableError` instead of resolving `undefined`. That argument holds only as far as the
   storage layer's ability to tell the two apart — see the sibling ticket
   `cluster-read-consult-cannot-report-unreachable`, where it demonstrably cannot.
2. **The context assignment is unconditional.** With no log to read, `latest` is `undefined`, so
   line 251 assigns `undefined` over whatever revision the collection already knew. `syncInternal`
   then recomputes `newRev = (this.source.actionContext?.rev ?? 0) + 1 === 1`
   ([collection.ts:390](../../packages/db-core/src/collection/collection.ts#L390)) and asks for rev 1
   again — for all ten attempts, since `syncInternal` calls `updateInternal` between every retry
   ([collection.ts:422](../../packages/db-core/src/collection/collection.ts#L422)).

The client holds proof the collection exists — a stale rejection that named a later revision — and
throws that proof away on the strength of a read that said "no such thing".

### A third site in the same family

`Collection.attachToLog` — [collection.ts:132-148](../../packages/db-core/src/collection/collection.ts#L132-L148)
— bootstraps the context from the committed tail (`bootstrapContext`, which reads `state.latest.rev`
off the tail block) and then **overwrites it unconditionally** with
`await collectionLog.getActionContext()`. `Log.getActionContext` returns `undefined` when the chain
has no tail or the tail block carries zero entries
([log.ts:155-159](../../packages/db-core/src/log/log.ts#L155-L159)), so the same
"assign a possibly-undefined context over a known-good one" shape exists on the open path.

`repro: static` for this arm specifically — it was read, not run. No construction of an
entries-empty log tail was attempted. Fix it for consistency with the same rule (never lower the
context), and if a test for it turns out to need contrived chain surgery, say so rather than
inventing one.

## What to change

**Never lower the revision context.** An assignment may advance it or leave it alone; it may not
replace a known revision with `undefined` or with a lower one. The revision the collection last
committed at is knowledge it earned, and no read that failed to find anything can un-earn it.

**Make a contradiction loud.** A header that reads absent while `this.source.actionContext` holds a
committed revision is a contradiction: something was committed under this id, and now storage says
nothing ever was. That is a fault, not an absence — the same reasoning `attachToLog` already applies
to a header that probes fine but whose log will not open ("a fault, not an absence — throw rather
than let the collection read as empty"). Throwing here converts a 20-second silent rev-1 spin into
an immediate, named diagnosis. Note that `BlockUnavailableError` is deliberately NOT a
`StaleFailure`, so `syncInternal`'s retry loop will not absorb it — which is the desired behaviour.

Keep the genuinely-absent case working: a collection that has never committed anything has no
context to protect, and `updateInternal` must still no-op for it exactly as today. The distinction
is entirely "do we already hold a revision".

## Interactions

- `plan/stale-failure-carries-coordinator-revision` is complementary, not overlapping. It gives the
  client the coordinator's revision as a structured field so a losing sync can rebase or fail fast.
  This ticket stops the client from discarding the revision it already had. Either alone is an
  improvement; both together are what makes the next sereus measurement decisive. No `prereq:` —
  they touch different fields and can land in either order.
- `backlog/feat-optimystic-legacy-commit-two-phase` also lists `collection.ts` in its `files:`, but
  its subject is the multi-tree commit window in the Quereus plugin, not the revision context. No
  conflict.
- Do not delete the six tests listed in the closed fix ticket
  (`packages/db-p2p/test/two-node-convergence-invention-race.spec.ts`,
  `packages/db-p2p/test/two-node-convergence.integration.spec.ts`,
  `packages/db-core/test/reopen-action-context-rev.spec.ts`) nor
  `packages/quereus-plugin-optimystic/test/two-node-multi-collection-commit.spec.ts`. They pass, and
  their value is ruling mechanisms out.

## Scope note

This fixes what turns a transient bad read into a permanent wedge. It does **not** identify why a
particular node's header read answers absent in the first place — that is the sibling ticket. After
both land, the same situation either recovers on its own or fails immediately with an error naming
the block and the reason, instead of producing a contention-shaped message twenty seconds later.

## TODO

- [ ] Make `updateInternal`'s context assignment monotonic — advance or leave alone, never lower.
      Cover it with a test that a `latest` of `undefined` leaves an existing rev intact.
- [ ] Apply the same rule to `attachToLog`'s `getActionContext()` overwrite of the bootstrapped tail
      context.
- [ ] Throw (rather than no-op) from `updateInternal` when the header reads absent but this
      collection already holds a committed action context. Name the collection id and the held
      revision in the message.
- [ ] Update `packages/db-core/test/absent-header-wedges-revision.spec.ts`: both tests pin the
      CURRENT (defective) behaviour and must be inverted to pin the fixed behaviour. Keep the
      `HeaderHidingTransactor` harness — it is the reusable part.
- [ ] Re-run the full db-core suite (1315 passing before this ticket, including the 2 new tests) and
      the quereus-plugin-optimystic suite (336 passing / 11 pending).
