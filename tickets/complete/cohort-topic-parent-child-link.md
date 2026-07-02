description: A busy topic's deeper child cohort now formally registers with its parent — the parent authenticates the child, records it, and acks — replacing a placeholder that recorded nothing. Reviewed and completed.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/types.ts
  - packages/db-core/src/cohort-topic/wire/validate.ts
  - packages/db-core/src/cohort-topic/wire/codec.ts
  - packages/db-core/src/cohort-topic/sig/payloads.ts
  - packages/db-core/src/cohort-topic/traffic.ts (dormant max-of-siblings NOTE added in review)
  - packages/db-p2p/src/cohort-topic/host.ts
  - docs/cohort-topic.md (traffic-signal accuracy fix in review)
  - packages/db-core/test/cohort-topic/wire.spec.ts
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts
  - packages/db-p2p/test/cohort-topic/threshold-assembly.spec.ts
----

# Complete: cohort-topic parent-side child-cohort link frame + recording

## What shipped

A topic's cohort tree grows under load: a full cohort promotes and pushes new joiners one tier deeper into a
**child cohort**. Previously, when a fresh child cohort tried to tell its parent "record me as your child",
it sent a plain participant-register the parent treated as an ordinary join — the child was never recorded,
and the three consumers of the child count (demotion gate, gossip summary, traffic barometer) were hardcoded
to `0`.

This change adds a dedicated child-cohort-signed link frame (`ChildLinkV1`): the child threshold-signs it
over its own coord, the parent authenticates it, records the child in a per-cohort registry, and replies
`linked`. The child transitions `awaiting_parent → serving` only on that ack. The real child count now flows
into the demotion gate, gossip summary, and traffic snapshot. See the implement handoff for the full
mechanism; `docs/cohort-topic.md` §Cold-start instantiation + §Wire formats/Child link document it.

## Review findings

**Method.** Read the implement diff (`719b419`) with fresh eyes before the handoff summary. Scrutinized the
db-core wire layer, the sig payload, the db-p2p host dispatch + wiring, the `/sign` endorsement path, the
tests, and every doc paragraph the change touched. Rebuilt both packages and ran the full db-p2p suite +
db-core wire spec.

**Correctness / wire layer — no defects.** `ChildLinkV1` / `ChildLinkReplyV1` validators, decoders, and the
`childLinkSigningPayload` (`cohortEpoch` kept last) are sound. Confirmed the decode-and-branch in both entry
points is safe: `ChildLinkV1`, `RegisterV1`, and `RenewV1` are pairwise **structurally disjoint** —
`validateChildLinkV1` requires `childTier` (absent from register/renew), `validateRenewV1` requires
`participantId` (absent from child-link), `validateRegisterV1` requires `treeTier` — so the try-in-turn
ordering (renew → childlink → register on the direct dial; childlink → register on the FRET activity
handler) cannot mis-route a frame.

**Parent-side dispatch — no defects.** `dispatchChildLink` binds (recompute `coord_childTier == childCohort
Coord`, derive parent coord) *before* verifying, verifies the child cohort threshold sig against the child
cohort's cert with the same `PROMOTE_REFETCH_MIN_INTERVAL_MS` bounded-refetch as a promotion notice (no dial
amplification), records freshness-ordered + idempotent, then acks. Live-key rejects an unsigned link
(never a silent record); key-less is permissive, matching the existing `verifyRegisterSig` fallback. The
`/sign` `"childlink"` kind rides the generic tag+epoch-positional binding correctly (`SIGNABLE_IMAGE_TAG.
childlink = "ChildLinkV1"`, epoch read as the last image element).

**Anti-DoS scope — checked, acceptable (tripwire, not a ticket).** The child-link path does **not** flow
through `engine.handleRegister`, so it skips the register frame's PoW / replay / rate gate. This is
defensible: a child-link is cohort-threshold-authenticated (a strictly higher bar than an unauthenticated
participant register), replay is a freshness no-op, and refetch is bounded. Recorded as reasoning here; no
code change.

**Docs — one inaccuracy, fixed inline (minor).** `docs/cohort-topic.md` §Topic traffic signal claimed the
snapshot "still takes the max of siblings' gossiped counts as a floor, but the override is authoritative on
the recording member." That is wrong: `traffic.ts` computes `childOverride ?? maxOfSiblings`, and the wired
override (`childRegistry.count`) always returns a number — `0` included — so nullish-coalescing **never**
falls through to the gossiped max. The override is authoritative on *every* member (siblings read their own
`0`), and the max-of-siblings loop is dormant while the override is wired. Corrected the doc paragraph and
added a `NOTE:` tripwire at the `childOverride` site in `traffic.ts` so a future reader meets it. (This also
confirms the ticket's intended "siblings read 0 until the replication follow-on" behavior is what actually
happens.)

**Tests — adequate, extended none.** Coverage spans happy path (key-less link → record → serving), the count
feeding gossip + demotion gate, and pure-`dispatchChildLink` reject paths (coord mismatch, verify-false,
key-less permissive, live-key verified), plus wire round-trip/validation and the `/sign` childlink
endorsement. I judged this sufficient across happy/edge/error/regression without adding tests. Full db-p2p
suite: **1087 passing, 36 pending, 0 failing** (~47s). db-core wire spec: **73 passing**. Both packages
rebuild clean (`tsc` exit 0).

**Known gaps — all honestly documented, follow-on exists; no new tickets.** The headline limitations —
single-member recording (only the FRET-routed parent member records; siblings read `0`), no unlink (a parent
that has parented a child will not demote until the child set can shrink), and multi-node live-key links
often staying `awaiting_parent` (the routed member frequently cannot yet resolve the child cohort's cert) —
are all closed by `cohort-topic-child-link-replicate-unlink`, confirmed present in `implement/` with this
ticket as its prereq. The multi-node warnings (`child cohort signature not verified` / `coord mismatch`) are
the expected fire-and-forget cold-start retries; verified benign — full suite is 0-failing and the specs
assert forwarder behavior, not a successful multi-node link. The lenient length-check on `childParticipant
Coord`/`topicId` (vs. hard 32-byte on the genuine hash coords) is intentional and correctness-independent
(the coord-mismatch bind is the real gate). None of these warrant a new ticket — they are owned by the
prereq-chained follow-on.

**Major findings filed as new tickets:** none.

**Tripwires (parked, not tickets):**
- `NOTE:` at `createChildRegistry` in `host.ts` — single-member scope + "do not max-across-siblings"; points
  at the replication follow-on. (Pre-existing from implement.)
- `NOTE:` at the `childOverride` read in `traffic.ts` — the max-of-siblings loop is dormant while the
  registry override is wired; live again only if the override is unwired. (Added this review.)

## Out of scope (owned by `cohort-topic-child-link-replicate-unlink`, in `implement/`)

Cohort-wide replication of the child set (so every parent member converges, not only the FRET-routed one) and
the unlink on child demotion (so a parent releases a demoted child and can demote again).
