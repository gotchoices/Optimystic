description: Review comment-only annotations marking the dispute subsystem's deliberate dormancy at its three inertness sites.
prereq:
files:
  - packages/db-p2p/src/libp2p-node-base.ts
  - packages/db-p2p/src/repo/cluster-coordinator.ts
difficulty: easy
----

# Review: annotate-dispute-subsystem-dormancy

## What was done

Added `[dispute-subsystem-dormant]`-tagged comments at the three sites where the dispute/arbitration subsystem is intentionally inert on every live node:

1. **`libp2p-node-base.ts` — services map** (after the `fret:` entry, before the closing `})`)
   States that `disputeProtocolService` / `DisputeProtocolService` is intentionally NOT registered,
   why (arbitrator-set anchoring gate), and references both cross-cut tickets.

2. **`libp2p-node-base.ts` — DisputeService construction** (above `// Initialize dispute service if enabled`)
   States that construction is intentional (tests / `getDisputeStatus()`), but the service is
   unreachable live: no inbound handler, `onInvalidation` unset (so `maybeInvalidate` is a no-op),
   `revalidate` unset (so `handleChallenge` always votes inconclusive).

3. **`cluster-coordinator.ts` — disputed-record path** (inside the `if (rejectionCount > 0 && approvalCount >= superMajority)` block)
   States that `initiateDispute()` is intentionally NOT called — evidence is computed/persisted
   but origination stays dormant behind the same gate.

All three comments cross-reference:
- `tickets/backlog/hardening/invalidation-live-wiring-requires-arbitrator-set-anchoring`
- `tickets/backlog/feat-dispute-subsystem-live-activation`

The shared grep marker `dispute-subsystem-dormant` makes the dormant set discoverable as one group.

## Verification

- `npx tsc --noEmit` in `packages/db-p2p` passed clean.
- Diff is comments only — no runtime lines changed.

## Known gaps / reviewer checks

- Confirm the three comment texts accurately describe the code around them (no stale line-number
  drift since the ticket was written).
- Confirm the two cross-referenced ticket slugs still exist in `tickets/backlog/`.
- `grep -r "dispute-subsystem-dormant" packages/db-p2p/src` should return exactly 3 hits.

## Review findings

No tripwires introduced — this ticket is annotation-only.
