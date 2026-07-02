description: When a busy topic grows a new deeper cohort, that child now formally registers itself with its parent cohort — the parent authenticates the child, records it, and acks — instead of the placeholder that never actually recorded anything.
prereq: cohort-topic-followon-derivation
files:
  - packages/db-core/src/cohort-topic/wire/types.ts (new ChildLinkV1 + ChildLinkReplyV1; SignKind += "childlink"; CohortMessageV1 union)
  - packages/db-core/src/cohort-topic/wire/validate.ts (validateChildLinkV1 / validateChildLinkReplyV1)
  - packages/db-core/src/cohort-topic/wire/codec.ts (decode branch, if the decoder enumerates types)
  - packages/db-core/src/cohort-topic/sig/payloads.ts (childLinkSigningPayload — cohortEpoch LAST)
  - packages/db-p2p/src/cohort-topic/host.ts (registerForwarderWithParent sends signed ChildLinkV1; dispatch branch → dispatchChildLink; per-CoordEngine child registry; wire the real childCohortCount into promotion + gossip summary + traffic; SIGNABLE_IMAGE_TAG; FretCohortThresholdCrypto kind; ChildLinkReplyV1 ack)
  - packages/db-core/src/cohort-topic/coldstart.ts (ParentRegistrar resolves only on a `linked` ack)
  - packages/db-core/src/cohort-topic/traffic.ts (childCohortCount override already supported — wired at host)
  - docs/cohort-topic.md (§Cold-start instantiation, §Topic traffic signal, §Wire formats)
difficulty: hard
----

# Cohort-topic: parent-side child-cohort link frame + recording

## Background (what exists today)

`cohort-topic-host-antidos-coldstart` built the cold-start parent-registration **transport** and
`cohort-topic-followon-derivation` completed the child *instantiation* path. What is still a placeholder
is the parent actually **recording** the child:

- A freshly cold-started tier-`d` (`d > 0`) forwarder calls `registerForwarderWithParent`
  (`host.ts:1166`), which routes a **plain `RegisterV1`** to its tier-`(d−1)` parent coord over
  `router.routeAndAct` and treats the round-trip resolution as the parent ack (flips
  `awaiting_parent → serving`). The parent treats that frame as an ordinary participant register — it
  does **not** record a child.
- The frame is **unsigned** (`signature: ""` at `host.ts:1180`): the forwarder cohort cannot sign as a
  participant peer, so a live parent's `verifyRegisterSig` gate rejects it (the child then stays
  `awaiting_parent` in live-key mode — see the followon complete ticket's parked items).
- `childCohortCount` is hardcoded `0` in three places: the promotion lifecycle wiring
  (`host.ts:1491`), the gossip topic summary (`host.ts:1608`), and (by omission) the traffic snapshot
  (`createTrafficCounters` at `host.ts:1486` passes no override).

This ticket replaces the interim participant-`RegisterV1` link with a **dedicated, child-cohort-signed
child-link frame**, has the routed parent member **verify and record** the child, and wires the real
per-topic child count into the promotion gate / gossip summary / traffic snapshot.

**Out of scope (the follow-on `cohort-topic-child-link-replicate-unlink`, which lists this ticket as
`prereq`):** cohort-wide replication of the child set across the parent cohort (so *every* parent member
converges, not only the FRET-routed one), and the **unlink** on child demotion. This ticket records the
child on the routed parent member and wires the count off that engine's local registry; the follow-on
makes the count correct cohort-wide and releases a demoted child. The `## Edge cases` section below is
explicit about what stays single-member here.

## Design

### The child-link frame (db-core wire)

A new request/response pair on the existing `register` protocol surface (the child reaches the parent
the same way a participant register does — `routeAndAct` to the parent coord — so it rides the same
routing discipline and gets a reply):

```ts
/** Child cohort → parent cohort: "I am the tier-d cohort at childCohortCoord; record me as your child." */
export interface ChildLinkV1 {
	v: 1;
	/** Topic id, 32 bytes, base64url. */
	topicId: string;
	/**
	 * The child cohort's served coord `coord_d(childParticipantCoord, topicId)`, 32 bytes base64url — the
	 * coord the parent verifies the threshold signature against (looks up the child cohort's MembershipCertV1).
	 */
	childCohortCoord: string;
	/**
	 * A representative participant coord in the child's prefix-shard (the seed the child engine was
	 * instantiated at). Lets the parent *deterministically bind the parent-child relationship*: the parent
	 * recomputes `coord_childTier(childParticipantCoord, topicId) == childCohortCoord` AND
	 * `coord_(childTier-1)(childParticipantCoord, topicId) == this parent's served coord`. Any participant
	 * sharing the child's `d·log₂F`-bit prefix yields the same pair, so it is a representative, not an
	 * identity. 32 bytes base64url.
	 */
	childParticipantCoord: string;
	/** Child tree tier `d` (always ≥ 1 — the root has no parent to link to). Parent serves `d − 1`. */
	childTier: number;
	/** Op capacity tier T0..T3 (stamped so a real parent validates the frame's tier). */
	tier: number;
	/** Unix ms; the parent's per-child freshness/ordering key (strictly-newer wins). */
	effectiveAt: number;
	/** Child cohort threshold signature over `childLinkSigningPayload`, base64url. Empty in key-less interim. */
	thresholdSig: string;
	/** Signing members' PeerIds, `≥ minSigs`, base64url. Empty in key-less interim. */
	signers: string[];
	/** Child cohort epoch, 32 bytes base64url (the epoch the threshold sig was collected under). */
	cohortEpoch: string;
}

/** Parent → child ack. `linked` flips the child `awaiting_parent → serving`; `rejected` keeps it awaiting. */
export interface ChildLinkReplyV1 {
	v: 1;
	result: "linked" | "rejected";
	/** Human-readable, optional. */
	reason?: string;
}
```

Add both to the `CohortMessageV1` union and to `validate.ts` (`validateChildLinkV1` enforces:
`childTier ≥ 1`, 32-byte coords, `tier` in 0..3, well-formed base64url on the byte fields; `signers`
length `≥ minSigs` **only** when `thresholdSig` is non-empty — key-less interim carries neither).

**Signing payload** (mirrors `promotionNoticeSigningPayload`; `cohortEpoch` **stays last** so the
`/sign` endorser reads the embedded epoch positionally as `image[image.length − 1]`):

```ts
export type ChildLinkSignable = Pick<ChildLinkV1,
	"topicId" | "childCohortCoord" | "childParticipantCoord" | "childTier" | "tier" | "effectiveAt" | "cohortEpoch">;

export function childLinkSigningPayload(n: ChildLinkSignable): Uint8Array {
	return utf8.encode(JSON.stringify(
		["ChildLinkV1", n.topicId, n.childCohortCoord, n.childParticipantCoord, n.childTier, n.tier, n.effectiveAt, n.cohortEpoch]));
}
```

### New SignKind `"childlink"` (db-p2p signing seam)

The child cohort threshold-signs the child-link exactly as it signs a promotion notice — over its **own
served coord** at its **current epoch**. Reuse the coord-signer machinery:

- `wire/types.ts`: `SignKind = "membership" | "promotion" | "demotion" | "rotation" | "childlink"`.
- `host.ts` `SIGNABLE_IMAGE_TAG`: add `childlink: "ChildLinkV1"`.
- `host.ts` `FretCohortThresholdCrypto`: a `kind: "childlink"` signer, produced by
  `makeCoordSigner("childlink")` on the **child** engine (a sibling of the existing `noticeSigner`).
- `handleSignRequest`: the generic non-`rotation` path already handles any kind via `SIGNABLE_IMAGE_TAG`
  + the last-element embedded-epoch check + the cohort-membership/epoch gate. A `childlink` request needs
  **no extra binding** beyond that (same shape as `promotion`/`demotion` — no per-topic view to bind).
  Confirm the generic path accepts it and add a test.

Signing is gated on the child host having a key (`canPublish`). **Key-less interim:** the child emits an
**unsigned** `ChildLinkV1` (`thresholdSig: ""`, `signers: []`); the parent's child-link verify is
permissive-in-key-less exactly like the existing `verifyRegisterSig` fallback (`permissive`/`deny`
pattern at `host.ts:1103`), so key-less unit tests still link + record. Live-key mode does the real
threshold verify.

### Parent-side dispatch + recording (db-p2p host)

The parent reaches this frame through the same two entry points a register uses — the FRET
`setActivityHandler` (`host.ts:920`) and the direct-dial `register` protocol handler (`host.ts:2237`).
Both currently decode-and-validate a `RegisterV1`. Introduce a **decode-and-branch**: a `ChildLinkV1`
routes to `dispatchChildLink`, everything else to the existing `dispatchRegister` / renew paths.

`dispatchChildLink(link, now) → ChildLinkReplyV1`:

1. **Recompute + bind the relationship.** `parentServedCoord = addressing.coord(childTier − 1,
   childParticipantCoord, topicId)`; reject (`rejected`, `reason: "coord mismatch"`) unless
   `addressing.coord(childTier, childParticipantCoord, topicId)` equals the signed `childCohortCoord`.
   This binds the child to a coord genuinely under this parent's prefix-shard — an attacker cannot point
   the link at an unrelated parent without also producing a `childParticipantCoord` that hashes to the
   signed child coord (which it cannot, absent the prefix-class membership).
2. **Resolve the parent engine** for `parentServedCoord` via `registry.forCoord(parentServedCoord,
   childTier − 1, childParticipantCoord)` — same pattern as `dispatchRegister` (`host.ts:900-901`).
3. **Verify** the child cohort threshold signature against the **child** cohort's cert:
   `verifier.verifyMessage(signers, childCohortCoord, childTier, childLinkSigningPayload(link), sig,
   { minRefetchIntervalMs: PROMOTE_REFETCH_MIN_INTERVAL_MS, now })` — identical to the notice verify at
   `host.ts:2049`. Key-less-permissive short-circuits this. A non-`verified` result → `rejected`.
4. **Record** on the parent engine: `engine.recordChild(topicId, childCohortCoord, effectiveAt)`.
5. Reply `{ v: 1, result: "linked" }`.

### Per-CoordEngine child registry (db-p2p host)

A small per-engine structure (the engine is per served coord = per parent cohort), holding the child set
for each topic this cohort parents:

```
childRegistry: Map<topicKey, Map<childCoordKey, { linked: boolean; lastEffectiveAt: number }>>
  recordChild(topicId, childCoord, effectiveAt): apply only if effectiveAt > lastEffectiveAt → linked = true
  count(topicId): number of entries with linked === true
  // unrecordChild(...) is added by the follow-on (unlink on demotion)
```

`recordChild` is idempotent (re-linking an already-linked coord is a no-op) and freshness-ordered per
child coord (a stale replay cannot flip a newer state) — mirroring `PromotionState.lastEffectiveAt`.

### Wire the real childCohortCount (replaces the three `0` placeholders)

- `createPromotionLifecycle({ …, childCohortCount: (topicId) => childRegistry.count(topicId) })` — replaces
  `() => 0` at `host.ts:1491`. This is the demotion gate input (`promotion.ts:324`).
- Gossip topic summary: `childCohortCount: childRegistry.count(topicId)` — replaces the hardcoded `0` at
  `host.ts:1608`.
- `createTrafficCounters({ …, childCohortCount: (topicId) => childRegistry.count(topicId) })` — `traffic.ts`
  already threads the override (`traffic.ts:85,139,145`); the host just supplies it.

### Cold-start ack (db-core `coldstart.ts` + db-p2p `registerForwarderWithParent`)

`registerForwarderWithParent` (`host.ts:1166`) now:
- Builds a `ChildLinkV1` (not a `RegisterV1`): `childCohortCoord = servedCoord` of the **child** engine,
  `childParticipantCoord = link.participantCoord`, `childTier = link.treeTier`, `tier = clampTier(opTier)`,
  `effectiveAt = Date.now()`, and the threshold sig from the child engine's `childlink` signer (empty
  key-less).
- Routes it: `const replyBytes = await router.routeAndAct(parentCoord, encode(frame), { wantK, minSigs })`
  (`routeAndAct` returns the encoded reply — `ports.ts:40`).
- Decodes `ChildLinkReplyV1`; **resolves only on `result === "linked"`**, else throws (the cold-start
  manager's existing `.catch` keeps the forwarder `awaiting_parent` for a later retry — `coldstart.ts:189`).

`ParentRegistrar.registerWithParent`'s contract is unchanged (`Promise<void>`, resolve = acked); only the
resolution condition tightens to a real `linked` ack. Update the `coldstart.ts` doc comment (it currently
describes the interim "resolution-is-ack").

## Edge cases & interactions

- **Key-less interim vs live-key.** Key-less child → unsigned link; parent permissive-accepts + records;
  child flips to `serving`. Live-key child → real threshold sig; parent verifies against the child cohort
  cert. Both paths must be unit-tested. A live-key parent receiving an **unsigned** link (misconfigured
  mixed mode) → `rejected` (not permissive), never a silent record.
- **Coord-mismatch / forged parent target.** A link whose `childParticipantCoord` does not recompute to
  both the signed `childCohortCoord` (step 1) and this parent's served coord → `rejected`, no record. Test
  with a deliberately mismatched `childParticipantCoord`.
- **Forged / under-quorum threshold sig (live-key).** `verifyMessage` returns non-`verified` → `rejected`,
  child stays `awaiting_parent`. Reuses the notice verifier's bounded-refetch (one `source.fetch()` per
  coord per `PROMOTE_REFETCH_MIN_INTERVAL_MS`) so a link flood cannot amplify into membership dials.
- **Replay / out-of-order link.** Two links for the same `childCohortCoord` with `effectiveAt` a ≤ b:
  applying b then a leaves `linked = true` at b's `lastEffectiveAt` (a is dropped). Idempotent re-link is a
  no-op — no double count.
- **`childTier` at the root boundary.** A `ChildLinkV1` with `childTier < 1` fails validation (the root
  never links). `dispatchChildLink` never runs for a tier-0 parent-of-nothing.
- **Single-member recording (documented gap, closed by the follow-on).** FRET routes the link to **one**
  parent member, so only that member's `childRegistry` records the child; sibling parent members read
  `count == 0`. Consequence this ticket accepts: the demotion gate is correct only on the recording member;
  a sibling could still originate a demotion (the demotion `/sign` endorsement gate does **not** check child
  count — that refinement is parked in `cohort-topic-sign-endorsement-hotcold-refinement`). The follow-on
  `cohort-topic-child-link-replicate-unlink` closes this by gossip-replicating the child set. Do **not**
  paper over it with a max-across-siblings count — the child set is sharded across parent members (different
  child coords route to different members), so a max undercounts; a converged union is required and is the
  follow-on's job. Leave a `NOTE:` at the `childRegistry` site pointing at the follow-on.
- **No unlink yet.** A child that demotes is **not** removed from the parent's registry in this ticket
  (`unrecordChild` + the demotion-notice-driven unlink are the follow-on). Consequence: within this ticket a
  parent that has recorded a child never sees the count drop, so it will not demote once it has parented a
  child. Acceptable intermediate — the follow-on lands the unlink and is `prereq`-chained. State this in the
  review handoff.
- **Idempotent instantiate / retry.** The cold-start manager is idempotent per topic (`coldstart.ts:177`);
  a retried `registerWithParent` sends a fresh `ChildLinkV1` (new `effectiveAt`, fresh `correlationId`
  concept N/A here). A duplicate link at the parent is absorbed by `recordChild` idempotency.
- **Traffic reply on a promoted parent.** A promoted parent replying `Promoted(d+1)` attaches
  `topicTraffic` whose `childCohortCount` now reflects the recording member's registry (was always `0`).
  On the recording member this is ≥ 1 after a child links; confirm the `promotedRedirectReply` traffic path
  surfaces it (`coldstart.ts:128` + `traffic.snapshot`).

## Key tests (TDD)

- **db-core** `sig/payloads.spec.ts`: `childLinkSigningPayload` round-trips deterministically; `cohortEpoch`
  is the last array element (guards the `/sign` positional read).
- **db-core** `wire/validate.spec.ts`: `validateChildLinkV1` accepts a well-formed frame; rejects
  `childTier < 1`, non-32-byte coords, out-of-range `tier`, and a non-empty `thresholdSig` with
  `signers.length < minSigs`.
- **db-p2p** `host` unit (extend the cold-start suite): a tier-1 child engine links to its tier-0 parent
  engine → parent `childRegistry.count(topic) == 1`, child forwarder phase `serving`, and the promotion
  lifecycle's `childCohortCount` resolver returns 1 (so `demotionTriggered` is blocked). Assert the
  gossip summary and `topicTraffic.childCohortCount` both read 1.
- **db-p2p** negative: coord-mismatch link → `rejected`, count stays 0, child stays `awaiting_parent`;
  live-key forged-sig link → `rejected`.
- **db-p2p** `handleSignRequest`: a `childlink` request from a cohort member with a matching
  `ChildLinkV1` image + current epoch is endorsed; a kind/tag mismatch or wrong embedded epoch is refused.

## TODO

- Add `ChildLinkV1` / `ChildLinkReplyV1` to `wire/types.ts` + `CohortMessageV1`; add validators in
  `wire/validate.ts`; extend the decode branch if `codec.ts` enumerates message types.
- Add `childLinkSigningPayload` (+ `ChildLinkSignable`) to `sig/payloads.ts`; keep `cohortEpoch` last.
- `SignKind += "childlink"`; `SIGNABLE_IMAGE_TAG.childlink = "ChildLinkV1"`; a `makeCoordSigner("childlink")`
  on the child engine; confirm `handleSignRequest`'s generic path covers it (+ test).
- Add the per-CoordEngine `childRegistry` (`recordChild` + `count`, freshness-ordered) with a `NOTE:`
  pointing at the replication follow-on.
- Rewrite `registerForwarderWithParent` to build + (child-)sign a `ChildLinkV1`, route it, decode the
  `ChildLinkReplyV1`, and resolve only on `linked`.
- Add `dispatchChildLink` and the decode-and-branch at both register entry points (activity handler +
  direct-dial handler).
- Wire the real `childCohortCount` into `createPromotionLifecycle`, the gossip topic summary, and
  `createTrafficCounters` (3 sites).
- Update `coldstart.ts` doc comment (resolution → real `linked` ack).
- Update `docs/cohort-topic.md` §Cold-start instantiation (the child-link frame + ack), §Topic traffic
  signal (childCohortCount now real on the recording member), §Wire formats (`ChildLinkV1` / reply).
- Run `packages/db-core` `yarn build` + `yarn test` and `packages/db-p2p` `yarn test 2>&1 | tee /tmp/dbp2p.log`;
  fix regressions from the interim-link change. Flag any pre-existing failure per the ticket rules.

## End
