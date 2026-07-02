description: A node that helps run several groups for the same topic could apply a "grow" or "shrink" decision to the wrong group, or silently drop a valid one, because the message never said which group it was for. The message now carries the group's address, protected by the same signature, and is delivered by that address.
prereq:
files:
  - packages/db-core/src/cohort-topic/wire/types.ts (PromotionNoticeV1 / DemotionNoticeV1 — new cohortCoord field)
  - packages/db-core/src/cohort-topic/wire/validate.ts (validate cohortCoord on both notices)
  - packages/db-core/src/cohort-topic/sig/payloads.ts (cohortCoord folded into both signing images; kept cohortEpoch LAST)
  - packages/db-core/src/cohort-topic/promotion.ts (PromotionDeps.cohortCoord; promote()/demote() stamp it)
  - packages/db-p2p/src/cohort-topic/host.ts (createCoordEngine wires cohortCoord; handleInboundNotice routes by findByCoord; per-coord high-water; NOTE at broadcast + at the /sign endorser epoch read)
  - packages/db-core/test/cohort-topic/{wire,promotion}.spec.ts
  - packages/db-p2p/test/cohort-topic/{promote-notice,live-tier,threshold-assembly,service}.spec.ts
  - docs/cohort-topic.md (§Promotion pipeline; §Wire formats)
difficulty: hard
----

# Review: carry the served coord on promotion/demotion notices so a multi-cohort node routes them to the right engine

## Plain-language summary

A cohort is the small group of nodes that jointly forward a topic at one point in the tree. When a cohort
decides to grow (promote) or shrink (demote), it threshold-signs a notice and broadcasts it so sibling
members and interested nodes adopt the same state. That notice used to identify itself only by
`(topicId, tier)` — **not** by the specific cohort. At tree depth `d ≥ 1` one physical node can belong to
several different cohorts for the *same* `(topic, tier)` (each cohort sits at its own "served coord"
`coord_d(participantCoord, topicId)`, with its own membership cert and its own promotion state). Given only
`(topic, tier)`, the inbound handler picked the **first** engine that matched and verified the signature
against **that** cohort's cert — so it could adopt into the wrong cohort, or (when the two cohorts' member
sets overlap but differ) fail the signature check and silently drop a valid notice. A second bug shared the
same root: the replay high-water was keyed by `(topic, tier)`, so two sibling cohorts on one node shared one
water and one cohort's notice could stale-drop the other's.

This is **latent**, not a live regression: multi-cohort / multi-tier serving is not functional yet (siblings
`cohort-topic-followon-derivation`, `cohort-topic-participant-coord-routing-key-mismatch`), every shipped
test drives one cohort at one coord, and no nodes speak this protocol yet (pre-release). So this is a **gate
for multi-cohort promotion**, implemented as a hard, coordinated wire+signature change with no version
negotiation.

## What was implemented

1. **Wire field `cohortCoord`** (32-byte base64url) added to `PromotionNoticeV1` and `DemotionNoticeV1`
   (`wire/types.ts`), validated in both validators (`wire/validate.ts`). It is the served coord the deciding
   cohort sits at — the same value as `MembershipCertV1.cohortCoord` / the verifier's `expectedCoord`.

2. **Covered by the signature.** `cohortCoord` is folded into both threshold-signing images
   (`sig/payloads.ts`), so rewriting it to hijack a sibling breaks verification. **Important, non-obvious
   detail:** it is inserted *just before the trailing `cohortEpoch`*, deliberately **keeping `cohortEpoch`
   the last array element**, because the `/sign` endorsement policy (`handleSignRequest`, host.ts) reads a
   notice's embedded epoch positionally as `image[image.length - 1]`. (My first cut appended `cohortCoord`
   last — that displaced the epoch, so every endorser refused with "epoch mismatch", the threshold-sign
   round failed, and promotion never completed. Five e2e tests caught it; the fix was to keep epoch last. A
   `NOTE:` now guards both sides of this coupling.)

3. **Producer** — `PromotionDeps` gained `cohortCoord: () => Uint8Array` (`promotion.ts`); `promote()` /
   `demote()` stamp it onto the signable and the returned notice. In the host, `createCoordEngine` wires
   `cohortCoord: () => servedCoord`.

4. **Receiver routes by the signed coord** — `handleInboundNotice` (host.ts) resolves the target with
   `registry.findByCoord(b64urlToBytes(inbound.notice.cohortCoord))` instead of the old first-match
   `findServing(topicId, tier)` scan. The replay high-water is now keyed `` `${cohortCoord}|${tier}` ``
   (coord uniquely identifies the cohort; tier retained only for readability).

5. **Docs** — `docs/cohort-topic.md` §Promotion pipeline reworded (`decode → rate limit → resolve engine by
   carried cohortCoord → high-water → verify+apply`) and `cohortCoord` added to both §Wire-format notice
   field lists.

## Deviation from the ticket — `findServing` was NOT removed (please sanity-check this call)

The ticket's file list and TODO said `CoordRegistry.findServing` "becomes unused" and should be removed. **It
is not unused** — there are two genuine production callers unrelated to notice routing:
- `packages/db-p2p/src/matchmaking/query-transport.ts:147` — `findServing(topicId, 0)` resolves the serving
  tier-0 engine for a matchmaking query.
- `packages/db-p2p/src/libp2p-node-base.ts:1086` — `findServing(topicId, REACTIVITY_FORWARDER_TREE_TIER)`
  for the reactivity direct-subscriber lookup.

Removing it would break the build, so I **kept** `findServing` and only removed the notice path's dependency
on it. Its interface doc-comment was rewritten to (a) name the real remaining callers and (b) spell out the
first-match caveat: those two are tier-0 read paths that will have the same multi-cohort ambiguity someday,
which is owned by `cohort-topic-followon-derivation` — out of scope here. The "first-match trap cannot be
reintroduced" goal is met for the *notice* path (it no longer calls `findServing`); the two readers keep it.
If the reviewer disagrees, the alternative is a follow-on ticket to give those readers a coord-precise lookup
— I did not file one because they are correct at the current single-cohort/tier-0 milestone.

## How to validate

Build + tests are green as of this handoff:
- `yarn workspace @optimystic/db-core build` and `yarn workspace @optimystic/db-p2p build` — both clean (tsc).
- db-core: `yarn workspace @optimystic/db-core test` → **998 passing**.
- db-p2p: `yarn workspace @optimystic/db-p2p test` → **1077 passing / 37 pending / 0 failing**.
  (The one `parent unreachable` line in the db-p2p run is an expected `log()` from
  `host-antidos-coldstart.spec.ts`'s deliberate-unreachable test, not a failure.)

### Key test cases to exercise / scrutinize (new + changed)

- **Two-cohort disambiguation** (`promote-notice.spec.ts`, "routes a notice to the engine for its carried
  coord…"): two `NoticeApplyTarget`s at distinct coords for the same `(topic, tier)`; a notice carrying
  coord A lands on A and leaves B untouched. Uses a `coordRegistry(...)` stub keyed by `servedCoord` and a
  **trust-all verifier** to isolate *routing* from crypto.
- **Per-coord high-water isolation** (`promote-notice.spec.ts`, "a notice for cohort A does not advance or
  stale-drop cohort B"): A applies at `effectiveAt = 5000`; B's own notice at the **equal** `effectiveAt`
  still applies (pre-fix it would stale-drop under the shared key); A's own replay at 5000 is still stale.
- **Coord-tamper rejection** (`promote-notice.spec.ts`, "rewriting cohortCoord … fails verification"): a
  real threshold-signed notice at COORD, then `cohortCoord` rewritten to OTHER_COORD → `verifyAndApplyNotice`
  returns `untrusted` (proves the coord is inside the signed image). This one uses **real** crypto.
- **Signing-image coverage** (`promotion.spec.ts`): both notices carry `cohortCoord` and the decoded signing
  image `.contains` it (promotion + demotion).
- **Wire round-trip** (`wire.spec.ts`): `cohortCoord` survives encode→decode on both notices.
- Adjusted: the old "no serving engine → dropped" test is now a **coord miss** (node serves OTHER_COORD, the
  notice is decided at COORD → `findByCoord` miss → dropped).

### Known gaps / where the tests are a floor, not a ceiling

- **Routing tests use a trust-all verifier**, by design, to isolate the routing/high-water behavior from the
  signature path. That means the *combination* "route by coord A **and** verify against coord A's real cert
  when two real, distinct-membership cohorts coexist on one node" is **not** exercised end-to-end in one
  test. The tamper test covers the crypto binding with real signatures, and existing tests cover
  "signers ⊄ cert → untrusted", but a reviewer wanting maximum confidence could add a combined test with a
  coord-dispatching membership router (two real certs at two coords). I judged this redundant given the two
  concerns are each covered; flagging it so the reviewer can decide.
- **No full-mesh e2e** exercises two live cohorts for one `(topic, tier)` on one node — because the mesh
  harness can't stand that up until the sibling `d ≥ 1` derivation tickets land. The disambiguation
  guarantee here is proven at the `handleInboundNotice` unit level only. This is the honest ceiling of what
  is testable pre-`followon-derivation`.
- **The `/sign` endorser still does not bind `cohortCoord`** for promotion/demotion (it binds only the tag
  and the embedded epoch). That per-kind hot/cold + coord binding is the already-parked
  `cohort-topic-sign-endorsement-hotcold-refinement` (backlog) — left untouched. The signer is only ever
  instantiated at its own `servedCoord`, so the coord it stamps always equals the endorsers' cohort coord;
  binding it would be defense-in-depth, not a correctness fix.

## Out of scope (intentional, with NOTEs left in code)

- **Parent-coord demotion broadcast is a no-op apply for a parent-only node.** `broadcastNotice` still fans a
  demotion to the parent coord; with coord routing, that frame carries the *child's* `cohortCoord`, which a
  parent-only node does not serve → `findByCoord` → `undefined` → dropped. That matches today's behavior
  (`childCohortCount` is 0; the parent-side decrement isn't wired through `applyDemotionNotice`). A `NOTE:`
  at the `broadcastNotice`/`noticeBroadcastCoords` call site records this; wiring the real parent decrement
  is `cohort-topic-followon-derivation`. A node that serves *both* parent and child coord still adopts (as a
  child sibling).
- **The two tier-0 `findServing` readers** (matchmaking query, reactivity forwarder) keep their first-match
  behavior — see the deviation section.

## Tripwires recorded (knowledge, not tickets)

- `NOTE:` at the `/sign` endorser epoch read (host.ts ~L1849): it reads the notice epoch positionally as the
  last image element; `sig/payloads.ts` must keep `cohortEpoch` last. Bidirectional coupling — a future edit
  that appends a field after `cohortEpoch` would silently break endorsement.
- `NOTE:` at `broadcastNotice` (host.ts): parent-coord demotion broadcast is a no-op apply for a parent-only
  node in this milestone, and why.

## No pre-existing failures

Every suite ran green. No `tickets/.pre-existing-error.md` written. All failures encountered during
implementation were mine (the epoch-last signing-image ordering) and are fixed.
