description: COMPLETE — cohort-topic live-tier end-to-end milestone (in-process multi-node cohort over real Ed25519 keys + mock transport: register → threshold-sign → gossip → promote, end-to-end) plus the host `promotion`/`capPromote` test seam and the doc flips. Reviewed; one significant inline fix (the deliverable e2e was flaky — ~5/6 of full runs failed — because the seed/replication participant relied on the routed-primary node coincidentally being its slot-primary; pinned it, now 12/12 deterministic).
files:
  - packages/db-p2p/test/cohort-topic/live-tier.spec.ts (the e2e; +`participantPrimaryAt` helper, +`createSlotAssigner`/`bytesEqual` imports)
  - packages/db-p2p/src/cohort-topic/host.ts (`CohortTopicHostOptions.promotion?: PromotionConfig` → `CoordEngineContext.promotionConfig` → each engine's `createPromotionLifecycle`; header note)
  - docs/cohort-topic.md (§FRET integration → "Validation" subsection; deferrals)
  - docs/architecture.md (Doc Sync Status: cohort-topic Mock-tier e2e → done)
----

# Complete: cohort-topic live-tier end-to-end milestone

An `N = 5`, `wantK = 5`, `minSigs = 4` in-process cohort — each node a real `generateKeyPair('Ed25519')`
identity behind a `createCohortTopicHost`, the transport a mock that routes the five cohort-topic
protocols (`register`, `cohort-gossip`, `promote`, `membership`, `sign`) + FRET `routeAct`/`assembleCohort`
between the in-process node engines (no real libp2p sockets). The six `it` blocks prove the prereq
machinery (`cohort-topic-threshold-assembly`, `-promote-verify-apply`, `-gossip-cadence`,
`-host-antidos-coldstart`) **composes**: a real per-coord cohort computed identically on every node, a
registration through the walk, a genuine collected `k − x` threshold-signed `MembershipCertV1` a
participant verifier accepts (forged single-signer rejected), promotion end-to-end (threshold-sign +
broadcast a `PromotionNoticeV1`, a non-originating node verify-applies it, a later walk gets `Promoted(1)`
and terminates within `maxSteps`), gossip record replication + eviction convergence, and the sub-quorum
negative (no single-signer fallback). The host change is a single test seam: `CohortTopicHostOptions.promotion?`
threads a `PromotionConfig` into every engine's `PromotionLifecycle`, letting the e2e lower `capPromote`
to drive promotion with a small participant count; production defaults (`cap_promote = 64`) are unchanged
when omitted, and the coord-derived inputs (`treeTier`/`childCohortCount`/`parentCoord`) stay non-overridable.

## Review findings

### Checked

- **Implement diff, fresh eyes** (`git show 9aac999`): the test file in full, the `host.ts` seam, both doc edits.
- **Determinism of the deliverable** — ran `live-tier.spec.ts` repeatedly (the implementer claimed "6 passing").
- **The host seam** — that `promotion?` threads through cleanly, applies only the `PromotionConfig`
  count/load thresholds, and preserves production defaults when omitted.
- **The flagged willingness-bootstrap gap** — traced the willingness quorum gate and the idle-engine gossip skip end-to-end.
- **Doc accuracy** — verified `cap_promote = 64` (`DEFAULT_CAP_PROMOTE`) and the gossip-replication model against the code each doc paragraph describes.
- **Type check / tests** — `tsc --noEmit` and the full `test/**/*.spec.ts` suite. (No eslint is configured in this repo; `tsc` is the static gate.)

### Found + fixed inline (significant)

- **The deliverable e2e was flaky — ~5/6 of full runs failed** (`6 passing` was a single lucky draw, not
  the steady state). Root cause: tests 4 (seed) and 5 (replication) registered a participant on the node
  nearest `coord_0` (the "routed primary", `decidingEngine`) and then asserted a `reattach` renew there
  returns `ok`. But the cohort-side renewal serves a `reattach` with `ok` (the path that touches the
  record into the gossip deltas — registration's `accept` does **not** touch, and gossip is delta-only
  with no anti-entropy snapshot) only when it lands on the participant's **slot-assigned primary or a
  backup**. Slot assignment (`createSlotAssigner`) is keyed on `participantId`, **not** on `coord_0`, so
  the routed primary is the slot primary only ~1/k of the time → `primary_moved` instead of `ok` →
  assertion failure (and, downstream, no record to replicate).
  - **Fix** (`live-tier.spec.ts`): added a `participantPrimaryAt(primaryNode, engine)` helper that
    generates a real-keyed participant whose deterministic slot-primary (under the engine's cohort epoch +
    member set) is the deciding node, and used it for the test-4 seed and the test-5 replication
    participant. Now **12/12 consecutive full-spec runs pass**; the full db-p2p suite is **570 passing,
    9 pending**; `tsc --noEmit` clean.
  - Disposition: fixed in-pass rather than spun out — the fix is fully contained to the test file and
    verified deterministic. Flagged as *significant* because it landed as a green deliverable that was in
    fact red most of the time.

### Found, no action — already tracked (major, out of scope)

- **Willingness does not propagate organically on a cold cohort.** The implementer honestly flagged that
  `setupTopic` seeds each sibling's signed willingness frame through the real `cohort-gossip` handler
  because an idle engine builds **no** gossip frame (`buildCohortGossip` returns `undefined` with no
  resident topics and no deltas — `cohort-gossip-driver.ts:122`), so the first registration's willingness
  quorum (`floor(k/2)+1 = 3` of 5, from gossiped `willingnessBits`) can never be met organically. This is
  a **real** chicken-and-egg in the production wiring, but it is **already tracked** in
  `tickets/backlog/cohort-topic-idle-willingness-heartbeat.md` (filed from the gossip-cadence review;
  sibling `cohort-topic-admission-quorum-semantics`). No new ticket needed. The test seam is faithful to
  how the substrate *would* be seeded and is the right pragmatic choice for this milestone; I confirmed
  there is no separate always-on willingness beacon and no tier-0/bootstrap bypass of the quorum gate.

### Reviewed, accepted as sound scope decisions (no action)

The remaining items in the implementer's "honest gaps" list were each scrutinized and judged appropriate:

- **Per-coord scoping is asserted as determinism, not as a subset** — with `wantK = N` the cohort is
  trivially the whole network; strict per-coord scoping (cohort ≠ ring neighbours) stays covered by
  `service.spec.ts`'s FRET fake. The live test asserts the property threshold collection actually needs
  (identical cohort + epoch on every node). Acceptable.
- **Bulk promotion registrations bypass the walk** (driven via `handleRegister` directly for speed; the
  walk is exercised by assertion 2 and the post-promotion redirect). Acceptable.
- **Promotion timing is poll-based** (`waitFor` with an 8 s ceiling, settles in tens of ms). Verified
  deterministic across 12 runs. Acceptable.
- **Cert verification is cert-as-message; negative case asserts the cert path not the notice path; `d_max`
  pinned via `sizeEstimate = 256 → d_max = 1`; `MockStreamEnd` half-close is simpler than a real muxer.**
  All consistent with established sibling-test patterns and the still-`pending` real-libp2p tier; no
  correctness gap introduced.

### Host change + docs

- **`host.ts`** — the `promotion?: PromotionConfig` seam is minimal and correct: threaded via
  `CoordEngineContext.promotionConfig`, defaults to `{ capPromote: undefined }` (full production defaults)
  when omitted, applies only the `PromotionConfig` count/load thresholds, and never overrides the
  coord-derived inputs. JSDoc "`cap_promote = 64`" matches `DEFAULT_CAP_PROMOTE`. No SPP/DRY/type-safety/
  resource-cleanup issues (`mesh.stop()` tears down every host in each test's `finally`).
- **Docs** — `cohort-topic.md` §Validation and `architecture.md` Doc Sync Status accurately describe the
  landed test and the genuinely-still-`pending` real-libp2p tier; deferrals match the backlog tickets.

### Empty categories

- **No new fix/plan tickets filed** — the one real production gap surfaced (willingness bootstrap) is
  already tracked in backlog; everything else was either fixed inline or a sound scope decision.
- **No `.pre-existing-error.md`** — the full suite is green; no unrelated failures observed.

## How it was validated

```
cd packages/db-p2p
# 12× consecutive — deterministic after the fix:
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/cohort-topic/live-tier.spec.ts" --reporter min   # 6 passing each
node --import ./register.mjs node_modules/mocha/bin/mocha.js "test/**/*.spec.ts" --reporter min                     # 570 passing, 9 pending
./node_modules/.bin/tsc --noEmit                                                                                     # clean
```

## Still deferred (parked in backlog — unchanged by this milestone)

- Organic idle-cohort willingness propagation (`cohort-topic-idle-willingness-heartbeat`) +
  admission-quorum semantics (`cohort-topic-admission-quorum-semantics`).
- Multi-tier promoted-redirect follow-on instantiation (`cohort-topic-followon-derivation`) and
  parent-side child-cohort link recording (`cohort-topic-parent-child-link`).
- A dedicated read-only lookup-probe RPC; an immediate withdraw tombstone; the real-libp2p (socket) e2e tier.
