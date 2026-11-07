description: Two machines that share a collection keep sending each other "anything newer?" requests every ten seconds while they read it, even when nothing has changed and they are already told about every change. On a phone behind a relay each request is a slow round trip, so idle apps keep both machines busy. Reads should learn that a collection is current from the signals that already prove it.
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-p2p/src/repo/coordinator-repo.ts (`shouldReadRepair`, `markBlocksSeen`, the held-block consult behind a locally served read), packages/db-p2p/src/cluster/cluster-policy.ts (`readRepairWindowMs`, `resolveReadRepairWindowMs`), packages/db-p2p/src/reactivity/collection-watch.ts (`ReactivityCollectionWatch`, `HELD_ONLY`), packages/db-core/src/network/struct.ts (`BlockGets.skipWindowConsult`), packages/db-core/src/collection/collection.ts (`Collection.readLogEnds`), packages/quereus-plugin-optimystic/src/optimystic-module.ts (`refreshLive`), docs/transactions.md, docs/internals.md
----

GitHub [#56](https://github.com/gotchoices/Optimystic/issues/56), the follow-up #43 left open. Reported against 1.24.0 with a Node repro on the in-process mesh (script in the issue).

## What happens

A node in a two-member cohort holds every block of a collection, co-signs every commit to it, and may be subscribed to its change notifications. Each read of a block more than `readRepairWindowMs` (10 s by default) after its last consult still starts a cohort consult behind the read (`shouldReadRepair`: elapsed time is the only input). The window restarts only after a consult or a cohort-commit apply (`markBlocksSeen`); a received change notification and the collection watch's verifying tick do not restart it. `BlockGets.skipWindowConsult` exists, but only the collection watch's own held-only ticks set it, never an ordinary read.

The reporter's measurements:

- Mesh repro, ten reads of unchanged data: reads 2 s apart cost 1 consult; reads 15 s apart cost 10; with `readRepairWindowMs = 300000` or `readRepairMode = 'off'`, 0.
- Taleus, two parties on one strand, Node, nothing changing: each re-read of one tally (18 SQL statements) cost about 82 block gets and 16 to 22 consult requests to the partner, one per table or index read.
- On phones, a party that restarts and re-reads every table kept its partner (a Galaxy S7) at 100% JavaScript for about 10 s serving consults over the relay.

## What to decide

The bound a reader gets today is in [transactions.md § Lazy read-repair window](../../docs/transactions.md#lazy-read-repair-window): a read may be up to one window behind the cohort. The reporter offers three directions, in order of reach:

1. **Freshness from signals that already prove it.** A delivered change notification, a verifying watch tick, or a catch-up from the peer marks the collection's header and tail seen; or a vtab read passes `skipWindowConsult` while the collection's watch is live and healthy.
2. **Consult per connection, not per elapsed time**, for a member that co-signs every commit. While the pair stays connected this node has seen every commit; what it can miss is a solo commit made while they were apart, which a consult on reconnection catches.
3. **At minimum, make the window settable from an embedder** — on the Optimystic side it already is (`clusterPolicy.readRepairWindowMs`); forwarding it from a Sereus strand is Sereus's change, outside this repository.

The plan has to say, for whichever direction it picks, what staleness bound replaces the window and how it degrades when the signal is lost (a dropped notification, a watch whose registration failed, a connection that flaps), since the window is also what repairs a copy that missed a commit nobody announced. It must also say which blocks the signal covers: a notification names a collection's tail, while a read touches the header, the tail and data blocks, and a table read touches several collections (the table and each index).

## Out of scope

Sereus forwarding `readRepairMode` / `readRepairWindowMs` through `strandClusterPolicy`; mention it in the plan's handoff so the maintainer can pass it on.
