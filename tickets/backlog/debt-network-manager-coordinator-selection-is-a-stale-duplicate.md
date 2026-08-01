---
description: A second, older copy of the "which node should handle this key" logic still exists in the codebase. Nothing calls it today, but it is public API and it lacks the safety checks the maintained copy has, so anyone who starts using it would silently get the unsafe behavior.
prereq:
files: packages/db-p2p/src/network/network-manager-service.ts, packages/db-p2p/src/libp2p-key-network.ts
difficulty: medium
---

# `NetworkManagerService.getCoordinator` is an unmaintained second implementation of coordinator selection

## Background

Choosing which node drives a read/write for a given key ("the coordinator") is
implemented **twice** in `packages/db-p2p`:

- `Libp2pKeyPeerNetwork.findCoordinator` (`src/libp2p-key-network.ts`) — the maintained
  one. Everything in the product goes through it.
- `NetworkManagerService.getCoordinator` (`src/network/network-manager-service.ts`,
  ~line 357) — an older copy that has not tracked any of the fixes made to the first.

The second one has **no callers anywhere in this repository**. It is, however, exported
from the package index and reachable through the public `getNetworkManager(node)` helper,
so it is part of the published surface and an outside consumer could call it. Its sibling
`getCluster` on the same class *is* live (`src/repo/service.ts` uses it for redirect
checks) — so the class as a whole cannot simply be deleted, and the dead method is easy to
miss.

## What the copy is missing

Every one of these is a behavior the maintained implementation deliberately has:

- **No self-coordination guard.** `findCoordinator` refuses to let a node act as its own
  coordinator when it has previously seen a larger network and is currently cut off from
  it (`shouldAllowSelfCoordination()`), so a partitioned node cannot quietly serve its own
  out-of-date copy. `getCoordinator` has no equivalent check: it falls back to
  `libp2p.peerId` whenever the candidate list comes up empty, which is exactly the isolated
  case.
- **It memoizes a self choice.** `getCoordinator` unconditionally writes its pick into its
  own coordinator cache, including when the pick is this node. That is the defect fixed in
  the maintained copy by ticket `coordinator-cache-poisoned-by-boot-time-self-selection`:
  a choice made at startup, while the node is still alone, then pins the key to this node's
  own replica for the cache lifetime after real peers arrive. The two classes have separate
  caches, so the fix does not carry over.
- **No network-membership scoping.** When several networks share the same machines, the
  maintained copy only picks peers confirmed to serve *this* network's protocol.
  `getCoordinator` picks from whatever FRET returns.
- **No retry window.** The maintained copy retries a few times so a peer whose identity
  handshake is still in flight can become selectable. This one resolves once.

## Why this is debt and not a bug

Nothing calls it, so nothing is broken today. It is filed because a dormant duplicate of
safety-critical selection logic is a trap: the next person who needs "get me the
coordinator for this key" will find a public method with an inviting name and get none of
the protections, with no compile-time or test-time signal that anything is wrong. The two
implementations have already drifted by four separate fixes.

## What resolving this should establish

Pick one and make it true — the decision of *which* is part of the work:

- Remove `getCoordinator` (and `recordCoordinator`, which exists only to feed its cache)
  from `NetworkManagerService`, leaving `getCluster` and the rest of the service intact.
  This is the cheap option if the published surface can shed the method; check whether any
  consumer outside this repo calls it before committing to it.
- Or have `getCoordinator` delegate to the maintained implementation rather than
  re-deriving a pick, so there is one code path and one cache.

Either way the end state is: exactly one place in `db-p2p` decides who coordinates a key.
Whichever route is taken, a test should pin it, so a future re-divergence fails the suite
rather than sitting dormant again.
