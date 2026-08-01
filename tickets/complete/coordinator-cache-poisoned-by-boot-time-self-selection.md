---
description: A node used to lock onto itself as the handler for a piece of data when it made that choice while still alone at startup, and keep serving its own stale copy for half an hour afterwards. It now refuses to remember such a choice at all, and every path that can pick itself first checks the safety rule that says whether going it alone is allowed.
prereq:
files: packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/test/libp2p-key-network.spec.ts, packages/db-p2p/docs/cluster.md
difficulty: medium
---

# Complete: boot-time self-selection no longer poisons the coordinator cache

Shipped in `Libp2pKeyPeerNetwork` (`packages/db-p2p/src/libp2p-key-network.ts`).
Build clean, lint clean, `packages/db-p2p` **1450 passing / 41 pending / 0 failing**
(implement-stage handoff was 1448; the review pass replaced one test and added three).

## Vocabulary (for a reader without this session's context)

- **Coordinator** — the single peer chosen to drive a read/write for a given key.
- **Coordinator cache** — a 30-minute in-memory map from key → chosen coordinator,
  consulted *ahead of every selection tier*, so a cached entry fully short-circuits
  selection until it expires.
- **Self-coordination guard** — `shouldAllowSelfCoordination()`. Refuses to let a node act
  as its own coordinator when it has previously seen a larger network but is currently
  isolated, so a partitioned node cannot silently serve its own stale data.
- **FRET tier** — the first selection tier; picks from the key's nearest routing-table
  neighbors, a set that can include self. Then a **connected-peer fallback tier** (remote
  peers only) and a **last-resort self tier**.

## Final shape of the fix

Two rules, each enforced at exactly one site:

**1 — `recordCoordinator` ignores a self-valued write.** One gate at the single point where
anything enters the cache. Self is never memoized, from any writer, so a self entry cannot
exist to be read back.

**2 — the FRET tier consults the self-coordination guard before admitting self.** The
candidate filter runs excludes/bans first, then `connectedSet.has(id) || (id === selfStr &&
isSelfAdmissible())`. `isSelfAdmissible()` is a per-attempt memoized closure, evaluated
lazily (an all-remote neighborhood never pays `detectPartition()` /
`getNetworkSizeEstimate()`) and freshly per retry attempt (a connection can land during the
500ms inter-attempt sleep and legitimately flip the answer). On refusal self is *dropped*
from the candidate list, not thrown on — the connected-peer fallback still gets its chance,
and only if that also comes up empty does the last-resort tier raise
`SELF_COORDINATION_BLOCKED` with the accurate reason.

Rule 2 is the implement stage's change C, unchanged. Rule 1 **replaces** the implement
stage's changes A and B — see the first review finding.

## Review findings

### Major — fixed in this pass

**The fix was defeated on its own primary path; changes A and B did not close the hole
they were written for.** The implement stage gated the *FRET tier's* `recordCoordinator`
call (change A) and swept self entries out of the cache on `connection:open` (change B).
But `recordCoordinator` is public and its main caller is outside the class:
`NetworkTransactor` (`packages/db-core/src/transactor/network-transactor.ts:483-485`)
writes back `b.peerId` — whatever `findCoordinator` just returned — after every pend. When
that return value was self, the transactor immediately re-created the exact entry change A
had just declined to write.

Change B only partly covered this, because its trigger is a *new connection opening*. The
reachable residue:

- Node has a peer connected, but that peer is not yet selectable (its identity handshake is
  still in flight, so it classifies as `unknown` and the membership filter drops it).
- `findCoordinator` correctly falls through to the last-resort tier and returns self.
- The transactor writes self into the cache.
- The peer's handshake completes moments later. It is now a perfectly good coordinator —
  but it was *already connected*, so no `connection:open` fires and no sweep runs.
- The key stays pinned to this node's own replica for the full 30 minutes. That is the
  originally reported symptom, surviving the fix.

Worse, the cache tier is consulted *ahead* of every guard-checking tier, so a self entry
returns self **without** re-consulting `shouldAllowSelfCoordination()` — a wider bypass than
the FRET-tier one change C was written to close. A node that self-coordinated legitimately
while connected, then lost every peer, would serve its own data from cache indefinitely,
which is precisely what the guard exists to prevent.

Fixed by moving the rule to the single write point: `recordCoordinator` now ignores a
self-valued write. This covers every writer uniformly, and enforcing on *write* rather than
sweeping later means a self entry never exists to be read — closing the cache-tier guard
bypass by construction rather than by a second check. Changes A and B were removed as
redundant (net −45 lines of source), along with change B's tripwire, which described a scan
that no longer exists.

Verified by swapping the implement-stage source back in: the two new tests fail against it
(`6 passing, 2 failing`), pass against the fix.

### Major — filed as a ticket

**`NetworkManagerService.getCoordinator` is a second, unmaintained implementation of
coordinator selection** (`packages/db-p2p/src/network/network-manager-service.ts:357`). It
caches self unconditionally — the same defect this ticket fixed — and additionally has no
self-coordination guard, no network-membership scoping, and no retry window. It has **no
callers in this repo** (confirmed by grep; its sibling `getCluster` on the same class *is*
live via `src/repo/service.ts:219`, so the class cannot simply be deleted). Dormant rather
than reachable, so per the tripwire rule it is a `debt-` ticket, not a bug:
`tickets/backlog/debt-network-manager-coordinator-selection-is-a-stale-duplicate.md`.
Checked first that no open ticket already claims that file.

### Minor — fixed in this pass

- **`docs/cluster.md` overclaimed.** The *Self-Coordination Is Never Memoized* bullet
  described the purge-on-connect mechanism and asserted self picks are "never written",
  which was false while the transactor wrote them back. Rewritten to describe the write
  gate and to say *why* the gate sits at the write point rather than at each selection tier.
- **Comment bloat.** The implement stage added ~25 lines of comment for ~15 lines of code
  across three blocks, with the rationale restated in each and again in the doc. Condensed
  to the non-obvious parts; the redundant defensive block at the connected-peer fallback
  tier ("this tier can never yield self, hence no carve-out") lost the half that repeated
  the four lines directly above it.

### Checked, nothing found

- **Reputation sort direction.** `.sort((a,b) => getScore(a) - getScore(b))` is ascending
  and looked inverted. It is correct — `peer-reputation.ts` treats a *higher* score as
  worse (`isBanned` is `score >= ban`), so ascending is best-first. No change.
- **The `findCluster` path.** Always includes self in the cohort with no guard consult.
  Correct as-is: cohort membership is replication, not coordination, and a self-only cohort
  is the documented `allowClusterDownsize` path. Out of scope, unchanged.
- **Purge-loop mutation during `Map` iteration** (change B, now removed) — was safe in JS.
- **Cross-package fallout.** `db-core` 1282 passing / 0 failing;
  `quereus-plugin-optimystic` 328 passing / 11 pending / 0 failing — the failure the
  implement stage flagged as pre-existing was resolved by the runner's triage commit
  (`8b53841`), so `tickets/.pre-existing-error.md` is correctly absent. No new
  pre-existing failures surfaced.

### Tripwire parked in code

`NOTE:` at `isSelfAdmissible` in `findCoordinator`. On a small network self is a neighbor of
nearly every key, so the guard now runs on every `findCoordinator` call, and self-coordinated
keys are never cached to absorb the cost. Fine while `detectPartition()` /
`getNetworkSizeEstimate()` stay local FRET table reads; if either grows a network round-trip,
cache the decision with a short TTL on the instance instead of per attempt. (This replaces
the implement stage's tripwire, which described change B's cache scan and went away with it.)

## Tests

`describe('findCoordinator() — boot-time self-selection and cache')` in
`packages/db-p2p/test/libp2p-key-network.spec.ts`, using a local `createMutableMock` helper
(the shared `createMockLibp2p` closes over a fixed `connections` array; these tests need a
peer to arrive mid-test).

| Test | Pins | Origin |
|---|---|---|
| does not cache a boot-time self pick, so a peer connecting takes over the key | the end-to-end symptom | implement |
| writes no cache entry at all for a self pick | the no-cache rule directly | implement |
| ignores an externally-seeded self entry — recordCoordinator is the gate | rule 1 at the write point | review (replaces the change-B purge test) |
| reproduces the NetworkTransactor write-back: a self pick never survives to pin the key | the hole found this pass — peer becomes selectable with *no* `connection:open`, so a sweep-based fix cannot pass it | review |
| still caches a remote coordinator — the gate must not disable the cache | the gate refuses only self; a remote entry still short-circuits selection | review |
| honours the self-coordination guard on the FRET path | rule 2 — throws `SELF_COORDINATION_BLOCKED` | implement |
| drops self on the FRET path but still selects a connected peer rather than throwing | rule 2's fall-through, not fail-fast | implement |
| a genuinely solo node still self-coordinates on every call without entering the retry sleep | regression guard on not caching self (three lookups under 400ms) | implement |

Each failure-reproducing test was verified against the source it targets — the implement
stage's five against pre-fix `HEAD`, this pass's two against the implement-stage source. The
solo no-thrash and remote-still-cached tests are regression guards and pass both before and
after by design.

## Known gaps, honestly

- **No event-driven test of `connection:open`.** Was a gap at implement stage; now moot for
  this ticket — the fix no longer hangs anything off that event. `setupConnectionTracking()`
  → `updateNetworkObservations()` remains as untested as it was before this ticket.
- **No integration-level confirmation.** The originating reproduction lives in a different
  repo (`sereus`, scenario `control-cohort-three-node-isolation.integration.ts`) and was not
  run here. Whether that scenario is now stable is unverified from this side; the Sereus
  ticket `transactor-key-network-ignores-network-scoping` sits in that repo's `tickets/blocked/`
  waiting on this fix.
- **Stable-sort dependency.** The first test relies on `Array.prototype.sort` being stable
  (ES2019+) so equal-reputation candidates keep FRET's proximity order. True on Node's V8;
  the production selection order rests on the same property and predates this change.

## Reproduce locally

```
cd packages/db-p2p
yarn build && yarn test           # 1450 passing, 41 pending, 0 failing
yarn lint                         # from repo root; clean
```
