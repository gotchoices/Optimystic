---
description: Fix the tier-sharding math so participants at depth ≥ 1 spread evenly across the ring instead of collapsing onto one coordinate, because the current input to the shard hash is a peer-id string whose leading bytes are identical for every node.
prereq:
files:
  - packages/db-core/src/cohort-topic/addressing.ts (coordD — the single place coord_d is computed; both routing and recompute flow through it)
  - packages/db-core/src/cohort-topic/ring-hash.ts (RingHash.H — the uniformizing transform to apply to P)
  - packages/db-core/test/cohort-topic/addressing.spec.ts (existing coord_d collision-rate spec; add equality + distribution tests here)
  - packages/db-core/src/cohort-topic/walk.ts (routes via addressing.coord(d, deps.self, topicId) at L207 — unchanged, inherits the transform)
  - packages/db-p2p/src/cohort-topic/host.ts (dispatchRegister recompute addressing.coord(reg.treeTier, participantCoord, topicId) at L960; parentCoord at L978/L1832; child-link recompute at L2134 — all unchanged, inherit the transform)
  - docs/cohort-topic.md (§Tier addressing L54-105; §Wire "Participant signature" note L1356-1369; the it.skip fan-test note L1209-1218)
difficulty: easy
---

# Make the `coord_d` shard key uniform without touching the verifiable signer id

## Background — what is already true

`cohort-topic-peer-key-signing` settled the *correctness* half of this: the wire field
`participantCoord` is `bytesToB64url(self)` where `self` is the participant's **dialable peer id**
(UTF-8 of the `12D3Koo…` peer-id string). The cohort verifies the participant's Ed25519 peer-key
signature by recovering the key from that string (`verifyPeerSig`), so `participantCoord` *must* stay
a recoverable peer id — do not change what goes on the wire.

Routing and recompute already agree for **all** tiers `d`, not just `d = 0`:

- The walk routes each probe at `addressing.coord(d, deps.self, topicId)` (`walk.ts:207`).
- The host recomputes the served coord at `addressing.coord(reg.treeTier, participantCoord, topicId)`
  (`host.ts:960`), where `participantCoord` decodes back to the identical `self` bytes.

Both call sites feed the **same** `P` bytes into the same `HashTierAddressing.coordD`. So whatever
transform we apply *inside* `coordD` is applied to both by construction — equality is preserved for
free, and we must **not** add a transform at the call sites (doing it in two places risks drift).

## The defect (dormant, gated before it can run)

`coord_d(P, topicId) = H(d ‖ prefix(P, d·log₂F) ‖ topicId)` for `d ≥ 1`. `prefix(P, n)` takes the `n`
most-significant bits of `P`. When `P` is a peer-id string, its high bytes are the near-constant
`12D3Koo…` shared by every Ed25519 node, so `prefix(P, d·log₂F)` barely varies between participants
and every participant's tier-`d` probe collapses onto ~one coordinate instead of fanning across the
`F^d` tier-`d` coords. `coord_0` ignores `P`, so the single-tier milestone is unaffected — this only
bites once a `d ≥ 1` cohort is ever served (multi-tier promotion is still open, so nothing regresses
today; this is the gate to fix before it does).

## Decision — hash `P` for the shard input only (Option A)

Change `coordD` so the value fed to `prefixBits` is the **ring-hash of `P`**, not raw `P`:

```
coord_0(_, topicId)  = H(0x00 ‖ topicId)                        (unchanged; P ignored)
coord_d(P, topicId)  = H(d ‖ prefix(H(P), d·log₂F) ‖ topicId)   for d ≥ 1
```

`H` is the injected `IRingHash` the class already holds (`this.hash`). At the default 256-bit ring,
`H(P)` is a full SHA-256 digest — uniformly distributed across participants — so `prefix(H(P), n)` is
uniform for every `n ≤ 256`. `coordD` already calls `this.hash.H(...)` for the outer hash; this adds
one inner `this.hash.H(peerId)` before `prefixBits`.

Why this over Option B (a separate signer wire field): a single value serves both roles cleanly.
`participantCoord` stays the recoverable peer id the signature verifies against; the shard input is
derived from it deterministically inside the addressing math. No new wire field, no codec/validate
change, no signature-coverage change.

**Why the transform belongs in `coordD` and nowhere else:** a grep confirms every `coord_d`
computation in the codebase flows through `addressing.coord(...)` → `coordD` — the walk's routing
key, the host's served-coord recompute, both `parentCoord` derivations (`host.ts:978`, `host.ts:1832`),
and the child-link recompute (`host.ts:2134`, over a *different* participant's `childParticipantCoord`,
which is likewise uniformized). Putting it in the one shared function keeps all of them consistent
automatically. Do not touch the call sites.

### Alignment with the simulator

The design simulator (`packages/substrate-simulator/.../topic-addressing.ts`) already feeds `coord_d`
a FRET **ring position** (`hashKey(peerId)`) as `P` — an already-uniform value — which is why its
collision test sees zero collisions and the fan invariant holds there. This change makes the real
db-core addressing match that assumption (uniform `P`), rather than the simulator matching a
peer-id-string `P` it never modeled. The simulator needs no change.

## Edge cases & interactions

- **`coord_0` must not change.** `coord0` ignores `P`; the transform lives only on the `coordD`
  path. Assert `coord(0, …)` output is byte-identical before/after (an existing collision-rate
  fixture already pins some `coord_0` values — keep them green).
- **Routing-vs-recompute equality at `d = 1`.** The primary acceptance test: the value the walk would
  route on (`coord(1, self, topicId)`) equals what the host recomputes from the wire
  (`coord(1, b64urlToBytes(participantCoord), topicId)` where `participantCoord = bytesToB64url(self)`).
  Equal by construction — test it explicitly at `d = 1` (and one `d ≥ 2`) so a future refactor that
  splits the transform to a call site fails loudly.
- **Distribution / property test.** Over many generated Ed25519 peer ids, `prefix(H(P), d·log₂F)` for
  `d = 1` (and `d = 2`) must spread across the `F^d` shard buckets — assert the observed distinct-shard
  count is close to the bucket count (or ≥ some sane fraction), and add a regression assertion that
  raw `prefix(P, …)` over the *peer-id-string* bytes collapses to ~1 bucket (documents the bug this
  fixes). Use fixed/seeded ids or a fixed set so the test is deterministic.
- **`parentCoord` consistency.** Both parent-coord derivations and the child-link recompute go through
  `coordD`, so a promoted child's self-routed `coord_d(childParticipantCoord, …)` still equals the
  parent's recompute of the same. No separate change; a `d = 1` parent/child recompute-equality assertion
  is cheap insurance.
- **Ring-width vs prefix length at large `d`.** `H(P)` is `ceil(ringBits/8)` bytes (32 at 256 bits);
  `prefixBits` left-pads if `d·log₂F` exceeds that — a degenerate case only at `d ≥ 65` with `F = 16`,
  far above any real `d_max`, and identical to the pre-existing behavior for raw `P`. No new failure
  mode; note it, don't guard it.
- **Determinism across nodes.** `H(P)` is a pure SHA-256 — same `P` yields the same coord on every
  node, so the walk/host/child-link parties agree without coordination. No clock, no randomness.

## Acceptance

- For `d ≥ 1`, the participant routing key and the host's recomputed served-coord input are provably
  equal — a db-core test at `d = 1` (already true structurally; the test locks it in).
- The value fed to `prefix(P, …)` is uniformly distributed across participants — a distribution/property
  test over many generated peer ids, with the peer-id-string-prefix collapse asserted as the negative
  control.
- The wire `participantCoord` is unchanged and still a value `verifyPeerSig` recovers an Ed25519 key
  from (no codec/signature change — assert nothing broke in an existing register-signature test).
- `docs/cohort-topic.md` §Tier addressing and the §Wire "Participant signature" note reflect the final
  formula `coord_d = H(d ‖ prefix(H(P), d·log₂F) ‖ topicId)` and drop the "documented follow-on" /
  "Tier-0 caveat" hedge (the residual is now resolved). The §Tier addressing implementation note should
  say `P` is ring-hashed before the prefix so the shard input is uniform while the wire keeps the
  recoverable peer id.
- The `it.skip(… claim-1 fan …)` note at `docs/cohort-topic.md:1209-1218` (and its live-tier
  counterpart, if the skip is asserted in a test) is updated: the fan no longer "awaits the
  routing-key/signer-id reconciliation" — that reconciliation is this ticket. Un-skipping the actual
  fan test is out of scope (it needs live multi-tier promotion, still open); just correct the note so it
  no longer points here as the blocker.

## TODO

- Edit `coordD` in `packages/db-core/src/cohort-topic/addressing.ts`: feed `prefixBits` the value
  `this.hash.H(peerId)` instead of `peerId`. Update the class/method doc-comment and the file header
  formula transcription to `H(d ‖ prefix(H(P), d·log₂F) ‖ topicId)`.
- Add to `packages/db-core/test/cohort-topic/addressing.spec.ts`:
  - a `coord_0` invariance assertion (P-independent; unchanged output),
  - a `d = 1` (and `d ≥ 2`) routing-vs-recompute equality test using the `self` ↔
    `bytesToB64url(self)` ↔ `b64urlToBytes(participantCoord)` round-trip,
  - a distribution/property test over many generated Ed25519 peer ids (`prefix(H(P), d·log₂F)` fans;
    raw peer-id-string prefix collapses — the negative control),
  - a `d = 1` parent/child recompute-equality assertion.
- Update `docs/cohort-topic.md`: §Tier addressing formula + implementation note (L54-105), the §Wire
  "Participant signature" note (L1356-1369, drop the Tier-0 caveat / follow-on hedge), and the
  `it.skip` fan-test note (L1209-1218, correct the blocker reference).
- Run `yarn workspace @optimystic/db-core test 2>&1 | tee /tmp/db-core-test.log` (stream it) and the
  db-core typecheck; confirm the existing collision-rate spec stays green.
