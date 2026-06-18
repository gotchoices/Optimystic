description: A bookkeeping set inside the tail-rotation re-registration timer never forgets the tails it has already handled, so a very long-lived, very frequently-rotating subscription slowly accumulates memory that is never reclaimed.
prereq:
files: packages/db-p2p/src/reactivity/rotation-rereg-scheduler.ts, packages/db-p2p/test/reactivity/rotation-rereg-scheduler.spec.ts
difficulty: medium
----

# Bound the `RotationReRegistrationScheduler` de-dupe ledger (`seen`)

## Problem

`RotationReRegistrationScheduler` keeps two structures:

- `pending: Map<key, cancel>` — successors with a still-armed timer. Bounded (entries removed on fire/cancel/stop).
- `seen: Set<key>` — every successor `newTopicId` (base64url) **ever** scheduled, retained **across fires** so a
  late duplicate notice for an already-fired successor is a no-op.

`seen` is only pruned by `cancel(topicId)` (drops one), `cancel()` (drops all), and `stop()` (drops all). On the
normal path — schedule → fire — the key stays in `seen` **forever**. One scheduler is constructed per
subscription manager, and a subscription can be long-lived. Every tail rotation the subscription survives adds
one permanent entry. For a collection rotating once per ~64 min the growth is negligible (~22 keys/day), but a
very busy collection rotating every few seconds adds tens of thousands of small strings per day to a structure
that is never reclaimed while the subscription lives — a slow unbounded-growth leak.

## Why `seen` must persist across fires (do not just delete on fire)

The persistence is load-bearing, so a naive "delete on fire" is wrong:

- The manager's `rotationHandledFor` guard tracks only the **last** successor (a single value, not a set). After a
  chained `OLD→A→B`, it holds `B`; a late re-surface of the superseded `A` (e.g. a delayed `RotationRedirectError`)
  passes the manager guard (`A !== B`) and reaches the scheduler again.
- `seen` is what de-dupes that re-surface (and the redirect-vs-pre-announce race for the same successor). It must
  outlive the timer fire, so the fix is **bounding**, not removal.

## Suggested approaches (pick during planning)

- **Bounded LRU / ring** of recent keys (e.g. cap at a few hundred). The race window the ledger guards is short
  (near-simultaneous redirect + pre-announce, and not-yet-fired chained successors), so evicting the oldest keys
  is safe in practice — a re-surface that old would at worst cause one redundant (idempotent) re-register.
- **TTL eviction** keyed off `plan.fireAt` / a coarse clock (the scheduler already injects `now()`), dropping keys
  some multiple of `T_rejoin_jitter` past their fire time.
- Quantify first: confirm the realistic rotation cadence × subscription lifetime actually warrants the change
  before adding complexity; if typical deployments never rotate fast enough to matter, a documented cap with a
  generous bound (plus a `log()` when evicting) may be all that is needed.

## Acceptance

- `seen` (or its replacement) is provably bounded under unbounded rotations of a single long-lived scheduler.
- The existing de-dupe guarantees still hold: redirect-vs-pre-announce race for the same successor moves once;
  a re-surface of a recently-fired/superseded successor within the guard window is still a no-op.
- A regression test drives many (e.g. 10k) distinct successors through schedule→fire and asserts the ledger size
  stays within the bound.

## Context

Filed by the review of `12.53-reactivity-rotation-rereg-scheduler`. The scheduler itself is correct as shipped;
this is a scalability hardening for the high-frequency-rotation tail, not a correctness bug on the common path.
