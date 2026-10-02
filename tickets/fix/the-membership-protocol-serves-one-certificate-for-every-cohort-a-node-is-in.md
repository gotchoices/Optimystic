description: A machine that belongs to more than one cohort-topic cohort keeps only the last membership certificate it published, so another machine asking it for the certificate of one cohort can be handed the certificate of a different cohort and fail to verify genuine messages.
architecture: docs/cohort-topic.md#bootstrapping-trust
files: packages/db-p2p/src/cohort-topic/membership-publish-sink.ts, packages/db-p2p/src/cohort-topic/host.ts, packages/db-core/src/cohort-topic/ports.ts, packages/db-core/src/cohort-topic/membership/publisher.ts, packages/db-p2p/src/cohort-topic/membership-source.ts, docs/cohort-topic.md
difficulty: medium
repro: static
----

# The membership protocol serves one certificate for every cohort a node is in

## What is wrong

Each cohort a node serves (one `CoordEngine` per served coordinate in `packages/db-p2p/src/cohort-topic/host.ts`) publishes its own membership certificate through the `IMembershipPublishSink` port (`packages/db-core/src/cohort-topic/ports.ts`). The db-p2p binding, `FretMembershipPublishSink` in `packages/db-p2p/src/cohort-topic/membership-publish-sink.ts`, holds **one** slot: `publish` overwrites `latestCert`, and `latest` returns whatever was published last.

The `/optimystic/cohort-topic/1.0.0/membership` handler (the `protocols.membership` registration in `createCohortTopicHost`) answers every request with that one slot. The request frame already carries the coordinate being asked about (`FretMembershipSource.fetch` in `packages/db-p2p/src/cohort-topic/membership-source.ts` sends the raw coordinate bytes), but the handler discards it (`void frame`).

So on a node in two or more cohorts — ordinary once a network carries more than one topic, and certain for a node that serves both a root-placed reactivity root and a default-rule cohort (see `docs/cohort-topic.md` §Root placement at a routing key) — a `/membership` fetch for cohort A can return cohort B's certificate. Which one depends on which engine's gossip round published last.

## Consequence

A verifier that misses its cache (`createMembershipVerifier` in `packages/db-core/src/cohort-topic/membership/verifier.ts`) fetches the certificate from the cohort's members and judges the message against what comes back. Once `fix/membership-verifier-accepts-a-certificate-for-another-coordinate` lands, a certificate for another coordinate is discarded, so the message is reported `untrusted` even though it is genuine and the serving node holds the right certificate. Until it lands the wrong certificate is used, which is that ticket's problem. Either way a genuine promotion, demotion, child link or root-placed message can fail to verify on the first fetch, and the verifier's refetch bound (`PROMOTE_REFETCH_MIN_INTERVAL_MS`) then delays the retry.

## Expected behavior

- A node answers a `/membership` request with the certificate of the coordinate the request names, or an empty reply when it has published none for that coordinate.
- The publish sink is keyed by coordinate. The cleanest shape is for `IMembershipPublishSink.publish` to receive the coordinate alongside the encoded certificate (the publisher in `packages/db-core/src/cohort-topic/membership/publisher.ts` knows it: it is `cert.cohortCoord`), and for the db-p2p sink to keep a bounded per-coordinate map, dropped with the engine on eviction like the verifier's trust lock.
- The handler's current side effect, `membershipSource.cache(selfCoord, latest)`, caches the served certificate under the node's own ring position rather than under the coordinate it belongs to; it should cache under the certificate's coordinate or go away.

## What would confirm it

A mesh spec in which one node serves two coordinates (two topics whose tier-0 coordinates both land on it, or one root-placed root plus one default topic), publishes both certificates, and is then asked over `/membership` for each coordinate in turn: today the two answers are the same bytes.

## Why it is filed now

Found while reviewing `cohort-topic-host-serves-a-root-at-a-storage-group`, whose implement handoff named it as pre-existing. Root placement makes the two-cohort shape routine rather than occasional, and `reactivity-notifications-need-the-tail-cohort-to-be-the-topic-cohort` deploys it. The open `fix/membership-verifier-accepts-a-certificate-for-another-coordinate` ticket covers the verifier's side (refusing a certificate for the wrong coordinate); this one is the serving side (answering with the right one), a different site.
