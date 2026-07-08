description: The dispute/arbitration feature is fully built but switched off on every running node; comment-only annotations now mark the three switch-off points as deliberate — with why — so the next reader doesn't mistake dormancy for a forgotten wire-up.
prereq:
files:
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/src/repo/cluster-coordinator.ts
difficulty: easy
----

# Complete: annotate-dispute-subsystem-dormancy

## What was done

Added `[dispute-subsystem-dormant]`-tagged comments (comments only, no runtime change)
at the three sites where the dispute/arbitration subsystem is intentionally inert on
every live node:

1. **`libp2p-node-base.ts:555` — services map** (after the `fret:` factory, before the
   closing `})`): `disputeProtocolService` / `DisputeProtocolService` is intentionally
   NOT registered; the `/optimystic/<network>/dispute/1.0.0` handler is absent so no live
   node answers challenge/resolution.

2. **`libp2p-node-base.ts:1167` — DisputeService construction** (above the
   `if (options.dispute?.disputeEnabled)` block): construction is intentional (tests /
   `getDisputeStatus()`) but the service is unreachable live — no inbound handler,
   `onInvalidation` unset (so `maybeInvalidate` is a no-op), `revalidate` unset (so
   `handleChallenge` votes inconclusive).

3. **`cluster-coordinator.ts:339` — disputed-record path** (inside the
   `if (rejectionCount > 0 && approvalCount >= superMajority)` block): `initiateDispute()`
   is intentionally NOT called; evidence is computed and persisted but origination stays
   dormant behind the anchoring gate.

All three cross-reference the security gate
(`tickets/backlog/hardening/invalidation-live-wiring-requires-arbitrator-set-anchoring`)
and the live-activation plan (`tickets/backlog/feat-dispute-subsystem-live-activation`),
and share the grep marker `dispute-subsystem-dormant`.

## Review findings

Adversarial pass over the implement diff (`git show e4e60e7`), reading the code around
each site with fresh eyes before the handoff summary.

**Comment factual accuracy — CHECKED, all three verified against live code:**
- Site 1: `disputeProtocolService` appears only in comments in `libp2p-node-base.ts`
  (grep) — never in the `services` map. Claim accurate.
- Site 2: the `DisputeService` constructor call (`libp2p-node-base.ts:1179-1210`) passes
  `peerId, privateKey, peerNetwork, createDisputeClient, reputation, validator, config,
  selectArbitrators` — neither `onInvalidation` nor `revalidate`. Claim accurate.
  - `maybeInvalidate` (`dispute-service.ts:453-454`) returns early when `onInvalidation`
    is falsy → no-op. Claim accurate.
  - `handleChallenge` (`dispute-service.ts:244`): when `revalidate` is unset, `evidence`
    stays undefined and it returns a `'inconclusive'` vote (`dispute-service.ts:285-287`).
    Claim accurate.
- Site 3: `cluster-coordinator.ts:329-330` sets `disputed = true` + `disputeEvidence`,
  then `persistCoordinatorState` + `commitTransaction` (346-347) persist the record;
  `initiateDispute()` is never called on this path. Claim accurate.

**Comment placement — CHECKED:** all three anchored to stable code landmarks (service-map
object, the `disputeEnabled` block, the super-majority `if`), not raw line numbers, per the
implement ticket's explicit guidance. No stale line drift.

**Cross-references — CHECKED:** both referenced ticket files exist
(`tickets/backlog/hardening/invalidation-live-wiring-requires-arbitrator-set-anchoring.md`,
`tickets/backlog/feat-dispute-subsystem-live-activation.md`).

**Greppability — CHECKED:** `grep -r "dispute-subsystem-dormant" packages/db-p2p/src`
returns exactly 3 hits, as intended.

**Diff scope — CHECKED:** `git show e4e60e7` confirms the diff is comments only; no
non-comment line changed.

**Typecheck:** `npx tsc --noEmit` in `packages/db-p2p` exits 0.

**Tests / lint:** not run. The diff is provably comments-only (verified from the raw diff),
so no test or lint outcome can change; the passing typecheck already proves no code slipped
in. Running the full suite would add no signal and risks the idle-timeout on a zero-runtime
change. Deliberate skip, not silent.

**Major findings:** none. **Minor findings (fixed inline):** none needed. **Tripwires:**
none — annotation-only ticket introduces no conditional concern.
