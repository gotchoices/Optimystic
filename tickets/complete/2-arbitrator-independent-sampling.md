description: Disputed transactions now pick their independent referees by spreading the picks unpredictably across the whole network — computed identically by every honest node — instead of grabbing the nodes sitting right next to the disputed data.
prereq:
files:
  - packages/db-p2p/src/dispute/arbitrator-selection.ts (sampleArbitrators + types; efficiency NOTE added)
  - packages/db-p2p/src/dispute/index.ts (export swap)
  - packages/db-p2p/src/dispute/dispute-service.ts (widened selectArbitrators signature; round/epoch threading; computeEpochBytes)
  - packages/db-p2p/src/dispute/invalidation.ts (ArbitratorSetRecomputeContext +round/+epoch seam)
  - packages/db-p2p/src/libp2p-node-base.ts (production selectArbitrators callback; self-exclusion determinism NOTE added)
  - packages/db-p2p/test/dispute.spec.ts (sampleArbitrators describe block; threading test)
  - packages/db-core/src/log/struct.ts (DisputeResolutionProof.arbitratorSet doc comment)
  - docs/correctness.md (§7.1 Sybil; Theorems 7, 8, 10)
  - docs/right-is-right.md (dispute walkthrough + §Durable Invalidation — updated in review)
----

# Verifiable dispersed arbitrator sampling

## What landed

Replaced **concentric arbitrator selection** (sort peers by XOR distance to `hash(blockId)`, skip the
cluster, take the next K) with **verifiable dispersed sampling**: for `i = 0, 1, 2, …` hash
`blockId ‖ u32le(round) ‖ epoch ‖ u32le(i)` to a ring coordinate and pick the peer nearest each
coordinate. SHA-256 is uniform over the ring, so the `count` coordinates land spread across the whole
keyspace → arbitrators are drawn from the whole population, not the disputed block's neighborhood. A
Sybil that captured one block's cluster no longer thereby owns its referees.

Core (`arbitrator-selection.ts`) is pure and FRET-free: `sampleArbitrators(params, nearest, hash)` plus
`coordinatePreimage(...)` (canonical little-endian encoding, exported for the golden vector). Production
adapter (`libp2p-node-base.ts`) wires `nearest = fret.assembleCohort`, `hash = fret hashKey`,
`exclude = original cluster ∪ self`, `round = 0`. `dispute-service.ts` threads `round = 0` and an
interim `epoch` (SHA-256 of the sorted responsible-peer set) into the widened callback.

Two properties, both tested: **deterministic & independently verifiable** (same `(blockId, round,
epoch)` + same membership ⇒ byte-identical ordered set) and **unpredictable / not pre-positionable**
(coordinates pinned only once real-time `round` and agreed-membership `epoch` are fixed).

Known scope (unchanged from implement handoff, verified acceptable): multi-round is deferred to
`design-dispute-synchronous-escalation` (`round` is always 0; the mechanism supports it, the escalation
loop does not); `epoch` is an interim stand-in until `design-cluster-membership-agreement`; no verify-path
recompute capability is wired in production, so the `ArbitratorSetRecomputeContext` `round`/`epoch` seam is
dormant.

## Review findings

Reviewed the full implement diff (`2c6c131`) with fresh eyes before the handoff, then scrutinized the
core algorithm, the production adapter, the verify-path seam, and every doc the change touched or should
have touched. Build + full suite re-run green.

**Correctness / algorithm — checked, no defects.** Walked `sampleArbitrators`'s widen-until-fresh loop
for termination and short-return behavior across small/exhausted/large membership: it never duplicates,
never loops, and returns short only on genuine exhaustion. The exhaustion detection (`cands.length <
wants || cands.length <= prevLen`) is sound, with the stall guard covering a capping/lying resolver.
Determinism holds given a deterministic, prefix-consistent `nearest` (the FRET `assembleCohort`
assumption is pre-existing, not introduced here).

**Tests — checked, adequate as a floor.** Dispersion, determinism, golden-vector (byte layout + spy
hash), round-distinctness, small-network fallback, and liveness-replacement all present and passing
(1198 passing, 36 pending). Untested minor paths (`count <= 0` early return; the capping-resolver stall
guard) are trivial/defensive — not worth a ticket.

**Docs — GAP FOUND and FIXED inline (minor).** The implement diff updated `docs/correctness.md`
thoroughly but never touched `docs/right-is-right.md`, which describes the *same* dispute mechanism and
still read as the old concentric selection in three places:
- line 70 ("D enlists the next K peers by FRET ring distance") — rewritten to dispersed sampling;
- line 72 ("escalates further to the next ring") — rewritten to "another dispersed sample from the whole population";
- line 184 ("selected via `selectArbitrators`") — updated to `sampleArbitrators` (dispersed sampling).

Also fixed the stale algorithm description in the future-recompute backlog ticket
`invalidation-live-wiring-requires-arbitrator-set-anchoring.md` (line 49 still said "re-derive … the way
`selectArbitrators` did (next-K … by XOR distance)"), so the eventual implementer is pointed at
`sampleArbitrators` + the `round`/`epoch` context, not the replaced algorithm.

**Major findings — none.** No new fix/plan/backlog tickets filed.

**Tripwires (parked in code, not tickets):**
- **Self-exclusion is node-relative** — the production adapter adds the local node's own id to `exclude`,
  which makes the draw node-specific. Cross-node determinism (the verifiable-recompute property) holds
  today only because the dissent coordinator is itself a cluster member, so `self` is already in
  `excludePeers` and the add is a no-op. A future verify-path recompute MUST reconstruct `exclude` from
  the *challenger's* identity (`proof.challengerPeerId`) + original cluster, never the verifier's own id.
  Recorded as a `// NOTE:` at `libp2p-node-base.ts` `selectArbitrators`.
- **`wants` starts conservative** — the widen loop seeds `wants = seen.size + 1` (one call proves
  exhaustion) rather than starting at 1 and widening on collision, so each coordinate asks `assembleCohort`
  for a large slice even in the common single-pick case. Correct, just not minimal; `// NOTE:` at the loop
  site in `arbitrator-selection.ts` — becomes work only if that resolver call shows up hot.
- **Dispersion test is statistical** (~6e-7 flake bound) and the interim `epoch` / dormant recompute seam
  are both already `// NOTE:`-tagged at their sites by the implementer (greppable via
  `grep -rn "// NOTE:" packages/db-p2p/src/dispute`). No action — noted here for the index.

## Build & test status

- `yarn workspace @optimystic/db-p2p build` → exit 0 (clean tsc, re-verified after the comment edits).
- `yarn workspace @optimystic/db-p2p test` → 1198 passing, 36 pending, exit 0.
