description: Cohesive CohortTopicNode/Service tying walk/promotion/willingness/TTL/gossip together; registers /optimystic/cohort-topic/1.0.0/* protocols on FRET.
prereq: cohort-topic-antiflood-antidos, cohort-topic-walk-promotion-coldstart, cohort-topic-willingness-barometer-traffic, cohort-topic-gossip-membership-certs, cohort-topic-registration-storage-sharding, cohort-topic-tier-addressing-dmax, cohort-topic-package-layering
files:
  - docs/cohort-topic.md (§FRET integration L432-460, §Application policies L641-652, §Interaction L656-662)
  - docs/architecture.md (§Cohort Topics/Reactivity/Matchmaking ~L233-240, Document Map, Doc Sync Status)
  - docs/internals.md
  - C:/projects/Fret/packages/fret/src/rpc/maybe-act.ts
  - C:/projects/Fret/packages/fret/src/service/fret-service.ts
  - packages/db-core/src/cohort-topic
  - packages/db-p2p/src (new: cohort-topic service host)
effort: high
----

# CohortTopicService public API and full FRET integration

This ticket assembles the components built by the prereq tickets into the public substrate
API and wires it to FRET as a running service. It folds the FRET-integration layer and the
core-module concerns. After this lands, reactivity and matchmaking can build on a real
`CohortTopicService`.

## Public API (CohortTopicService)

The substrate's contract to applications (per `docs/cohort-topic.md` §Application policies
L641-652 and the layer's stated contract): given a `topicId` and a `tier`, reliably find a
willing primary (or fail with a clear back-off), registrations persist within their TTL,
cohort identity/membership is verifiable.

```ts
export interface CohortTopicService {
	register(req: {
		topicId: Uint8Array;
		tier: Tier;
		appPayload?: Uint8Array;        // application slot (reactivity/matchmaking define contents)
		ttl?: number;
		bootstrap?: boolean;
	}): Promise<RegistrationHandle>;

	renew(handle: RegistrationHandle): Promise<void>;     // ttl/3 ping; handles primary_moved
	lookup(topicId: Uint8Array, tier: Tier): Promise<CohortHint>;  // walk; no registration
	withdraw(handle: RegistrationHandle): Promise<void>;  // RenewV1 ttl=0

	// integration hooks consumed by reactivity + matchmaking:
	onLocalCommit?: LocalChangeHook;   // set by the bridge ticket
	cohortGossip(): CohortGossipBus;   // applications fold app state into existing gossip
	verifier(): MembershipVerifier;    // applications verify threshold-signed app messages
}

export interface RegistrationHandle {
	topicId: Uint8Array;
	tier: Tier;
	primary: PeerId;
	backups: PeerId[];
	cohortEpoch: Uint8Array;
	cohortMembers: PeerId[];
	topicTraffic?: TopicTrafficV1;
}
```

The service ties together: `WalkEngine` (lookup/register), `PromotionLifecycle`,
`WillingnessCheck` + barometer + `TrafficCounters`, `RegistrationStore` + sharding + TTL
renewal, `CohortGossipBus` + `CohortSigner` + `MembershipVerifier`, and the
anti-flood/anti-DoS guards — all on the same FRET node.

## FRET integration (§FRET integration L432-460)

Register the protocol IDs on the FRET/libp2p node:

```
/optimystic/cohort-topic/1.0.0/register       — Register, renew, re-attach
/optimystic/cohort-topic/1.0.0/cohort-gossip  — record replication, willingness, load barometers
/optimystic/cohort-topic/1.0.0/promote        — threshold-signed promotion/demotion notices
/optimystic/cohort-topic/1.0.0/membership     — membership certificates
```

- Registration routes via `RouteAndMaybeAct` (`registerMaybeAct`/`sendMaybeAct`): `key =
  coord_d(self, topicId)`, `activity = RegisterV1`, `wantK = k`, `minSigs = k − x`.
  Acceptance/redirect/willingness runs inside the cohort's activity callback.
- Cohort assembly uses FRET's two-sided assembly unmodified.
- Threshold signatures via `minSigs`; `d_max` via the size estimator.
- Post-registration pings dial cached `primary` directly; fall back to `RouteAndMaybeAct`
  only when unreachable.

The service host lives in `packages/db-p2p/src` (it needs the libp2p/FRET node);
`packages/db-core/src/cohort-topic` holds the protocol-agnostic logic from the prereq
tickets.

## Doc updates (this is the doc-sync milestone for the substrate)

- `docs/architecture.md`: describe cohort-topic as the **networked change-notification
  primitive** on which reactivity + matchmaking build (replacing ad-hoc per-subsystem
  approaches). Flip the master **Doc Sync Status** section: `cohort-topic substrate =
  implemented (mock-tier e2e pending)`. (The L233-240 overstatement fix and the Doc Sync
  Status scaffold are landed by the docs-area tickets `fix-architecture-applications-
  overstatement` / `audit-partition-healing-doc-links`; this ticket *updates* the status
  row, it does not create the section.)
- `docs/internals.md`: add the cohort-topic subsystem section (service composition, walk →
  register → gossip → promote pipeline, protocol IDs), building on the storage subsection
  added by the registration ticket.
- `docs/cohort-topic.md`: confirm §FRET integration matches the registered protocol IDs and
  `RouteAndMaybeAct` usage.

## Constraints

ES modules, no inline `import()`, no `any`, tabs, cross-platform (the db-core logic must
stay browser/RN-safe; the db-p2p host is node/libp2p). Reuse FRET; treat read-only. Don't
break existing tests.

## TODO

### Phase 1 — service assembly (db-core)
- Implement `CohortTopicService` composition in `packages/db-core/src/cohort-topic/service.ts`, wiring all prereq components; export `RegistrationHandle`, `CohortHint`, integration hooks.

### Phase 2 — FRET host (db-p2p)
- Implement the protocol host in `packages/db-p2p/src/cohort-topic/` registering the four `/optimystic/cohort-topic/1.0.0/*` protocols, routing register via `RouteAndMaybeAct`, cohort assembly + `minSigs` threshold sig + size-estimator `d_max` via FRET.
- Direct-dial primary for pings; `RouteAndMaybeAct` fallback.

### Phase 3 — tests + docs
- `packages/db-p2p/test/cohort-topic/service.spec.ts` (mock transport, mesh-harness style): full single-topic flow register → renew → promote (push count past `cap_promote`) → lookup against FRET; protocol handshake on each of the four protocol IDs.
- Doc-sync `docs/architecture.md` (cohort-topic narrative + Doc Sync Status row), `docs/internals.md` (cohort-topic subsystem section), `docs/cohort-topic.md` (§FRET integration confirmation).

## Done when
- `yarn build` green for `db-core` and `db-p2p`.
- `yarn test` green for `db-core` and `db-p2p` including the service spec.
- `docs/architecture.md` Doc Sync Status shows cohort-topic substrate implemented (mock-tier e2e pending); `docs/internals.md` has the cohort-topic subsystem section.
