description: A captured "I'm leaving" or "I'm taking over" message for a cohort topic stays valid forever, so an attacker who records one can replay it later to delete a member's live registration or repeatedly disrupt it.
prereq:
files:
  - packages/db-core/src/cohort-topic/member-engine.ts        # handleRenew (~line 243) — privileged withdraw/reattach branch
  - packages/db-core/src/cohort-topic/registration/renewal.ts # ~305-381 — participant signature check
  - packages/db-p2p/src/cohort-topic/host.ts                  # resolveRenew ~1695-1703 — no CorrelationReplayGuard applied
  - packages/db-core/src/cohort-topic/antidos/replay-guard.ts # the guard the register path uses
difficulty: medium
----

# Renew path has no freshness or replay protection

## The problem

The register path runs privileged renews (`withdraw` → evict, `reattach` → primary re-stamp) through a
freshness/replay regime: it checks the timestamp skew window and records the correlation id in the
`CorrelationReplayGuard`. The **renew** path does not. `handleRenew` verifies the participant signature
on a `withdraw`/`reattach` renew but never checks `msg.timestamp`, and `resolveRenew` in db-p2p
(`host.ts:1695-1703`) never applies the replay guard.

Because these frames are signed but not time-bound, a captured signed `withdraw` tombstone is valid
forever: an attacker who records one can replay it *after* the victim re-registers, evicting the fresh
record and gossiping the eviction cohort-wide. A captured `reattach` can be replayed repeatedly to force
bogus primary re-stamps.

This is a gap opened by the withdraw tombstone mechanism (complete ticket
`cohort-topic-withdraw-tombstone`, which added the signed `withdraw` flag and verified the signature
binds the participant, but did not add freshness) — it is a new hole, not a regression of that ticket's
verified behavior.

## Expected behavior

A privileged renew (`withdraw`/`reattach`) that is stale or replayed must not take effect. Enforce the
same skew window the register path uses (reject when `|now − msg.timestamp| > maxAge`) and/or require
`msg.timestamp > rec.lastPing` monotonically before acting, and run the correlation id through the
replay guard so a captured frame cannot be re-applied.

## Repro sketch

- Register a participant; capture the signed `withdraw` renew it (or a test harness) emits.
- Let the record TTL-expire or the participant re-register.
- Replay the captured `withdraw` frame → observe the fresh record evicted and the eviction gossiped.
- With the fix, the stale/replayed frame is rejected and the live record survives.

Suggested-fix hint: reuse the register path's skew constant and `CorrelationReplayGuard` seam so the two
paths share one freshness regime rather than diverging again.
