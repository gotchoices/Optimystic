description: A machine that belongs to several cohort-topic cohorts keeps only the last membership certificate it published, so a peer asking it for one cohort's certificate can be handed another's and then fail to verify genuine messages; keep one certificate per cohort and answer with the one asked for.
architecture: docs/cohort-topic.md#bootstrapping-trust
files: packages/db-core/src/cohort-topic/ports.ts, packages/db-core/src/cohort-topic/membership/publisher.ts, packages/db-p2p/src/cohort-topic/membership-publish-sink.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-p2p/src/cohort-topic/membership-source.ts, packages/db-core/test/cohort-topic/membership.spec.ts, packages/db-p2p/test/cohort-topic/promote-notice.spec.ts, packages/db-p2p/test/cohort-topic/threshold-assembly.spec.ts, packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts, docs/cohort-topic.md
difficulty: medium
repro: static
----

# Serve the membership certificate for the coordinate the request names

## The defect (confirmed by reading the code)

A node runs one `CoordEngine` per cohort coordinate it serves (`createCoordRegistry` in `packages/db-p2p/src/cohort-topic/host.ts`). Each engine builds its own `MembershipCertPublisher` (`createMembershipCertPublisher` in `packages/db-core/src/cohort-topic/membership/publisher.ts`), but every one of them is handed the same node-wide sink, `ctx.publishSink`, a single `FretMembershipPublishSink` (`packages/db-p2p/src/cohort-topic/membership-publish-sink.ts`). That sink holds one slot: `publish` overwrites `latestCert`, `latest()` returns it. Its doc comment states the wrong premise outright: "A node publishes only its own cohort's cert".

The `/optimystic/cohort-topic/1.0.0/membership` responder (the `protocols.membership` registration inside `registerCohortTopicProtocols`, same file) discards the request frame (`void frame`), even though the frame is the raw coordinate being asked about (`FretMembershipSource.fetch` in `packages/db-p2p/src/cohort-topic/membership-source.ts` sends `coord` as the request). It answers with whichever certificate was published last, so on a node in two cohorts a fetch for cohort A can return cohort B's certificate.

It also caches what it serves into the node's membership source under `selfCoord` — the node's own ring position, which is not the coordinate of any served cohort. That is a second wrong-key write: `FretMembershipSource.current(selfCoord)` / `has(selfCoord)` then return a certificate for some other coordinate.

## What already protects the asking side

`FretMembershipSource.fetch` now skips a reply that names another coordinate and asks the next holder, and `CachingMembershipVerifier.loadFrom` (`packages/db-core/src/cohort-topic/membership/verifier.ts`) discards such a cert (both landed with `membership-verifier-accepts-a-certificate-for-another-coordinate`). So today the wrong answer does not get trusted; it gets *skipped*. The cost is availability: when the holder that answered wrong is the only one that holds the right certificate (a cohort of one, or the only member that has published), the fetch resolves `undefined` and a genuine promotion, demotion, child link or root-placed message is reported `untrusted`, then held off by the verifier's refetch bound (`PROMOTE_REFETCH_MIN_INTERVAL_MS`). Root placement (`docs/cohort-topic.md` §Root placement at a routing key) makes a node in two cohorts routine: a node in a tail block's storage group serves that reactivity root and its default-rule cohorts at once.

## Expected behaviour

- A node answers a `/membership` request with the certificate it published for the coordinate the request names, or an empty reply (`new Uint8Array(0)`, the existing "no result" frame) when it has published none for that coordinate. A request frame that is not a coordinate (wrong length) gets the empty reply too — never a throw out of the handler.
- The publish sink is keyed by coordinate.
- The responder writes nothing into the membership source under `selfCoord`.

## Design

**Port.** Change `IMembershipPublishSink.publish` in `packages/db-core/src/cohort-topic/ports.ts` to `publish(coord: RingCoord, encodedCert: Uint8Array): void`. The publisher already holds the coordinate (`snapshot.coord`, which is what it signs as `cohortCoord`), so `SigningMembershipCertPublisher.publish` passes `snapshot.coord`. Passing the coordinate explicitly, rather than having the sink decode the bytes to find it, keeps the sink a dumb store and avoids a decode on every publish.

**Sink.** `FretMembershipPublishSink` becomes a map from coordinate (base64url, matching `FretMembershipSource`'s `byCoord` keys) to encoded cert:

- `publish(coord, encoded)` sets the entry;
- `certFor(coord): Uint8Array | undefined` replaces `latest()`;
- `forget(coord): void` removes it.

Bound: entries are only ever written by a live engine, so dropping the entry when the engine goes keeps the map no larger than the engine registry (`coordEnginesMax`). Add `publishSink.forget(coord)` to the host's `onEngineEvicted` hook, beside `verifier.forget` and `rootGroup?.snapshots.drop`. Also forget on whatever path closes all engines at `host.stop()` if one exists — check `createCoordRegistry`'s close path; if the whole sink simply goes out of scope with the host, nothing extra is needed. Rewrite the class doc comment: a node publishes one cert per cohort it serves.

**Responder.** In the `protocols.membership` handler: if `frame.length !== RING_BITS / 8` (`RING_BITS` from db-core's `ring-hash.ts`; check it is exported, else use 32 with a reference to it) reply empty; otherwise reply `publishSink.certFor(frame) ?? new Uint8Array(0)`. Drop the `membershipSource` and `selfCoord` parameters from `registerCohortTopicProtocols` if nothing else in it uses them.

**The `membershipSource.cache` side effect.** Remove it from the responder. What it was presumably for — this node's own source knowing the certs of cohorts it serves — is better done at publish time, under the cert's own coordinate: feed `membershipSource.cache(coord, encoded)` from the publish path (for example a small wrapper sink in the host, or an `onPublish` callback on `FretMembershipPublishSink`). Before adding that, check whether anything reads it: `FretMembershipSource.has` backs the parent-reference existence gate for T2/T3 (`docs/cohort-topic.md`, the "Reused by the parent-reference anti-DoS gate" note), and a node that serves a coordinate knowing that coordinate exists is correct there. If you add it, the evicted engine's entry in the source cache is not dropped (the source cache is unbounded by design today, keyed only by what was fetched); note that rather than widening this ticket. If nothing reads it, just remove the side effect.

## Tests

The reproduction, at the lowest layer that shows it: one keyed, self-only host serving two coordinates, as in "a gossip for coord A merges only into coord A's store" in `packages/db-p2p/test/cohort-topic/gossip-cadence.spec.ts` (`makeFakeNode`, `makeFakeFret(() => [])`, `wantK: 1`, `minSigs: 1`, two `host.registry.forCoord` engines for `coord0(TOPIC)` and `coord0(TOPIC2)`). Publish each engine's cert (`engine.onStabilized(now)`, as in "onStabilized publishes a real (self-signed, k=1) cert" in `threshold-assembly.spec.ts`), then invoke the `/membership` handler on the fake node with each coordinate in turn and assert each answer decodes to a cert whose `cohortCoord` is the coordinate asked; a third, unpublished coordinate gets the empty reply. Before the fix the two answers are the same bytes. Put it with the other host-level membership behaviour; if the fake node in `gossip-cadence.spec.ts` has no way to drive a request/reply handler, look at how `membership-source.spec.ts` drives one over `MockNode` + `handleRequestResponse`, or at `buildMesh` in `packages/db-p2p/src/testing/cohort-topic-mesh-harness.ts`, which builds real hosts over in-process nodes.

One test. Do not add a separate unit test of the sink's map — the host test covers it.

Existing tests to adapt to the port change: the mock sink in `packages/db-core/test/cohort-topic/membership.spec.ts` (`publish: (encoded) => …` takes the coordinate first now), and the `sink.latest()` reads in `packages/db-p2p/test/cohort-topic/promote-notice.spec.ts` (`encodedCertOver`) and `packages/db-p2p/test/cohort-topic/threshold-assembly.spec.ts` (become `sink.certFor(COORD)`).

## Docs

`docs/cohort-topic.md` §Bootstrapping trust has the paragraph "A cert counts only for the coordinate it names", which describes the asking side's check. Add one sentence there (or in §Membership snapshots, where publication is described) that a node serves, per coordinate, the cert it published for that coordinate, citing `FretMembershipPublishSink` in `packages/db-p2p/src/cohort-topic/membership-publish-sink.ts`. Run `yarn lint:docs`.

## TODO

- Write the host-level reproduction above; confirm it fails on current code (both answers identical).
- Change `IMembershipPublishSink.publish` to take the coordinate; pass `snapshot.coord` from `SigningMembershipCertPublisher.publish`.
- Re-key `FretMembershipPublishSink` by coordinate (`publish`, `certFor`, `forget`); rewrite its doc comment.
- Answer `/membership` by the request coordinate, empty reply for an unknown or malformed coordinate; remove the `membershipSource.cache(selfCoord, …)` side effect and any parameters it leaves unused.
- Decide whether this node's own published certs should reach `membershipSource` under their own coordinate (check readers of `FretMembershipSource.has` / `current`); wire it at publish time if so.
- Drop the sink entry in `onEngineEvicted`.
- Update the three existing specs for the port change.
- One docs sentence in `docs/cohort-topic.md`; `yarn lint:docs`.
- Build, then `yarn test` in `packages/db-core` and `packages/db-p2p`; `yarn typecheck` from root. The real-socket `substrate-real-libp2p.integration.spec.ts` exercises `/membership` serve+fetch end to end — run `yarn test:integration` in `packages/db-p2p` if time allows, else say it was not run.
