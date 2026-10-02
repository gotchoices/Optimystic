description: A machine in several cohort-topic cohorts used to keep only the last membership certificate it published and hand it to anyone who asked, whichever cohort they asked about; it now keeps one certificate per cohort and answers with the one asked for. Review the change and the two judgement calls it made.
architecture: docs/cohort-topic.md#bootstrapping-trust
files: packages/db-core/src/cohort-topic/ports.ts, packages/db-core/src/cohort-topic/membership/publisher.ts, packages/db-p2p/src/cohort-topic/membership-publish-sink.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts, packages/db-core/test/cohort-topic/membership.spec.ts, packages/db-p2p/test/cohort-topic/promote-notice.spec.ts, packages/db-p2p/test/cohort-topic/threshold-assembly.spec.ts, docs/cohort-topic.md
----

# The `/membership` protocol serves the certificate for the coordinate asked

## What was wrong

A node runs one coord engine per cohort coordinate it serves, and each engine publishes its own threshold-signed `MembershipCertV1`. All of them published into one node-wide `FretMembershipPublishSink`, which held a single slot, and the `/optimystic/cohort-topic/1.0.0/membership` responder ignored the request frame (the coordinate being asked about) and returned that slot. On a node in two cohorts, a fetch for cohort A could get cohort B's certificate. The asking side already discards a certificate naming another coordinate, so the effect was lost availability rather than misplaced trust: when the wrong-answering node was the only holder of the right certificate, genuine promotions, demotions, child links and root-placed messages were reported `untrusted`. The responder also cached what it served into the node's own membership source under the node's own ring position, a key that names no served cohort.

## What changed

- **Port.** `IMembershipPublishSink.publish(coord, encodedCert)` in `packages/db-core/src/cohort-topic/ports.ts` now takes the cohort coordinate. `SigningMembershipCertPublisher.publish` passes `snapshot.coord`, the same coordinate it signs as `cohortCoord`.
- **Sink.** `FretMembershipPublishSink` (`packages/db-p2p/src/cohort-topic/membership-publish-sink.ts`) is a map from base64url coordinate to encoded cert: `publish`, `certFor(coord)` (replaces `latest()`), `forget(coord)`. An optional constructor callback sees each publish.
- **Responder.** `registerCohortTopicProtocols` in `packages/db-p2p/src/cohort-topic/host.ts` answers `publishSink.certFor(frame)`, or the empty "no result" frame when nothing was published for that coordinate or the frame is not `RING_BITS / 8` bytes. It no longer takes `membershipSource` or `selfCoord`, and writes nothing to the membership source.
- **Bound.** `onEngineEvicted` calls `publishSink.forget(coord)`, so the map is no larger than the engine registry (`coordEnginesMax`). `host.stop()` needs nothing extra: the sink goes out of scope with the host.
- **Docs.** One sentence added to the "A cert counts only for the coordinate it names" paragraph in `docs/cohort-topic.md` §Bootstrapping trust. `yarn lint:docs` passes.

## Two judgement calls for the reviewer

1. **This node's own certificates now reach its membership source, under their own coordinate.** The host builds the sink with a callback that calls `membershipSource.cache(coord, encoded)` on every publish. The only reader that changes behaviour is the parent-reference existence check for tiers T2/T3 (`createDefaultParentTopicView` in `packages/db-p2p/src/cohort-topic/bootstrap-parent-reference.ts`, which asks `membershipSource.has(coord_0(parentTopicId))`). A node that serves the parent topic's tier-0 coordinate now answers "the parent exists" from its own certificate, without needing a fetched one. The old write under `selfCoord` never fed this check (the node's own ring position is not any topic's `coord_0`), so this is a real widening of what that admission check accepts, though only to parents this node itself serves. The verifier's `source.current` seed path also now finds self-published certs; it already held them as trusted via `onCertPublished` → `verifier.cache`, so that read changes nothing. The alternative was to drop the side effect entirely; if the reviewer prefers that, delete the callback argument in `createCohortTopicHost`. A `NOTE:` at that site records that an evicted engine's certificate stays in the source cache, which is unbounded by design today, like every fetched cert there.
2. **The closed-engine guard now also covers a publish that is still in flight.** `createCoordEngine` already ignored time-driven calls after `close()`, but a publish awaiting its threshold signature when the engine was evicted would still write the sink (re-adding what `forget` had just removed, or overwriting a newer engine's cert for the same coordinate) and still run `onCertPublished` → `verifier.cache` (re-locking a coordinate `verifier.forget` had just released). The engine now hands the publisher a sink wrapper that drops writes once `closed`, and `publishMembership` skips `onCertPublished` when `closed`. The `let closed` declaration and its comment moved above the publisher so the wrapper can see it. There is no test for this race: it needs an eviction to land during a threshold-signature await, and the guard is a one-line branch.

## Tests

- Added: "a /membership request is answered with the cert published for the coordinate asked — not another served cohort's" in `packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts` (describe "two-coord inbound routing isolation"). One keyed, self-only host serves `coord0(TOPIC)` and `coord0(TOPIC2)`, each engine publishes via `onStabilized`, and the real `/membership` handler on the fake node is invoked per coordinate (new helper `requestMembership`, which captures the reply frame). It asserts each answer decodes to a cert naming the coordinate asked, an unpublished coordinate gets the empty reply, and a 5-byte frame gets the empty reply rather than an error. Before the fix it failed: asking for A returned B's cert.
- Adapted to the port change, no new assertions: the mock sink in `packages/db-core/test/cohort-topic/membership.spec.ts`, and `sink.latest()` → `sink.certFor(COORD)` in `promote-notice.spec.ts` (`encodedCertOver`) and `threshold-assembly.spec.ts`.

## Validation run

- `yarn workspace @optimystic/db-core test`: 1852 passing.
- `yarn workspace @optimystic/db-p2p test`: 3177 passing, 65 pending.
- `yarn typecheck` (root): clean. `eslint` on the changed source and test files: clean. `yarn lint:docs`: clean.
- Integration: only `packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts` was run (`OPTIMYSTIC_INTEGRATION=1`), the spec that does `/membership` serve and fetch over real sockets: 13 passing, 2 pending (both pending already). The rest of `yarn test:integration` (other db-p2p integration specs, and the quereus plugin's) was **not** run.

## Use cases to check

- A node in two cohorts (for example a tail block's storage group serving a reactivity root plus its default-rule cohorts) answers a fetch for each cohort with that cohort's certificate.
- A fetch for a coordinate the node serves but has not published yet, or never served, gets the empty reply, and `FretMembershipSource.fetch` moves on to the next holder.
- After engine eviction the evicted coordinate's certificate is no longer served; a recreated engine for the same coordinate serves its own fresh certificate.
