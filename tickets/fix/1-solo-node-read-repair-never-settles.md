description: On a machine that is the only one responsible for a record, every read of that record starts a check against the other machines, finds there are none, does nothing, and never records that it checked — so the next read starts the same check again, forever. A phone founding its own database never finishes.
prereq:
files:
  - packages/db-p2p/src/repo/coordinator-repo.ts:933 (`fetchBlockFromCluster` — the solo short-circuit, the exit that does not arm the window)
  - packages/db-p2p/src/repo/coordinator-repo.ts:860 (`shouldReadRepair` — reads the window)
  - packages/db-p2p/src/repo/coordinator-repo.ts:881 (`markBlocksSeen` — arms it)
  - packages/db-p2p/src/repo/coordinator-repo.ts:671 (the read-repair loop in `get` that calls the above)
  - packages/db-p2p/test/coordinator-repo-read-repair-trust.spec.ts (existing read-repair coverage — the natural home for the regression test)
difficulty: medium
repro: verified
----

# A solo cohort's read-repair consults forever and never records that it ran

## The observable

Reported on [GitHub issue #8](https://github.com/gotchoices/Optimystic/issues/8) by an outside
consumer running a React Native app whose node is alone in its network. A cold `apply schema`
never finishes — measured at over 47 minutes for a 22-object schema against ~3 s on the older
stack, and reproducible on demand (~2 minutes to enter the loop, then indefinite).

Their instrumented capture is unusually clean. Commits are **not** the problem: 120 of them, all
finished inside the first ~2 minutes. What never stops is read-repair, cycling over a handful of
control-network blocks:

| 60 s window, deep into the run | `coordinator-repo` lines | distinct blockIds | commits |
|---|---|---|---|
| 14–15 min | 441 | 5 | 0 |
| 15–16 min | 535 | 8 | 2 |
| 16–17 min | 441 | 5 | 0 |

Whole run: **3,880 `cluster-tx:read-repair-triggered`, 3,879 `cluster-tx:read-repair-noop`** — every
single consult a no-op — across 9 distinct blockIds, each interleaved with
`cluster-fetch:solo-self-skip`. It never converges.

## The cause

`fetchBlockFromCluster` (`coordinator-repo.ts`) has three exits. Two of them call
`markBlocksSeen([blockId])`, which stamps `lastSeenCommitMs` and is the *only* thing that arms the
read-repair window:

- `cluster-fetch:local-current` — arms it.
- the normal end of the consult — arms it.
- **the solo short-circuit — does not.**

The solo short-circuit fires when `findCluster` returns exactly one peer and that peer is self.
It is correct to skip the fetch (there is no remote to sync from, and on a node with no listen
addresses dialling self can hang), but returning `{ absence: 'confirmed' }` without stamping the
block leaves `lastSeenCommitMs` unset. `shouldReadRepair` in `lazy` mode then reads
`lastSeen == null` and returns `true` — on this read, and on every read after it.

So the cycle is: read → window says stale → consult → solo skip → no-op → window still says stale.
Nothing in the loop can ever make progress, and nothing bounds it.

Note what the reporter's data already rules out: this is **not** the commit path, and it is not the
`pending conflict` / stranded-reservation defect (0 occurrences in their capture).

## Reproduction — verified

Against `CoordinatorRepo` directly, with a deterministic clock and no libp2p. The block exists
locally at rev 1 and never changes; the cohort is `['self-peer']`; `readRepairWindowMs` is the
10 s default. Nine reads, each 1 s apart — so reads 2–9 are all comfortably **inside** the window
and must not re-consult:

```js
const selfPeer = { toString: () => 'self-peer' };
const repo = new CoordinatorRepo(
  { findCluster: async () => ({ 'self-peer': {} }), findCoordinator: async () => selfPeer },
  () => ({}),
  { get: async () => ({ [BLOCK]: { state: { latest: { rev: 1, actionId: 'a1' } }, block: {} } }),
    commit: async () => ({ success: true }) },
  { readRepairMode: 'lazy', readRepairWindowMs: 10_000, readRepairSampleRate: 0 },
  undefined,
  selfPeer,
  undefined,
  async () => ({}),          // clusterLatestCallback — presence is what enables the repair path
);
repo.now = () => now;        // deterministic clock
repo.log = (tag, p) => log.push({ tag, ...p });
```

| | reads | `read-repair-triggered` | `read-repair-noop` | `solo-self-skip` |
|---|---|---|---|---|
| **at HEAD** | 9 | **9** | 9 | 9 |
| with `markBlocksSeen([blockId])` added to the solo exit | 9 | **1** | 1 | 1 |

The 1:1 trigger/no-op ratio at HEAD is the same ratio the reporter measured on device
(3,880 / 3,879), which is the evidence that the probe and the field report are the same defect.

**A caution for whoever writes the real test, because it cost this investigation a wrong answer
first:** do not advance the clock past `readRepairWindowMs` between reads. A lapsed window
*should* re-trigger — that is what lazy read-repair is for — so a probe that steps 60 s between
reads shows 9 triggers both before and after the fix and makes the fix look inert. The bug is only
visible on reads taken **inside** the window.

## What the fix has to decide

Adding `markBlocksSeen([blockId])` to the solo exit makes the probe settle, and is very likely
right: the short-circuit has *established* the block is as current as it can be — the node is the
only peer responsible for it — which is the same thing `cluster-fetch:local-current` concludes
before arming the window. But the implementer should confirm rather than assume:

- **Is `confirmed` the honest verdict to pair with arming?** The solo exit already returns
  `absence: 'confirmed'`. Arming the window says "checked recently"; both claims rest on the same
  premise (self is the whole cohort), so they should stand or fall together.
- **Does arming here suppress a repair that a later-joining peer should trigger?** When a second
  peer joins the cohort, `findCluster` stops returning a solo result, so the next read past the
  window takes the normal consult path. Worth a test: solo read, then a peer appears, then read
  again — the consult must happen.
- **`readRepairMode: 'paranoid'`** returns `true` unconditionally and so re-consults regardless.
  That is the documented meaning of the mode and should stay; the fix concerns `lazy` only.
- The reporter's loop rides on *control-network* blocks the node reads but never commits. Confirm
  the fix covers a block this node has never committed at all, not just one whose window lapsed.

## Why this was invisible until now

It needs a cohort of exactly one, which is self. A multi-node deployment always takes the consult
path and arms the window on the way out. The reporter's previous stack routed schema creation
through a local transactor that never entered the coordinated read path, so upgrading is what
exposed it — the defect is older than the report.

## TODO

- Reproduce with the probe above, as a spec beside the existing read-repair coverage.
- Arm the window on the solo exit; confirm the verdict/arming pairing above.
- Cover: a block never committed by this node; a peer joining after a solo read; `paranoid` mode
  still re-consulting.
- Check the sibling early return in `fetchBlockFromCluster` — `peerIds.length === 0` also returns
  `{ absence: 'confirmed' }` without arming. Same shape; decide whether it is the same bug. (An
  empty cohort is routing failure rather than a settled answer, so it may deliberately differ —
  say which, in a comment at the site.)
- Reply on issue #8 with what shipped.
