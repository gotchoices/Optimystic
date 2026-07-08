description: Disputed transactions now pick their independent referees by spreading the picks unpredictably across the whole network — computed identically by every honest node — instead of grabbing the nodes sitting right next to the disputed data. Review that the new sampling is correct, deterministic, and honestly scoped.
prereq:
files:
  - packages/db-p2p/src/dispute/arbitrator-selection.ts (rewritten: sampleArbitrators + types)
  - packages/db-p2p/src/dispute/index.ts (export swap)
  - packages/db-p2p/src/dispute/dispute-service.ts (widened callback signature; round/epoch threading; computeEpochBytes)
  - packages/db-p2p/src/dispute/invalidation.ts (ArbitratorSetRecomputeContext +round/+epoch; construction seam)
  - packages/db-p2p/src/libp2p-node-base.ts (production selectArbitrators callback rewrite ~1051)
  - packages/db-p2p/test/dispute.spec.ts (sampleArbitrators describe block; threading test; widened mocks)
  - packages/db-core/src/log/struct.ts (DisputeResolutionProof.arbitratorSet doc comment)
  - docs/correctness.md (§7.1 Sybil; Theorems 7, 8, 10; Depends-on lines)
difficulty: medium
----

## What this ticket did

Replaced **concentric arbitrator selection** (sort peers by XOR distance to `hash(blockId)`, skip the cluster, take the next K) with **verifiable dispersed sampling**. The old scheme drew referees from exactly the neighborhood a locale-Sybil already had to own to capture the block's cluster — so "independent" arbitration recruited from the least-independent population (`docs/correctness.md` §7.1; Theorems 8, 10).

New core (`arbitrator-selection.ts`): for `i = 0, 1, 2, …`, hash `blockId ‖ u32le(round) ‖ epoch ‖ u32le(i)` to a ring coordinate and pick the peer nearest each coordinate. SHA-256 is uniform over the ring, so the `count` coordinates land spread across the whole keyspace → arbitrators are drawn from the whole population. Capturing them would need IDs near many independent random points (a fraction of the *entire* network), not one locale.

```ts
export type NearestResolver = (coord: Uint8Array, wants: number) => string[] | Promise<string[]>;
export type RingHashFn = (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;
export interface ArbitratorSamplingParams { blockId, round, epoch, count, exclude }   // see file for full types
export async function sampleArbitrators(params, nearest, hash): Promise<string[]>;
export function coordinatePreimage(blockId, round, epoch, i): Uint8Array;              // canonical encoding, exported for the golden vector
```

Two properties, both tested:
- **Deterministic & independently verifiable** — same `(blockId, round, epoch)` + same agreed membership ⇒ byte-identical ordered set on every honest node.
- **Unpredictable / not pre-positionable** — coordinates pinned only once real-time `round` and the agreed-membership `epoch` are fixed.

The core is pure and FRET-free. Production adapter (`libp2p-node-base.ts`) wires `nearest = fret.assembleCohort`, `hash = fret hashKey`, `exclude = original cluster ∪ self`, `round = 0`. Test adapter sorts a fixed `KnownPeer[]` by XOR distance.

## Build & test status

- `yarn workspace @optimystic/db-p2p build` → exit 0 (clean tsc).
- `yarn workspace @optimystic/db-p2p test` → **1198 passing, 36 pending, exit 0**.
- 7 new/rewritten tests in the `sampleArbitrators` describe block + service-threading test all pass.

## Use cases to validate (reviewer focus)

These are a **floor, not a ceiling** — treat the tests as a starting point.

- **Dispersion** — over 120 synthetic peers, sampled picks span the keyspace (max distance-rank to `hash(blockId)` > 50), and are not the concentric next-K the old function returned. ⚠️ This assertion is **statistical**, not structural: failure probability ≈ 0.395^15 ≈ 6e-7 per run (uniform draws all landing in the nearest ~50 ranks). Effectively deterministic but not literally so — if a reviewer wants zero flake, consider seeding peer IDs deterministically instead of `generateKeyPair()`.
- **Determinism + golden vector** — identical params → identical ordered result; `coordinatePreimage` byte layout pinned (`blockId ‖ u32le(round) ‖ epoch ‖ u32le(i)`, little-endian) via a hard-coded expected byte array AND a spy hash confirming `sampleArbitrators` hashes exactly that preimage for coordinate 0.
- **Round distinctness** — round 0 vs round 1 (caller excludes round-0 picks) are disjoint; changing `epoch` reshuffles.
- **Small-network fallback** — `cluster+1` membership → exactly 1 arbitrator; all-in-cluster → `[]`. No duplicates, no infinite loop. Termination proof: each coordinate either yields a fresh pick or (after widening `wants` to cover the whole eligible membership) proves global exhaustion; a stall guard (`cands.length <= prevLen`) covers a non-monotone/lying resolver.
- **Liveness replacement** — an excluded (offline) nearest pick is replaced by the *deterministic next-nearest* to the same coordinate, identical across independent computations — disputing parties cannot steer it.
- **Service threading** — `initiateDispute` passes `round = 0` and a non-empty `epoch` (interim hash of the agreed responsible set) to the callback.

## Known gaps / honest scope (reviewer: verify these are acceptable, not silently broken)

- **Multi-round is deferred to `design-dispute-synchronous-escalation`.** `round` is always 0 today. `sampleArbitrators` *supports* multi-round (fold `round` into every coordinate; caller accumulates prior picks into `exclude`), but nothing drives `round > 0` or a growing per-round `count` yet. The O(log N) geometric-widening story in Theorem 8 is thus partially aspirational — the *mechanism* (dispersed sampling) is in place, the *escalation loop* is not.
- **Interim epoch (tripwire, parked in code).** `epoch` is `computeEpochBytes` = SHA-256 of the sorted original-cluster peer-id set (the admission-gate-agreed responsible set). This is a stand-in for the real agreed membership epoch that `design-cluster-membership-agreement` will supply. Marked with `// NOTE:` at `dispute-service.ts` `initiateDispute` and on `computeEpochBytes`. Determinism holds only if all honest nodes resolve `nearest` over the *same* membership — that is the tie to membership-agreement; a divergent view yields a divergent draw.
- **Verify-path recompute seam (tripwire, parked in code).** `ArbitratorSetRecomputeContext` gains `round` (required) and `epoch?` (optional). At the single construction site in `verifyInvalidationCertificate` these are populated `round: 0` / `epoch` omitted, with a `// NOTE:` that a future `sampleArbitrators`-based recompute capability must thread the *real* `(round, epoch)` — which requires the proof to carry them (also `design-dispute-synchronous-escalation`). **No recompute capability is wired in production** (unchanged from before this ticket), so the default layer-1 + degradation behavior is untouched; all existing `invalidation.spec.ts` / `cluster-invalidation.spec.ts` recompute tests still pass because their callbacks ignore `round`/`epoch`. ⚠️ Reviewer note: if a recompute is ever wired *before* the proof carries real round/epoch, it would re-derive against `round:0`/empty-epoch and could false-reject — the optional `epoch` is meant to signal "not threaded yet → return `{feasible:false}`". Confirm that contract is honored when the capability lands.
- **`assembleCohort` returns "known" not "reachable" peers.** An unreachable pick still yields a well-defined, agreed set; the dispute round timeout (Theorem 8) absorbs non-response. We deliberately do **not** substitute a challenger-preferred peer for a silent one (that would reintroduce steerability).

## Review findings (tripwires noticed, parked — not tickets)

- Interim `epoch` derivation (`computeEpochBytes`, `dispute-service.ts`) and the `round:0`/omitted-`epoch` recompute seam (`invalidation.ts`) are both `// NOTE:`-tagged at their code sites; they become real work only when `design-cluster-membership-agreement` and `design-dispute-synchronous-escalation` land. Greppable via `grep -rn "// NOTE:" packages/db-p2p/src/dispute`.
- The dispersion test's spread assertion is statistical (~6e-7 flake bound); noted at the test site — becomes work only if CI ever flakes on it.
