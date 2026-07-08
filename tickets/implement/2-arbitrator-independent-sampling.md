description: Right now, when a disputed transaction needs independent referees, the system picks the network nodes sitting right next to the disputed data — the very nodes an attacker who captured that data already owns. Replace that with picks spread unpredictably across the whole network, computed the same way by every honest node so nobody can rig it.
prereq:
files:
  - packages/db-p2p/src/dispute/arbitrator-selection.ts (the whole file — concentric selection to replace)
  - packages/db-p2p/src/dispute/dispute-service.ts (selectArbitrators callback type ~42; call site ~160-179)
  - packages/db-p2p/src/dispute/index.ts (selectArbitrators export ~17)
  - packages/db-p2p/src/dispute/invalidation.ts (ArbitratorSetRecomputeContext ~75-105 — re-derivation must match)
  - packages/db-p2p/src/libp2p-node-base.ts (production selectArbitrators wiring ~1050-1069)
  - packages/db-p2p/src/routing/responsibility.ts (sortPeersByDistance, xorDistanceBytes, KnownPeer)
  - packages/db-p2p/test/dispute.spec.ts (selectArbitrators describe block ~888-914; service mocks)
  - docs/correctness.md (§7.1 Sybil; Theorems 8 & 10)
difficulty: medium
----

## Problem

`arbitrator-selection.ts` (and the production copy of the same logic in `libp2p-node-base.ts:1050-1069`) selects arbitrators as the ring positions **immediately adjacent** to the disputed block: sort every peer by XOR distance to `hash(blockId)`, skip the original cluster, take the next K. This walks straight through the attacker's owned region. An attacker who placed node IDs near a block to capture its cluster (the Sybil vector `correctness.md` §7.1 openly admits) captures the next concentric ring for the same cost — so "independent" arbitration recruits from exactly the population that is *least* independent of the capture.

Geometric widening (Theorems 8, 10) only buys honest dilution if each wider sample draws from a **more representative** population. Concentric XOR-neighbors do the opposite: they exhaust the attacker's neighborhood first.

## What to build

Replace concentric selection with **verifiable dispersed sampling**: derive pseudo-random ring coordinates from `hash(blockId ‖ round ‖ epoch ‖ i)` and pick the peer nearest each coordinate. Because SHA-256 output is uniform over the ring, the `count` coordinates land spread across the whole keyspace, so the sampled arbitrators are drawn from the whole population rather than the block's neighborhood. To capture them an attacker would need IDs near many independent random points — i.e. a fraction of the *entire* network, not just one locale.

Two properties must both hold:

- **Deterministic & independently verifiable** — every honest node, given the same `(blockId, round, epoch)` and the same agreed membership, computes the *identical* arbitrator set. This is what lets the dispute's vote-verification path (`invalidation.ts` `ArbitratorSetRecompute`) re-derive the set instead of trusting the challenger's declared one, and lets honest nodes agree on who may vote.
- **Unpredictable / not pre-positionable** — the exact coordinates for round r are pinned only once `(blockId, round, epoch)` are all fixed. `round` advances in real time during the dispute; `epoch` is the *agreed membership epoch*, which rotates with membership and cannot be freely advanced by the attacker. So the attacker cannot know far enough ahead which coordinates to migrate IDs toward — and dispersion means even a known coordinate set demands global, not local, presence.

### Proposed interface

A pure, FRET-free, unit-testable core plus a thin production adapter. Keep the core independent of libp2p so `dispute.spec.ts` can drive it with a fixed peer array.

```ts
// arbitrator-selection.ts — replaces selectArbitrators

/** Resolve the peer-id strings nearest a ring coordinate, in ascending distance order.
 *  Production: FRET assembleCohort(coord, wants). Tests: sort a fixed KnownPeer[] by XOR distance. */
export type NearestResolver = (coord: Uint8Array, wants: number) => string[] | Promise<string[]>;

/** FRET-compatible ring hash of arbitrary bytes → coordinate (SHA-256; see RingHash.H). */
export type RingHashFn = (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;

export interface ArbitratorSamplingParams {
  /** Disputed block id bytes (messageHash fallback), as bound into the dispute. */
  readonly blockId: Uint8Array;
  /** Escalation round, 0-based. Round 0 is the first arbitration. */
  readonly round: number;
  /** Agreed membership epoch bytes. Pins the draw to an epoch the attacker cannot freely advance.
   *  Interim source (until design-cluster-membership-agreement lands): hash of the agreed
   *  responsible set the admission gate already converges on (cluster-membership-admission-gate). */
  readonly epoch: Uint8Array;
  /** Number of fresh, distinct arbitrators to draw this round. */
  readonly count: number;
  /** Peer-id strings to exclude: original cluster + self + arbitrators already drawn in prior rounds. */
  readonly exclude: ReadonlySet<string>;
}

/** Deterministic dispersed arbitrator draw. Returns up to `count` distinct peer-id strings; fewer
 *  only when the network is too small to yield that many (small-network fallback). */
export async function sampleArbitrators(
  params: ArbitratorSamplingParams,
  nearest: NearestResolver,
  hash: RingHashFn,
): Promise<string[]>;
```

Algorithm:

```
seen  = new Set(params.exclude)
picks = []
for i in 0 .. (some bounded ceiling ≥ count):
    if picks.length === count: break
    coord_i = hash( blockId ‖ u32le(round) ‖ epoch ‖ u32le(i) )
    // deterministic liveness/collision replacement: walk the ordering around coord_i,
    // skipping anyone already seen (excluded, or picked for an earlier coordinate).
    for cand in nearest(coord_i, wants):        // widen `wants` if the first slice is all seen
        if !seen.has(cand): picks.push(cand); seen.add(cand); break
    // if coord_i yields nobody new even after widening to the whole membership, that coordinate
    // is exhausted — move on; when every coordinate is exhausted, return the (short) picks.
return picks
```

`round`, `epoch`, and `i` are all folded into the hash so: (a) each round samples a *distinct* population (round changes every coordinate); (b) each of the `count` coordinates in a round is an independent uniform draw (dispersion); (c) replacement for an offline/duplicate pick is the *next* peer in the same coordinate's deterministic ordering — never a fresh challenger-chosen peer, so disputing parties cannot steer it.

### Production adapter (`libp2p-node-base.ts`)

Rewrite the inline `selectArbitrators` callback to call `sampleArbitrators` with:
- `nearest = (coord, wants) => fret.assembleCohort(coord, wants)` (already filters to known members),
- `hash = fretHashKey` (the `p2p-fret` `hashKey`, FRET-coord-compatible with `RingHash.H`),
- `exclude` = original cluster peers ∪ self,
- `round = 0` for now (ticket `design-dispute-synchronous-escalation` drives multi-round),
- `epoch` = interim agreed-epoch (see below).

### Service seam (`dispute-service.ts`)

Widen the `DisputeServiceInit.selectArbitrators` callback signature to carry `round` and `epoch`:

```ts
selectArbitrators: (blockId: string, excludePeers: string[], count: number,
                    round: number, epoch: Uint8Array) => Promise<PeerId[]>;
```

At the call site (`~160-179`) pass `round = 0` and an `epoch` derived from the agreed responsible set. **Interim epoch:** hash the sorted original-cluster peer-id set (the same set the admission gate already agrees on — `cluster-membership-admission-gate`, complete), e.g. reuse the `computeArbitratorSetHash`-style sorted-join-then-hash. Add a `// NOTE:` at this site that when `design-cluster-membership-agreement` lands, `epoch` becomes the agreed membership epoch rather than this locally-hashed stand-in.

### Verify-path consistency (`invalidation.ts`)

`ArbitratorSetRecomputeContext` (~75-105) is what a verifier feeds to re-derive the eligible set. Extend it with `round` and `epoch` so a re-derivation uses the *same* inputs as the original draw. The actual re-derivation wiring (supplying a `recomputeArbitratorSet` capability that calls `sampleArbitrators`) lands with `design-dispute-synchronous-escalation`; **here** just add the fields to the context type and document that the capability must call `sampleArbitrators` with them. Do not change the default layer-1/degradation behavior.

## Edge cases & interactions

- **Determinism vs. unpredictability** — the draw must be byte-identical across honest nodes yet not precomputable ahead of time. Test: same `(blockId, round, epoch)` → identical ordered set; differing `epoch` or `round` → different set. The `epoch`/`round` inputs must be pinned to values the attacker cannot freely advance (agreed membership epoch; real-time round), *not* a locally-chosen nonce.
- **Round progression** — each round samples a *distinct* population. Verify round r+1 shares no members with round r for the same block/epoch except by chance, and that the caller adds prior-round picks to `exclude` so accumulation across rounds stays disjoint. Later rounds may draw a larger `count` (geometric widening toward Theorem 8's O(log N)); each coordinate is still uniformly dispersed, so widening genuinely dilutes rather than walking a concentric ring.
- **Small / sparse networks** — when membership is smaller than `cluster + count`, coordinates collide and exhaust. Fallback returns the distinct live non-cluster peers available (fewer than `count`), never loops, never duplicates. In the degenerate all-peers-in-cluster case, returns `[]` (matches existing behavior). A tiny network cannot be Sybil-dispersed anyway, so degrading to "everyone else arbitrates" is acceptable and must be explicit.
- **Liveness / offline picks** — a coordinate's nearest peer may be offline. Replacement is the next peer in that coordinate's deterministic ordering (walk `nearest(coord, wants)` with growing `wants`), so every honest node computes the same replacement and the disputing parties cannot steer it. If production `assembleCohort` only returns "known" (not "reachable") peers, an unreachable pick still yields a well-defined, agreed set — the dispute round's timeout (Theorem 8) absorbs non-response; do not substitute a challenger-preferred peer for a silent one.
- **Membership-view divergence** — determinism holds only if all honest nodes resolve `nearest` over the *same* membership. This is the tie to `design-cluster-membership-agreement`: the `epoch` and the membership `nearest` reads from must be the agreed set, not a locally-divergent view. Interim stand-in (hash of the admission-gate-agreed responsible set) is documented as such and swapped when that ticket lands.
- **Verify-path recompute** — after the signature (`arbitratorSetSignature`) is checked, a verifier that re-derives the set must feed identical `(blockId, round, epoch)`; a mismatch means either tampering or a stale membership view. Adding `round`/`epoch` to `ArbitratorSetRecomputeContext` is the seam; leaving the default (no recompute capability) path unchanged keeps this ticket from entangling the layer-2 wiring.
- **Endianness / encoding of `round` and `i`** — fix a canonical encoding (u32 little-endian suggested) so two implementations hash identical bytes; assert it in a test with a golden vector.

## Tests (extend `dispute.spec.ts`)

- **Dispersion** — over a large synthetic membership, sampled coordinates/peers are spread across the keyspace, not clustered next to `hash(blockId)` (assert the picks are *not* the concentric next-K that the old function returned).
- **Determinism** — two calls with identical params yield identical ordered results; a golden-vector test pins the byte encoding.
- **Round distinctness** — round 0 vs round 1 (same block/epoch) yield disjoint sets when the caller excludes prior picks; changing `epoch` reshuffles.
- **Small-network fallback** — membership of `cluster + 1` yields exactly 1 arbitrator; all-in-cluster yields `[]`; no duplicates, no infinite loop.
- **Liveness replacement** — mark a coordinate's nearest peer as excluded/"offline"; the replacement is the deterministic next-nearest, identical across two independent computations.
- **Existing `selectArbitrators` describe block** (`~888-914`) — rewrite against the new `sampleArbitrators` signature; delete assertions that encode the concentric "next-K-by-distance" contract.
- Update the mock `selectArbitrators` callbacks in the service tests to the widened signature (accept and ignore `round`/`epoch`, or assert they are threaded).

## TODO

- Replace `arbitrator-selection.ts` with `sampleArbitrators` + `ArbitratorSamplingParams` + `NearestResolver`/`RingHashFn` types; remove the concentric `selectArbitrators`. Reuse `xorDistanceBytes`/`sortPeersByDistance` from `responsibility.ts` only inside the *test* `NearestResolver`.
- Update `dispute/index.ts` export (`selectArbitrators` → `sampleArbitrators`, plus the new types).
- Widen `DisputeServiceInit.selectArbitrators` signature (+`round`, +`epoch`); thread `round = 0` and the interim agreed-epoch hash at the `initiateDispute` call site; add the `// NOTE:` seam for the real membership epoch.
- Rewrite the production callback in `libp2p-node-base.ts` to call `sampleArbitrators` over `fret.assembleCohort` + `fretHashKey`, excluding cluster ∪ self.
- Add `round` and `epoch` to `ArbitratorSetRecomputeContext` in `invalidation.ts`; document that a recompute capability must call `sampleArbitrators` with them (wiring deferred to `design-dispute-synchronous-escalation`).
- Extend `dispute.spec.ts` per the Tests section; update service-mock callbacks to the new signature.
- Run `yarn workspace @optimystic/db-p2p build` and the db-p2p test suite (stream with `2>&1 | tee`); fix fallout. Confirm `sampleArbitrators` determinism/dispersion tests pass.
