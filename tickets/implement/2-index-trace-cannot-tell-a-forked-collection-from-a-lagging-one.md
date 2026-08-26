----
description: When two machines disagree about what a secondary index contains, our diagnostic log lines cannot say which machine wrote which line, and cannot tell "this machine is simply behind" apart from "the two machines have built two separate copies of the same index". Add the two missing pieces of information so one run of the failing scenario answers the question.
prereq:
files:
  - packages/quereus-plugin-optimystic/src/logger.ts
  - packages/quereus-plugin-optimystic/src/optimystic-module.ts (logIndexSeek ~989, openIndexTree ~2441)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/txn-bridge.ts (treeRevision ~66, logCommitCollections ~558)
  - packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts (the one instance per Database — the natural per-node identity)
  - packages/quereus-plugin-optimystic/src/plugin.ts (constructs the factory, bridge and module together)
  - packages/db-core/src/collection/collection.ts (committedRevision ~478 — needs a sibling accessor)
  - packages/db-core/src/collections/tree/tree.ts (committedRevision ~264 — forwards it)
  - docs/debugging.md (§ "Which collections did a write carry?" line 97, § "Which revision did a read descend?" line 156)
difficulty: medium
repro: verified (the instrumentation gap, not the underlying defect — see "What was measured here")
----

# The three index traces cannot answer the question they were added to answer

## Background — the defect this serves

Downstream (the `sereus` repo), two machines each insert a row into one table under the same
secondary-index value. Both inserts commit. Afterwards each machine, querying `where Token = ?`,
gets back only the row it wrote itself — forever, with no error — while a full table scan on either
machine returns both rows. So the table data agrees across machines and the index does not.

Three diagnostic log lines exist in this repo specifically to investigate this
(`docs/debugging.md`): `commit:collections` (what a write carried), `index:tree-open` (which index
collection a table resolved to), and `index:seek` (what a read descended). Eight downstream reports
have now been filed. The most recent one carried read-side numbers for the first time, and they
narrowed the question to exactly one fork in the road that the existing lines cannot resolve:

- **One copy, one machine behind.** There is a single index collection; one machine simply never
  caught up to it. Fix would be about refresh.
- **Two copies under one name.** Each machine has built its own separate index collection under the
  same identifier, each counting its own revisions from 1. Fix would be about how a collection
  comes into existence, and would be much more serious.

Both produce identical logs today. This ticket makes them distinguishable.

## What was measured here

Running the failing scenario's shape inside this repo's own two-node mesh harness (two `Database`
instances over one in-process mesh, both inserting the same indexed value, commits driven
concurrently through `Promise.all` rather than one after the other — a shape no existing spec
covers), the scenario **passes**: both machines see both rows through the index. That is the eighth
consecutive failure to reproduce the defect locally, and it rules out "the two commits' awaits
interleave" as the missing ingredient.

What that run *did* reproduce is this ticket's subject. The two machines emitted, at the same
instant, byte-identical lines:

```
commit:collections mode=legacy count=2 default/FormationUsage=staged default/FormationUsage/index/formation_usage_by_token=staged revs=default/FormationUsage:none,default/FormationUsage/index/formation_usage_by_token:1
commit:collections mode=legacy count=2 default/FormationUsage=staged default/FormationUsage/index/formation_usage_by_token=staged revs=default/FormationUsage:none,default/FormationUsage/index/formation_usage_by_token:1
```

Nothing in either line says which machine wrote it. The downstream report had to attribute its
lines *positionally* — by knowing which machine its test harness polled first — and said outright
that this was not possible for the write-side lines at all.

The same run also establishes a **healthy baseline for this exact scenario**, which is worth
recording because the downstream numbers should be read against it:

```
index:seek ... arm=live rev=3 main_rev=2 seek=%02tok-shared%00 matched=2     (both machines)
```

Downstream, one machine printed `rev=3 main_rev=2 matched=1` — the healthy revisions, and half the
rows — and the other printed `rev=2 main_rev=2 matched=1`. So the anomalous machine's index
collection sits one revision below the healthy value while its main table collection sits at the
healthy value.

## Correction to the source report

The source report asked for a peer id to be threaded through **`packages/db-core/src/logger.ts`**.
That is the wrong file: none of the three lines comes from `db-core`. All three are emitted through
**`packages/quereus-plugin-optimystic/src/logger.ts`**, which is a third `createLogger` — separate
from both `db-core`'s and `db-p2p`'s, and, like `db-core`'s, carrying no node parameter.
(`packages/db-p2p/src/logger.ts` is the one with the peer-id mechanism, and its invitation to reuse
it stands — but it is in a package these three lines do not go through.)

## What to build

### 1. Say which node emitted the line

There is exactly one `CollectionFactory` per plugin registration, one plugin registration per
Quereus `Database`, and one `Database` per machine — in this repo's mesh harness and in the
downstream harness alike. So the factory instance *is* the node identity, and it is already reachable
from both emitting sites (the vtab holds `this.collectionFactory`; the bridge holds
`this.collectionFactory`).

Give `CollectionFactory` a short, stable **node tag**: a random identifier by default, settable by a
host that has a better name for its machines (the downstream harness would set `A`/`B`; a host with
a libp2p node can set its peer id). Print it as a `node=` field on all three lines.

A field, not a namespace suffix — which is deliberately different from how `db-p2p` does it. Three
lines share one `debug` namespace here, and splitting that namespace per node would mean an operator
has to know the node tags *before* choosing a `DEBUG=` filter. A field keeps one filter and stays
greppable.

### 2. Say which lineage a revision belongs to

A revision number alone cannot distinguish the two candidate explanations above: under "two copies",
each copy honestly reports its own count, and the numbers look like ordinary lag.

Every collection already holds, in memory, the identity of the action that produced its current
revision — `Collection`'s action context carries a list of `{actionId, rev}` pairs alongside the
current `rev`. Nothing prints it.

Expose it and print it beside every revision these lines already report:

- `Collection` gains an accessor returning the action id at its current committed revision
  (`undefined` when the context holds no entry at that revision, which is a legitimate state — print
  a placeholder rather than inventing one). Document it as diagnostic-only, in the same terms as the
  existing `committedRevision()` accessor directly above it.
- `Tree` forwards it, next to its existing `committedRevision()` forwarder.
- `index:seek`'s `rev=`/`main_rev=` and `commit:collections`'s `revs=` print `<rev>@<actionId>`.

That makes the fork question a one-line comparison: **two machines reporting the same collection id
at the same revision but different action ids have two separate copies; the same action id means one
copy and one machine is behind.** No cross-node correlation, no positional guessing.

Keep the existing `none` and `unknown` tokens meaning exactly what they mean today (they are pinned
by `test/adapter-integration.spec.ts`) — the action id is an addition to the revision token, not a
replacement for either word.

### 3. Update the operator documentation

`docs/debugging.md` §"Which revision did a read descend?" carries the decision table an operator
applies to these lines. It needs:

- the two new fields described;
- an explicit warning that action ids, unlike revisions, **are** comparable across collections and
  across nodes (the doc currently, and correctly, forbids comparing revisions across collections —
  the new field is the exception and must say so);
- a new row for the case that was actually measured downstream and that the table has no reading
  for: *a live refresh ran immediately before the read and the revision did not move*. Split it by
  action id — same id at a lower revision is a refresh that failed to close a real gap; a different
  id at the same revision is two separate copies of the collection.

## Verifying it

The three lines are already pinned by tests, so the additions must be pinned too — at minimum, that
two `Database` instances writing the same collection emit distinguishable `node=` values, and that
`rev=` carries an action id in the ordinary committed case while still printing `none`/`unknown`
where it did before.

This ticket does not fix the downstream defect and should not claim to. Its deliverable is that the
next downstream run of `strand-formation-concurrent-redemption` answers "one copy or two" from its
own log, which no run so far has been able to do.

## TODO

Phase 1 — node identity

- Add a node tag to `CollectionFactory`: defaulted to a short random id, with a setter so a host can
  name its nodes. Document that one factory means one `Database` means one node.
- Thread it into `logIndexSeek`, `openIndexTree`'s `index:tree-open` line, and
  `TransactionBridge.logCommitCollections` as a `node=` field.
- Leave `packages/quereus-plugin-optimystic/src/logger.ts` signature-compatible with today's callers;
  if a node parameter is added there instead, every existing call site must keep producing the same
  namespace it produces now.

Phase 2 — lineage identity

- Add the committed-action-id accessor to `Collection`, beside `committedRevision()`, documented as
  diagnostic-only and explicit about when it is `undefined`.
- Forward it from `Tree`, beside its `committedRevision()` forwarder.
- Widen the bridge's `DirtyTree` optional surface the same way its `committedRevision?()` is widened
  today, so test doubles are unaffected.
- Print `<rev>@<actionId>` in `index:seek` (`rev=`, `main_rev=`) and `commit:collections` (`revs=`),
  preserving `none` and `unknown`.

Phase 3 — documentation and tests

- Update `docs/debugging.md` §"Which collections did a write carry?" and §"Which revision did a read
  descend?": new fields, the cross-collection comparability exception for action ids, and the new
  decision-table row for "live refresh ran and the revision did not move".
- Extend the existing trace-pinning tests to cover both new fields, including the `none`/`unknown`
  cases.
- Run `yarn workspace @optimystic/quereus-plugin-optimystic test` and
  `yarn workspace @optimystic/db-core test`.
