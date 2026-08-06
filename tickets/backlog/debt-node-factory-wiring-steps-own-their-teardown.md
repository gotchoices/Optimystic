---
description: The function that builds a peer-to-peer node is one enormous block of setup code, and each piece of cleanup is registered by hand somewhere in it — so it is easy to add something that starts running and forget to make it stop. Restructure it so every setup step hands back its own cleanup, making that mistake impossible.
prereq:
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/startup-rollback.spec.ts
difficulty: hard
tradeoffs: This is a large, purely structural change to the single most load-bearing function in the package, with no user-visible behavior change and real regression risk in ordering-sensitive shutdown code — a maintainer could reasonably say the recently added rollback already contains the damage and spend the effort elsewhere.
---

# Node factory: wiring steps should own their own teardown

## The shape of the problem

`createLibp2pNodeBase` (`packages/db-p2p/src/libp2p-node-base.ts`) is **1283 lines in one function**
— lines 369–1651 of a 1651-line file (measured with `wc -l packages/db-p2p/src/libp2p-node-base.ts`
and `grep -n "^export async function createLibp2pNodeBase"`). It is the largest source file in the
package by a wide margin; the next is `libp2p-key-network.ts` at 990 lines.

About 930 of those lines run *after* `await node.start()`, against an already-running node. Each
long-lived resource created in that span (cluster-member timers, monitor loops, protocol handlers,
gossip drivers, event subscriptions) is released by a hand-written stop wrapper of this shape:

```ts
{
  const previousStop = node.stop.bind(node);
  node.stop = async () => {
    try { /* release this resource */ } finally { await previousStop(); }
  };
}
```

There are seven such wrappers. Nothing connects a wrapper to the resource it releases except
physical proximity in the file and a comment. Three consequences, all observed rather than
hypothesized:

- **A resource can be created with no wrapper at all** and nothing detects it — not the type
  checker, not a test.
- **A wrapper placed far from its resource silently narrows startup rollback.** The factory now
  stops the node if any post-start wiring step throws (see `test/startup-rollback.spec.ts`), but the
  rollback can only run wrappers that were already installed when the throw happened. Two wrappers
  had drifted hundreds of lines below their resources and had to be moved up by hand; finding them
  meant reading the whole span.
- **Shutdown ordering is implicit.** Wrappers run last-installed-first, so moving one line of
  wiring reorders teardown. Reviewing that reordering means re-reading 900 lines.

## What "done" looks like

Make "a resource without teardown" unrepresentable rather than reviewable. Each wiring step becomes
a small named function that takes what it needs and returns both its product and its own release
function — something along the lines of:

```ts
type WiringStep<T> = { value: T; stop?: () => Promise<void> | void };
```

The composition root then calls the steps in order, collects each `stop` into one ordered list, and
has exactly two consumers of that list:

- **normal shutdown** — run the list in reverse, then the node's own stop;
- **startup rollback** — run the same list in reverse over however many steps completed, then stop
  the node and rethrow the original error.

That collapses the seven bespoke `node.stop` wrappers into one mechanism, makes teardown order
explicit and readable in one place, and means a new wiring step cannot skip rollback: it either
returns a `stop` or it has nothing to release.

## Constraints worth preserving

- Teardown ordering is load-bearing in at least one place: reactivity timers and protocol handlers
  must be released before `host.stop()`, which must precede the transports closing.
- Several stop paths must stay idempotent — some monitors are also stopped by the libp2p service
  that owns them, so a double stop must not throw.
- The wiring blocks that deliberately swallow their own failures (spread, rebalance — "a resilience
  optimization must not hard-fail startup") must keep doing so; only the hard-failing steps reach
  rollback.
- `startup-rollback.spec.ts` is the behavioral pin for the rollback half and should stay green
  untouched.

## Not in scope

Changing what the node wires, what any service does, or the public `NodeOptions` surface. This is a
restructuring of how the factory is assembled, not of what it assembles.
