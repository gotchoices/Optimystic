---
description: Test files still reach into a running node's internals through an untyped escape hatch instead of the properly typed handles the node now offers, so the pattern that previously caused a real bug is still sitting there for the next person to copy.
prereq:
files: packages/db-p2p/src/optimystic-node.ts, packages/db-p2p/test/real-libp2p.integration.spec.ts, packages/db-p2p/test/two-node-convergence.integration.spec.ts, packages/db-p2p/test/multi-coordinator-write.integration.spec.ts, packages/db-p2p/test/multi-coordinator-write-relay.integration.spec.ts, packages/db-p2p/test/multi-coordinator-cross-network-write.integration.spec.ts, packages/reference-peer/test/distributed-diary.spec.ts, packages/reference-peer/test/offline-storage.spec.ts, packages/reference-peer/test/quick-test.ts
difficulty: easy
tradeoffs: Every one of these reads is correct today and none can produce a wrong result, so this is purely about removing a bad example — a maintainer could reasonably say the type now exists and that is enough, and spend the time on behavior instead.
---

# Untyped reads of the node's attachment surface remain in the test tree

## What this is about

`createLibp2pNode` (in `packages/db-p2p`) returns a running node object with several useful
handles hung off it — the key network, the coordinated repo, the local storage repo, the node's
identity key. Until recently TypeScript did not know those handles existed, so every reader had
to defeat the type system to get at them, writing `(node as any).keyNetwork`.

That escape hatch caused a real defect: because reaching the node's *own* key network required
a cast while building a *brand new one* type-checked cleanly, several hosts built a new one — and
the new one selected a different-size group of peers, with the "does this peer belong to my
network?" check switched off. Ticket `bug-second-key-network-built-with-defaults` fixed that by
declaring the handles in a type (`OptimysticNodeAttachments` /
`OptimysticNode` in `packages/db-p2p/src/optimystic-node.ts`) that the node's return type now
carries, and converting every site that was building a duplicate.

What it did **not** do is convert the sites that merely *read* the handles. Measured with:

```
grep -rn "as any)\.\(keyNetwork\|coordinatedRepo\|storageRepo\|peerPrivateKey\|blockChangeNotifier\|reputation\|disputeService\)" packages/ --include=*.ts | wc -l
```

38 occurrences remain, all in test files, spread across the 8 files listed in `files:` above
(19 of them in `real-libp2p.integration.spec.ts` alone).

## Why it is worth doing

None of these 38 is wrong. They read the correct instance and behave correctly — this is not a
bug ticket. The cost is that they are the most-copied examples in the repo of how to get at a
node's internals, and what they demonstrate is the exact shape that produced the original defect:
switch the type system off, then reach for whatever you want. The next person wiring up a node
will copy one of them.

## What resolving this should establish

Two things, and the second is the point:

1. Those reads go through the typed surface — the local variable holding the node is typed
   `OptimysticNode` (or `Libp2p & Partial<OptimysticNodeAttachments>` where the node genuinely
   might not have been built by `createLibp2pNode`), and the casts come out.
2. **The pattern cannot come back silently.** After the conversion the grep above returns zero,
   so a cheap guard can hold it there — a lint rule, or a test that runs the grep and fails on a
   non-zero count. Without the guard this is a one-time tidy-up that decays; with it, the
   "reach past the type" shape is retired for this surface.

Note that some of these files hold the node in a variable typed `any` from a local helper, so a
few will need the helper's return type fixed rather than just the read site.

## Out of scope

`packages/db-p2p/src/libp2p-node-base.ts` also attaches a set of node-*internal* handles
(`spreadOnChurnMonitor`, `gcEligibleBlocks`, `rebalanceMonitor`, `blockTransferCoordinator`,
`ringShiftCoordinator`, `cohortTopicHost`, and the reactivity registries) through the same
untyped mechanism. Those are deliberately not part of the host-facing surface and typing them is
a separate decision — do not widen `OptimysticNodeAttachments` to cover them as part of this
ticket.
