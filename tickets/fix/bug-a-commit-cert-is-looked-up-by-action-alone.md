description: When one write spans several collections (a table and its indexes), each collection is agreed by its own round of signatures, but the node keeps only one signature set per write; a change notification sent for the table can then carry the signatures from the index's round, which a listener in a different group of machines will reject.
files: packages/db-p2p/src/cluster/commit-cert.ts (`CommitCertStore`, `makeClusterCommitCertExtractor`), packages/db-p2p/src/cluster/cluster-repo.ts (`captureConsensusCommitCert`, `captureCommitCert`, `CommitCertificateSink`), packages/db-p2p/src/libp2p-node-base.ts (the `onCommitCertificate` composition beside `createCommitCertStore`), packages/db-p2p/src/cohort-topic/change-bridge.ts
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: In groups no larger than one cohort every collection is agreed by the same machines, so the wrong signature set still verifies and nothing visible goes wrong; the fix touches a public sink (`onCommitCertificate`) for a failure that only bites in larger groups.
----
# A commit certificate is looked up by action alone

`CommitCertStore` (`packages/db-p2p/src/cluster/commit-cert.ts`) keys retained commit certificates by `actionId` only, and `put` overwrites. A transaction writing several collections commits each one as its own consensus record (`TransactionCoordinator.commitPhase`, concurrently), all under one action id, and `ClusterMember` captures each record's certificate (`captureConsensusCommitCert`) just before applying that record. The change bridge resolves a `CollectionChangeEvent`'s certificate with `store.get(event.actionId)` (`makeClusterCommitCertExtractor`).

So on a member that applies the table's record and the index's record concurrently, the order `put(table cert)`, `put(index cert)`, table commit emits, `get(action)` hands origination the index record's certificate for the table's notification. The notification is signed by the index record's cohort, while subscribers judge it against the table tail's root group (`CommitLogTrustAnchor`, reactivity.md § Authentication and integrity). Where those cohorts differ — groups larger than one cohort — the notification is refused and the subscriber wakes only at its next tick.

Inferred from code; confirm by a cohort-topic spec that commits two collections of one action with distinct tail cohorts and checks which certificate the table's notification carries.

## Expected

The certificate a notification carries is the one produced by the consensus record that committed that collection's tail. Key retained certificates by `(actionId, tailId)`: a record's commit operations name their tails, so `captureCommitCert` stores the record's certificate under each of them, and the extractor reads `event.tailId` (the bridge originates only tail-bearing events, `selfAppliedTail`). Check what tail id an invalidation's change event carries before choosing how its certificate (`invalidationActionId`) is stored. `CommitCertificateSink` is also a public node option (`NodeOptions.onCommitCertificate`); passing the tail ids as an extra argument keeps existing sinks working.

This is also what would let storage hold the catch-all change feed until an action's other collections land, which `a-watch-wakes-after-every-collection-of-a-commit-applies` deliberately does not do.
