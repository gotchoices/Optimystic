description: When a busy topic grows a deeper cohort, that child now formally registers with its parent — the parent authenticates the child, records it, and acks — instead of the placeholder that recorded nothing. Ready for an adversarial review pass.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/types.ts (ChildLinkV1 + ChildLinkReplyV1; SignKind += "childlink"; CohortMessageV1 union)
  - packages/db-core/src/cohort-topic/wire/validate.ts (validateChildLinkV1 / validateChildLinkReplyV1; b64urlFixedLen; SIGN_KINDS += "childlink")
  - packages/db-core/src/cohort-topic/wire/codec.ts (decodeChildLinkV1 / decodeChildLinkReplyV1)
  - packages/db-core/src/cohort-topic/wire/index.ts (validator exports)
  - packages/db-core/src/cohort-topic/sig/payloads.ts (childLinkSigningPayload + ChildLinkSignable — cohortEpoch LAST)
  - packages/db-core/src/cohort-topic/coldstart.ts (ParentRegistrar doc: resolves only on a `linked` ack)
  - packages/db-p2p/src/cohort-topic/host.ts (registerForwarderWithParent builds+signs ChildLinkV1; dispatchChildLink; per-engine childRegistry; SIGNABLE_IMAGE_TAG.childlink; makeCoordSigner("childlink"); verifyChildLinkSig; childCohortCount wired into promotion + gossip + traffic; decode-and-branch at both register entry points)
  - packages/db-core/test/cohort-topic/wire.spec.ts (ChildLinkV1 round-trip / validation / signing payload)
  - packages/db-p2p/test/cohort-topic/host-antidos-coldstart.spec.ts (link+record integration; pure dispatchChildLink record/reject)
  - packages/db-p2p/test/cohort-topic/threshold-assembly.spec.ts (childlink /sign endorsement)
  - docs/cohort-topic.md (§Cold-start instantiation, §Topic traffic signal, §Wire formats + child-link section, §FRET integration notes)
difficulty: hard
----

# Review: cohort-topic parent-side child-cohort link frame + recording

## What shipped (plain-language)

A topic's cohort tree grows under load: a full cohort "promotes" and starts pushing new joiners one tier
deeper, into a **child cohort**. Until now, when a freshly-created child cohort tried to tell its parent
"I exist, count me as your child", it sent a plain participant-registration frame that the parent treated
as an ordinary join — the parent never actually **recorded** the child. Three places that need to know how
many children a cohort has (the demotion decision, the gossip summary, and the traffic barometer) were all
hardcoded to `0`.

This change replaces that placeholder with a **dedicated, child-cohort-signed link frame** (`ChildLinkV1`).
The child cohort threshold-signs it over its own coordinate; the parent authenticates it, records the child
in a small per-cohort registry, and replies with a `linked` acknowledgement. The child only considers itself
fully attached (transitions from `awaiting_parent` to `serving`) once it gets that `linked` reply. The real
child count now flows into the demotion gate, the gossip summary, and the traffic snapshot.

## Mechanism (for the reviewer)

**db-core wire layer.** New `ChildLinkV1` / `ChildLinkReplyV1` interfaces + `CohortMessageV1` union members;
`validateChildLinkV1(value, minSigs?)` / `validateChildLinkReplyV1`; typed decoders; a new `"childlink"`
`SignKind`; `childLinkSigningPayload` (a `Pick` of the signable fields, `cohortEpoch` kept **last** so the
`/sign` endorser reads the embedded epoch positionally, exactly as for promotion/demotion notices).

**db-p2p host.** The child engine gains a `makeCoordSigner("childlink")` signer (a sibling of the promotion
`noticeSigner`). `registerForwarderWithParent` now builds a `ChildLinkV1`, threshold-signs it (unsigned in
key-less interim), routes it to the parent coord via `routeAndAct`, decodes `ChildLinkReplyV1`, and resolves
**only on `result === "linked"`**. The exported pure function `dispatchChildLink(link, deps, now)` is the
parent side: (1) recompute-and-bind the parent/child coords, (2) verify the child cohort threshold sig
against the **child** cohort's cert (`verifyChildLinkSig`, permissive in key-less mode; a live parent rejects
an unsigned link), (3) record on a per-`CoordEngine` `childRegistry` (freshness-ordered, idempotent), (4) ack
`linked`. Both register entry points (the FRET activity handler and the direct-dial `register` handler) now
decode-and-branch (`ChildLinkV1` → `dispatchChildLink`, else renew/register as before). The real
`childRegistry.count(topicId)` is wired into `createPromotionLifecycle`, the gossip topic summary, and
`createTrafficCounters` (the three former `0`s).

## How to test / validate / use

Build + test commands actually run (all green):
- `packages/db-core`: `yarn build` (exit 0), `yarn test` → **1028 passing**.
- `packages/db-p2p`: `yarn build` (exit 0), `yarn test` → **1087 passing, 36 pending, 0 failing** (~45s).

Key behaviours a reviewer should exercise / re-derive:

1. **Happy path (key-less), the primary use case.** `host-antidos-coldstart.spec.ts` →
   "a tier-1 forwarder links to its tier-0 parent … flips to serving on the linked ack". A tier-1 child
   engine links, the routed parent engine records it, the child forwarder reaches `serving`, and the routed
   frame is a `ChildLinkV1` (not a `RegisterV1`) aimed at `coord_0(topic)` with `childTier === 1` and an
   empty `thresholdSig`. Confirms `parentEngine.childCohortCount(TOPIC) === 1` and the traffic snapshot reads
   1.
2. **Count wiring into gossip + demotion gate.** Same file → "the recorded child count feeds the parent
   gossip summary and the demotion gate resolver". Registers a direct participant at the parent so TOPIC is
   resident, links a child, drives a gossip round, and asserts the summary's `childCohortCount === 1`. (The
   demotion-gate resolver reads the same `childRegistry.count`.)
3. **Parent-side reject paths (pure `dispatchChildLink`).** Same file, "parent-side child-link dispatch
   (record + reject)": key-less-permissive records + acks `linked`; a **coord mismatch** (a
   `childParticipantCoord` that does not recompute to `childCohortCoord`) is `rejected` and records nothing;
   a **live-key forged/under-quorum sig** (verify → false) is `rejected` and records nothing; a live-key
   verified sig records.
4. **`/sign` `childlink` endorsement.** `threshold-assembly.spec.ts` → "…childlink endorsement (generic
   non-rotation path)": a matching image + current epoch from a cohort member is endorsed; a promotion image
   smuggled under `kind: "childlink"` (tag mismatch) and a forged embedded epoch are refused. Confirms the
   generic `handleSignRequest` path covers the new kind with no extra binding.
5. **Wire validation + signing payload.** `wire.spec.ts` → "ChildLinkV1 validation + signing payload":
   round-trip; rejects `childTier < 1`, a non-32-byte hash coord, out-of-range `tier`, and a non-empty
   `thresholdSig` with `signers.length < minSigs`; `childLinkSigningPayload` keeps `cohortEpoch` last and is
   invariant to the sig envelope.

## Known gaps / honest limitations (the reviewer should treat these as the starting line)

- **Single-member recording is the headline limitation.** FRET routes the child-link to **one** parent
  member, so only that member's `childRegistry` records the child; sibling parent members read `count == 0`.
  The demotion gate is therefore correct only on the recording member. This is **by design for this ticket**
  and is closed by the follow-on `cohort-topic-child-link-replicate-unlink` (already in `implement/`, with
  this ticket as its `prereq`), which gossip-replicates the child set so every parent member converges. A
  `NOTE:` at the `createChildRegistry` site spells out *why not to "fix" it with a max-across-siblings count*
  (the child set is sharded across parent members, so a max undercounts — a converged union is required).
- **No unlink yet.** A demoted child is never removed from the parent's registry in this ticket. Consequence:
  a parent that has recorded a child never sees the count drop, so **it will not demote once it has parented
  a child**. Acceptable intermediate; the unlink (demotion-notice-driven) is the same follow-on.
- **Multi-node live-key linking often stays `awaiting_parent`.** In the multi-node `live-tier` / scale specs
  you will see `console.warn` lines like *"cold-start: parent registration for tier-1 forwarder failed …
  child cohort signature not verified"* / *"coord mismatch"*. These are the **expected** fire-and-forget
  cold-start failures: the FRET-routed parent member frequently cannot yet resolve the child cohort's cert
  (single-member, cross-node), so the child-link verify fails and the forwarder correctly retries later. No
  test asserts a successful live-key multi-node link (that needs the replication follow-on); the tests
  tolerate `awaiting_parent`. **A reviewer should confirm these warnings are benign and not masking a
  weakened assertion** — I believe they are (0 failures; the forwarder behaviour is what the specs check),
  but this is the softest spot in the change.
- **`childParticipantCoord` / `topicId` are not length-checked to 32 bytes** in `validateChildLinkV1` (only
  the genuine hash fields `childCohortCoord` / `cohortEpoch` are). This deliberately matches the lenient
  `RegisterV1.participantCoord` convention — a participant coord is a multihash-encoded peer id in the test
  harness, not a raw 32-byte ring coord. If the reviewer expected the ticket's "32 bytes base64url" wording
  to be a hard validator gate on all four fields, note the divergence and the reason (it would reject the
  real peer-id-bytes the harness and the router already carry). Correctness does not depend on it — the
  coords are hashed by `addressing.coord`, and a wrong `childCohortCoord` is caught by the coord-mismatch
  bind.

## Tripwires (parked, not tickets)

- `NOTE:` at `createChildRegistry` in `host.ts` — single-member scope + "do not max-across-siblings"; points
  at `cohort-topic-child-link-replicate-unlink`. This is knowledge for whoever touches the registry next, not
  queued work here.

## Out of scope (owned by the `prereq`-chained follow-on `cohort-topic-child-link-replicate-unlink`)

Cohort-wide replication of the child set (so every parent member converges, not only the FRET-routed one) and
the **unlink** on child demotion (so a parent releases a demoted child and can demote again).
