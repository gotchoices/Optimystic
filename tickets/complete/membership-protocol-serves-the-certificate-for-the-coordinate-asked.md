description: A machine in several cohort-topic cohorts used to keep only the last membership certificate it published and hand it to anyone who asked, whichever cohort they asked about; it now keeps one certificate per cohort and answers with the one asked for.
architecture: docs/cohort-topic.md#bootstrapping-trust
files: packages/db-core/src/cohort-topic/ports.ts, packages/db-core/src/cohort-topic/membership/publisher.ts, packages/db-p2p/src/cohort-topic/membership-publish-sink.ts, packages/db-p2p/src/cohort-topic/membership-source.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts, docs/cohort-topic.md, tickets/backlog/hardening/cohort-topic-parent-ref-tx-log-content.md
----

# The `/membership` protocol serves the certificate for the coordinate asked

## What was wrong

A node runs one coord engine per cohort coordinate it serves, and each engine publishes its own threshold-signed `MembershipCertV1`. All of them published into one node-wide `FretMembershipPublishSink`, which held a single slot. The `/optimystic/cohort-topic/1.0.0/membership` responder ignored the request frame (the coordinate asked about) and returned that slot, so a fetch for cohort A could get cohort B's certificate. The asking side already discards a certificate naming another coordinate, so the result was lost availability: genuine promotions, demotions, child links and root-placed messages could be reported `untrusted`. The responder also cached what it served into the node's membership source under the node's own ring position, a key that names no served cohort.

## What landed

- `IMembershipPublishSink.publish(coord, encodedCert)` (`packages/db-core/src/cohort-topic/ports.ts`) takes the cohort coordinate, and `SigningMembershipCertPublisher` passes `snapshot.coord`.
- `FretMembershipPublishSink` (`packages/db-p2p/src/cohort-topic/membership-publish-sink.ts`) is a map from coordinate to encoded cert, with `publish`, `certFor` and `forget`. The `/membership` responder in `registerCohortTopicProtocols` answers `certFor(frame)`, or the empty "no result" frame, and no longer writes to the membership source. `onEngineEvicted` calls `forget`, so the map is no larger than the engine registry.
- The engine's publish sink is wrapped in `createCoordEngine` so that a publish still awaiting its threshold signature when the engine closes writes nothing, and `publishMembership` skips `onCertPublished` once the engine is closed.
- Regression test: "a /membership request is answered with the cert published for the coordinate asked — not another served cohort's" in `packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts`.

## Review findings

**Checked:** I read the implement diff (`ticket(implement): membership-protocol-serves-the-certificate-for-the-coordinate-asked`) before the handoff. I checked every implementer and caller of the sink port: only `FretMembershipPublishSink` and test doubles implement it. Root-placed engines publish under `H(rootKey)`, which is the same frame `FretMembershipSource.fetch` sends for a root-placed fetch, so serving and fetching agree. `snapshot.coord` is always the engine's `servedCoord`. I checked the eviction path (`forget` beside `verifier.forget`), the recreated-engine case (the new engine has its own `closed` flag, so the old engine's in-flight publish cannot overwrite the new cert), and the verifier's `source.current` seed path.

**Judgement call 1 (self-published certs fed into the membership source): reversed.** That cache is what the T2/T3 parent-reference existence check reads (`membershipSource.has(coord_0(parentTopicId))` in `createDefaultParentTopicView`). The host creates a coord engine for any register frame before the anti-DoS gate judges it (`dispatchRegister` → `registry.forCoord`). On a keyed node, `pumpMembership` publishes a cert for every engine, including ones with no records. With the side effect in place, one refused register for topic X made X "exist" as a parent on the node that refused it. An attacker could then skip proof-of-work for a child topic by picking X so that `coord_0(X)` lands near the child's cohort, which costs only cheap hashing. Nothing needed the side effect: the old `selfCoord` write never fed this check, and the verifier already holds own certs as trusted via `onCertPublished`. I removed the callback from the sink and the host. A `NOTE:` at `publishSink` in `createCohortTopicHost` records why, and I updated the `FretMembershipSource` doc comments, which said the host feeds certs into the cache.

The same weakness still exists through fetched certs: another node fetches the certificate from the cohort serving X and caches it. That is the "unrelated-but-existing parent" gap already open in `backlog/hardening/cohort-topic-parent-ref-tx-log-content`. I added this path to that ticket as evidence instead of filing a new one.

**Judgement call 2 (closed-engine guard on an in-flight publish): kept.** The guard is correct and minimal. Moving the `closed` declaration above the publisher was needed so the wrapper can see it. Leaving it untested is acceptable: reproducing it needs an eviction during the threshold-signature await, and the guard is a single branch.

**Minor, fixed inline:** the responder's `frame.length === RING_BITS / 8` guard was redundant, since a frame that is not a 32-byte coordinate cannot match a key in the map and already gets the empty reply. It also tied the responder to a constant that the host's hash happens to share. I removed it along with the `RING_BITS` import. The test's 5-byte-frame assertion still covers that behaviour.

**Tests:** the added two-cohort test reproduces the bug, so it stays. The adapted call sites in `membership.spec.ts`, `promote-notice.spec.ts` and `threshold-assembly.spec.ts` are mechanical. No other test was cut or added.

**Docs:** the sentence added to `docs/cohort-topic.md` §Bootstrapping trust is still accurate. The §Membership source note about the parent-reference gate ("A node only knows a parent topic exists if it has *locally cached* a cert") is accurate again now that own certs are not cached.

**Tripwires:** the `NOTE:` at `publishSink` in `createCohortTopicHost`: if a parent this node serves itself should ever count as existing, require admitted registrations first.

**Validation:** `yarn workspace @optimystic/db-p2p test` gave 3177 passing and 65 pending. `tsc --noEmit` on db-p2p, root `yarn typecheck`, eslint on the changed sources and `yarn lint:docs` are all clean. With `OPTIMYSTIC_INTEGRATION=1`, `packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts` gave 13 passing and 2 pending (both were already pending). The rest of `yarn test:integration` was not run. db-core was not re-run in review because nothing under db-core changed in this pass; the implement stage reported 1852 passing.
