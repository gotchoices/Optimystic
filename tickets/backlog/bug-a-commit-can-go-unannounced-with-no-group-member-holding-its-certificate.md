description: In a three-machine storage group, a commit was once seen to be announced by nobody, because no machine that applied it kept the full set of signatures an announcement needs. Watchers elsewhere then hear of that commit only on the next commit or the next periodic check, up to 30 s later. Find out why, and whether it can happen to any commit or only the first one after a watch opens.
files: packages/db-p2p/src/cluster/cluster-repo.ts (`captureCommitCert` and the `NOTE:` above it), packages/db-p2p/src/repo/cluster-coordinator.ts (`broadcastMergedRecord`, `presignLocalCommit`), packages/db-p2p/src/cohort-topic/change-bridge.ts (`originate`), packages/db-p2p/src/cluster/commit-cert.ts, packages/db-p2p/test/substrate-real-libp2p.integration.spec.ts (the wide-mesh watch describe, which reproduced it)
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: Seen once in 16 runs, with the cause not isolated, and the watch service's tick already bounds the delay at one tick (30 s Core); a maintainer may defer it until it is seen outside a test.
----

## What was seen

The commit was the second revision of a collection on a six-machine real-libp2p mesh with `clusterSize` 3. It was the first commit after a watch on a machine outside the tail's storage group had registered. Its log tail was applied by two members of the tail's group, and each reached the change bridge (`originate` in `packages/db-p2p/src/cohort-topic/change-bridge.ts`) with no commit certificate (`extractCommitCert` returned `undefined`). No third tail-applied event for that revision reached any bridge within the next 10 s. Nobody announced the commit. The next commit, 10 s later, was announced normally: two members without a certificate, one with.

It was seen while working the test flake `a-wide-mesh-watch-test-sometimes-sees-no-notification-wake`. The instrumentation was a `console.log` in `originate` after the extraction, plus one in `ReactivityForwarderHost.ingestSerialized`, and it has been removed. The run's log is in `tickets/.logs/wide-watch-candidate2.log`, the last run in the file, while the log directory keeps it.

## Expected

The `NOTE:` at `captureCommitCert` says that in a group of three, the coordinating member applies with every commit signature merged and so always holds a full certificate. The two remote members hold two of three. So every commit coordinated by a group member should produce exactly one announcing member. Here the third member's event was missing, or that member applied without the full set.

## What would confirm the cause

Log, per member, for the revision:

- which node coordinated the commit, and whether that node is in the tail's group (the writer's `NetworkTransactor` may have picked a coordinator outside it);
- whether the coordinating member applied it on the consensus broadcast or earlier, and with how many commit signatures;
- whether `captureCommitCert` retained a certificate under `(actionId, tailId)`, and when the change event fired.

Instrumenting `captureCommitCert` and `originate` as above while looping the wide-mesh case should reproduce it within about 20 runs.
