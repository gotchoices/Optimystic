----
description: When a node cannot fetch a collection's entry point, it silently creates a brand-new empty one instead of reporting a problem — so a temporary networking failure looks exactly like "this table has no rows", and the application believes it.
files: packages/db-core/src/collection/collection.ts (createOrOpen, lines 60-85), packages/db-core/src/collections/tree/tree.ts (createOrOpen)
difficulty: medium
----

# `createOrOpen` cannot distinguish "does not exist" from "could not be fetched"

Found while diagnosing a convergence failure for the Sereus embedder. It was not the root cause,
but it is why that failure took three investigation sessions: it converted a replication fault
into a silent, plausible-looking empty result.

## What happens

`Collection.createOrOpen` (`packages/db-core/src/collection/collection.ts:68-82`):

```ts
const header = await source.tryGet(id) as CollectionHeaderBlock | undefined;
if (header) { … } else {           // Collection does not exist
    const headerBlock = init.createHeaderBlock(id, tracker);
    tracker.insert(headerBlock); …
}
```

The comment asserts "Collection does not exist", but `tryGet` returning `undefined` has (at
least) two causes:

1. The collection genuinely has never been created.
2. The local node cannot currently retrieve the header — it has no local copy, no peer served
   it, or it holds an unmaterializable revision of it.

Case 2 is not hypothetical. In the reported trace, node B held revision 2 of the tree blocks
with no revision 1 to apply it to, so every read of the header returned absent. B therefore
**constructed a fresh empty collection in its tracker on every single query**, and the
application's membership check returned "no members" — indefinitely, with no error, no warning,
and no log line suggesting anything was wrong.

For a database that is meant to converge, "I couldn't reach the data, so here is an empty
table" is close to the worst available answer. An application cannot defend against it, because
it is indistinguishable from a legitimate empty result.

## What to decide

This is a semantics change, so it needs a maintainer's call rather than a patch.

- **Separate the operations.** `open` fails if the collection cannot be retrieved; `create`
  creates; `createOrOpen` keeps today's behavior but is only used where inventing a collection
  is genuinely correct (bootstrap paths). Most callers probably want `open`.
- **Distinguish absence from failure at the source layer.** Have `tryGet` (or a companion) report
  *why* it returned nothing — never-existed versus could-not-fetch — and only invent a collection
  for the former. Stronger, but requires the underlying repo layers to carry that distinction
  honestly, which they may not today; that investigation is part of this ticket.
- **At minimum, and regardless of the above**: log loudly when a collection is invented for a
  header that was expected to exist, so the next person sees it in one grep instead of three
  sessions.

Whichever is chosen, audit the existing call sites — `CollectionFactory.createOrGetCollection`
in `quereus-plugin-optimystic` is the important one — and say in the handoff which of them
actually want create-on-missing semantics. If the honest answer is "none of them in steady
state", that is a strong argument for the first option.

## Related

- `bug-member-commits-unmaterializable-revision` — the fault that this behavior masked.
