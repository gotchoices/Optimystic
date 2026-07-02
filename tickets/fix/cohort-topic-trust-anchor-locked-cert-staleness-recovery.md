description: After a node stops being responsible for part of the network and that part later changes its membership, the node can get permanently stuck distrusting it until the node restarts — it should be able to recover on its own.
prereq:
files:
  - packages/db-core/src/cohort-topic/membership/verifier.ts
  - packages/db-p2p/src/cohort-topic/host.ts (verifier construction ~L676; onCertPublished ~L645; publishAndCache ~L1208)
  - docs/cohort-topic.md (§Bootstrapping trust)
difficulty: medium
----

# Verifier-side recovery from a stale trust-locked cert

## Background

`cohort-topic-trust-anchor-core` added the trust gate to `CachingMembershipVerifier`. A cert becomes
**trusted** (and thus *trust-locks* its coord) when it passes via a trust root, a `"anchored"` direct
anchor, the attestation chain, or — critically — `verifier.cache()`. In db-p2p, `cache()` is invoked
from `onCertPublished` for **this node's own freshly-published cohort cert** (host.ts ~L645/L1208), so a
node that serves a coord and publishes its membership cert trust-locks that coord in its own verifier.

Once a coord is trust-locked, the **lock** semantics reject any un-anchored refetch for it (no silent
TOFU downgrade) — this is the intended behavior that gives the attestation chain its teeth.

## The gap

The trust-locked entry in `byCoord` lives for the **host's lifetime** and is only ever replaced by:
- a fresh self-publish (`cache()` overwrites with the new cert), or
- a successful trust path on refetch (`"anchored"` direct anchor, trust-root match, or a valid chain
  step from the *currently-cached* predecessor).

Consider a node that:
1. served coord `C`, self-published its cert (trust-locking `C` at epoch `Eₙ`), then
2. left/was demoted from `C`'s cohort (so it no longer self-publishes `C`, **and** its FRET direct
   anchor now returns `"unknown"` for `C` — it has no local authority there), and
3. later receives a message signed by `C`'s cohort at a **later** epoch `Eₙ₊ₖ`.

`verifyMessage` misses against the stale locked `Eₙ` cert and refetches the `Eₙ₊ₖ` cert. The refetch is
rejected unless it chains *directly* from the cached `Eₙ` predecessor. If the node **missed an
intermediate rotation** (the cached predecessor is at `Eₙ`, the refetched successor's `prevEpoch` is
`Eₙ₊ₖ₋₁ ≠ Eₙ`), `chainGrantsTrust` returns false, the coord is locked, and the cert is **rejected**. The
node is then stuck distrusting `C` — every message from `C` returns `untrusted` — until the **host
process restarts** (clearing `byCoord`).

This is a real behavior change vs. the pre-gate verifier, which would have TOFU-accepted the `Eₙ₊ₖ` cert
and recovered. It is **narrow** (former-member of a now-multiply-rotated cohort, anchor `"unknown"`,
chain gap) and **low-severity** (a liveness degradation, never a safety hole — a forgery is still
rejected), and it self-heals on restart. It is *not* closed by `cohort-topic-trust-anchor-fret-binding`
(that only anchors coords the node still has authority over) nor by
`cohort-topic-trust-anchor-rotation-production` (that produces attestations but does not repair a
verifier whose cached predecessor is on the wrong side of a chain gap).

## What to decide / specify

A recovery policy for a trust-locked cert that has gone demonstrably stale, without reopening the TOFU
downgrade the lock deliberately closes. Candidate directions (pick/refine during plan):

- **Bounded re-TOFU on a broken chain.** When the direct anchor is `"unknown"` **and** a refetched cert
  is self-consistent, carries a rotation attestation whose `prevEpoch ≠` the cached epoch (an explicit
  chain gap, not a forgery off the current predecessor), allow re-establishing TOFU after the cached
  cert has failed to verify the inbound message N consecutive times. Must not let a forged rotation off
  the *current* trusted predecessor slip through (that path stays rejected).
- **Eviction on staleness.** Drop a locked cert (back to "no trusted cert" → TOFU-eligible) after it has
  been the cause of M consecutive refetch-rejects for live inbound traffic, optionally gated on
  `stabilizedAt` age.
- **Drop the lock on demotion.** Have the host explicitly evict/downgrade a coord's verifier entry when
  it stops serving that coord, so a former-member coord is never permanently locked. (Needs a verifier
  API to forget/downgrade a coord; today `MembershipVerifier` exposes only `cache()` + `verifyMessage`.)

Whichever is chosen, preserve the headline invariant: an un-anchored cert for a coord with a **valid,
matching** trusted predecessor is still rejected, and a `"rejected"` direct-anchor verdict is still
fatal. Add tests covering: (a) stuck-lock after a missed intermediate rotation recovers, (b) a forged
rotation off the current trusted predecessor is still rejected during/after recovery.
