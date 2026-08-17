RESOLVED — fixed directly rather than queued; see "Resolution" at the bottom. Kept in backlog only
until the next tending pass files it to complete/.

----
description: A saved snapshot of the peer table from before the FRET upgrade records "never measured this peer's speed" as the number zero. The upgraded FRET reads that same zero as "this peer answered instantly", so after upgrading, every remembered peer is briefly treated as the fastest peer on the network — skewing which peer we talk to first and which peers get evicted when the table is full.
prereq:
files:
  - packages/db-p2p/src/libp2p-key-network.ts (PersistedState.fretTable ~78; persistState writes it ~386; initFromPersistedState imports it ~289)
  - ../Fret/.release-notes.pending.md (breaking change 5 — `SerializedPeerEntry.avgLatencyMs` is now `number | null`)
difficulty: low
severity: degraded-behavior
likelihood: certain-on-upgrade
repro: not attempted
tradeoffs: Self-healing — the wrong scores wash out as soon as each peer's latency is actually measured, so a maintainer may reasonably decide a transient first-run skew is not worth a persistence format change. The competing fix (normalize at the import boundary with no version bump) is a one-liner but discards genuine 0 ms measurements too, which is exactly the localhost case FRET called out as its motivation.
----

# Persisted FRET table carries a latency sentinel that changed meaning

## What changed upstream

FRET 0.7.0 breaking change 5: `SerializedPeerEntry.avgLatencyMs` is now `number | null`, where
`null` means no round trip has ever been timed and scores neutrally. Previously `0` doubled as the
"no data" sentinel. FRET's stated reason for the change is that the old sentinel made a genuinely
fast peer — "localhost measures 0 ms on Windows' ~15 ms clock" — score *below* one measured at
300 ms.

FRET's migration note covers the field being **absent** from an older snapshot: that reads back as
`null`. It does not cover the field being **present and zero**, which is what a table exported by
0.6.0 actually contains.

## Why that reaches us

We are the ones holding those snapshots on disk. `libp2p-key-network.ts:386` stores
`fret.exportTable()` as `PersistedState.fretTable`, and `initFromPersistedState` (~289) hands it
straight back to `importTable` on the next start. So on the first run after upgrading FRET, every
peer written by the old version arrives claiming a 0 ms round trip.

Per the upstream note, relevance drives both next-hop preference and capacity eviction, so the
skew hits routing choice *and* which peers survive a full table. It is self-correcting once real
latencies are measured, but it is wrong at exactly the moment a restarting node is leaning hardest
on its remembered table.

Note the persisted envelope already carries `version: 1` (declared ~74, written ~379), so there is
a migration seam here and nothing currently uses it.

## Options

1. **Bump the envelope to `version: 2`; when loading a `version: 1` snapshot, rewrite
   `avgLatencyMs: 0` to `null` before import.** Precise: old zeros become "no data", new zeros stay
   genuine measurements. Costs a format bump and a load-side branch that has to be kept until
   version-1 snapshots are assumed gone.
2. **Normalize `0 → null` at the import boundary unconditionally, no version bump.** One line, no
   format change, but it also erases real 0 ms measurements written by 0.7.0 — reintroducing a
   milder form of the bug FRET just fixed.
3. **Do nothing and document it.** The skew is transient and self-healing.

Option 1 is the recommendation: the version stamp exists for this, and option 2 trades a
correctness bug for a smaller correctness bug.

## Why this is not already fixed

Raised during the FRET 0.7.0 adaptation pass immediately before a release. The other four breaking
changes were code-level and were resolved in that pass; this one changes the meaning of data
already on users' disks, so choosing among the options above — in particular whether to spend a
persistence version bump — is a maintainer's call, not an implementer's.

## Resolution

Maintainer's call: back-compat is not a constraint — this is a new system — so none of the three
options above were taken. All three were shaped around preserving old snapshots, which is work
nobody is owed.

Implemented instead: a **compatibility fence**. `PERSISTED_STATE_VERSION` is now `2`, and
`initFromPersistedState` discards any snapshot whose version differs rather than translating it.
Nothing survives the discard — not the FRET table, not the high-water mark — because a foreign
snapshot is cheap to replace (both are re-learned within a few stabilization ticks) and far cheaper
than reasoning about what an older FRET meant by any given field. No migration code exists to carry
forward, and the next incompatible change costs one integer.

Correction to this ticket's original framing, recorded because it understated the severity: the
skew is **not** merely transient.

- `relevance.ts:85` gives `avgLatencyMs === null` a 0.5 penalty but a stale `0` a penalty of **0** —
  the best possible score. Phantom peers therefore outrank every honestly measured peer, rather
  than merely looking acceptable.
- Recovery is an EMA at α=0.2, so a peer truly at 300 ms reads 60 ms after one ping, ~146 ms after
  three, and needs **~11 pings** to come within 10% of the truth.
- Relevance drives capacity eviction as well as next-hop preference, so a good peer evicted in
  favour of a phantom during that window does not come back. That part never self-heals.

Covered by `libp2p-key-network.spec.ts` — "discards a snapshot written by an older format instead
of importing it", which asserts the defaults survive rather than the persisted values, proving the
return happens ahead of both the FRET import and the isolated-session bump.

The open question about whether FRET's `importTable` accepts `null` on the way in is now moot: no
pre-2 table is ever handed to it.
