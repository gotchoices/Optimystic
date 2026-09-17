description: A storage machine now refuses a write for a block it is not responsible for, and also refuses when it cannot tell whether it is; it redirects misrouted requests using the same rule the writer uses, and never runs a group transaction for a group it is not part of. Review the refusal paths, the redirect change and the adapted specs.
prereq: writer-and-harness-route-to-the-cohort
files:
  - packages/db-p2p/src/repo/responsibility.ts (new: `ResponsibilityRefusalError` with `kind` 'not-responsible' | 'undetermined' and `blockIds`; `RESPONSIBILITY_TTL_MS`; exported from both `index.ts` and `rn.ts`)
  - packages/db-p2p/src/repo/coordinator-repo.ts (`responsibilityFor` replaces `isResponsibleForBlock` with a three-way answer; `verifyResponsibility` fails closed; soft-serve NOTE in `get` restated; `soloCohortDurability` comment; stale `getClusterSize` seam comment corrected)
  - packages/db-p2p/src/repo/service.ts (`checkRedirect` on the node's key network; `ClusterLookup` replaces `NetworkManagerLike`; `keyNetwork` component replaces `networkManager`; 60 s per-block memo `responsiblePeerIds`; read/write failure posture)
  - packages/db-p2p/src/repo/cluster-coordinator.ts (`assertLocalMemberInCohort`, called from `executeClusterTransaction` right after the cohort lookup)
  - packages/db-p2p/src/libp2p-node-base.ts and packages/db-p2p/src/network/network-manager-service.ts (comments only)
  - packages/db-p2p/test/coordinator-repo-proximity.spec.ts, redirect.spec.ts, cluster-coordinator.spec.ts (new and flipped cases)
  - packages/db-p2p/test/coordinator-repo-write-durability.spec.ts, coordinator-repo-solo-commit-proof.spec.ts (fixtures adapted: the unrouted solo branch is now reached through the cache window, not a thrown lookup)
  - packages/db-p2p/test/util/protocol-stream.ts (new: `encodeJson`, `decodeJson`, `makeServiceStream`, lifted from two identical copies in cluster-error-propagation.spec.ts and repo-service-remote-get-consult.spec.ts)
  - packages/db-p2p/test/real-libp2p.integration.spec.ts, routing-key-convention-divergence.integration.spec.ts (probe the key network instead of `getCluster`; new `blocksRedirected === 0` pin)
  - docs/internals.md §Proximity Verification and the solo-proof paragraph; docs/architecture.md §Proximity verification; docs/correctness.md (commit durability reporting); docs/transactions.md ("A cohort of zero deliberately does not"); packages/db-p2p/docs/cluster.md §Access Control; packages/db-p2p/docs/repo.md §Responsibility K
  - tickets/backlog/debt-network-manager-coordinator-selection-is-a-stale-duplicate.md (arm appended: `getCluster` has no production caller)
----

# What was built

Third of the three tickets from the maintainer's 2026-09-14 decision. The first two made a block's group of responsible machines ("cohort") mean something (a machine is in it only when it is among the nearest) and made the writer route inside it. This one makes the server side act on it.

**Write path fails closed.** `CoordinatorRepo.responsibilityFor` answers `responsible`, `not-responsible` or `undetermined` (the cohort lookup threw). `verifyResponsibility` (`pend`, `cancel`, `commit`) throws `ResponsibilityRefusalError` for either of the last two, naming every offending block. When blocks split between the kinds, `not-responsible` wins (it is a settled misroute) and both lists are logged on `proximity:rejected`. Failed lookups are never cached. No `localPeerId` still skips the check; the comment says that bypass is for wiring without an identity only.

**Read path stays open.** `get` warns only on `not-responsible` and serves on `undetermined`. The soft-serve NOTE now says soft serves are confined to the cache staleness window and gives a revisit condition; no acquisition gate added. The accepted-tradeoff NOTE about two lookups per cold read is unchanged.

**Redirect check uses the writer's rule.** `RepoService.checkRedirect` gets the responsible set from `findCluster` on the node's key network. Where it gets that key network: the `keyNetwork` component, or else the `keyNetwork` attachment on the node injected by `setLibp2p` (the production path, typed through `Partial<OptimysticNodeAttachments>`). The id list is memoized per block key in a 1000-entry `LruMap` for `RESPONSIBILITY_TTL_MS`. A thrown lookup returns `null` for `get` and rethrows for every other op, which aborts the stream. The attached `message.cluster` id list is kept. `NetworkManagerLike` and the `networkManager` component are gone (their only users were this file and `redirect.spec.ts`).

**Cluster coordinator guard.** With a local member wired, `executeClusterTransaction` throws `ResponsibilityRefusalError('not-responsible', [blockId])` when the cohort it just looked up is non-empty and excludes the local peer. This happens before the record is hashed, persisted, or sent to any member. An empty cohort is left to the existing size checks.

# Decisions the reviewer should weigh

- **The guard reuses `ResponsibilityRefusalError`**, not a separate class. The message adds "refusing to coordinate a cluster transaction for a cohort this node is not in: <ids>". `CoordinatorRepo.pend`'s catch sends it through the two stale-rejection classifiers. Both match only `ValidatorRejectionError`, so the guard's error is rethrown unchanged.
- **The TTL constant is shared, the caches are not.** Both sites import `RESPONSIBILITY_TTL_MS`, and a NOTE on the service's memo explains the one-minute disagreement window.
- **No key network yet means handle locally.** The `keyNetwork` attachment arrives after `node.start()`, so the service handles a request locally in that startup window, as it did before when there was no network manager. The served-repo proxy has no coordinator then either. Comment added at the `setLibp2p` injection site.
- **Test helper extraction** (`test/util/protocol-stream.ts`) was not asked for. I did it rather than add a fourth copy. Two other specs (`coordinator-cache-hint`, `peer-address-learning`) keep their own different `streamReplaying` helper.
- **`real-libp2p.integration.spec.ts`'s "benign divergence" assertion** (the `getCluster` cohort is a subset of the `findCluster` cohort) was replaced: each member's `findCluster` includes itself and equals the cohort the entry node redirected to. The churn re-replication case now picks its block with the key network as well.

# Use cases for testing and validation

- Proximity (`test/coordinator-repo-proximity.spec.ts`): pend/cancel/commit refused as `not-responsible` with exact `blockIds`; all non-responsible blocks named; a thrown lookup serves `get` but refuses pend, cancel and commit as `undetermined`, with a message that does not say "Not responsible"; a failed lookup is not cached (two commits, two lookups); a multi-block pend with one throwing block is refused `undetermined` naming only that block; a mixed not-responsible plus throwing pend reports `not-responsible`; the existing cache and solo cases still pass.
- Redirect (`test/redirect.spec.ts`): key network read from the injected node's attachment; pend, commit and cancel handled locally inside the cohort and redirected outside it; one lookup per block across pend, commit and get, and a second block gets its own lookup; the memo still attaches `cluster` to the message; a thrown lookup gives `null` for get and rethrows for pend, commit and cancel, with no memo (three calls, three lookups). End to end through `handleIncomingStream`: a pend and a commit outside the cohort get a redirect payload with addresses and never reach the repo; inside the cohort a pend reaches the repo; a throwing lookup aborts the stream for a pend and still serves a get.
- Cluster coordinator (`test/cluster-coordinator.spec.ts` › "cohort-membership guard"): a 3-peer cohort excluding the local member throws the typed error naming the cohort, with zero member `update` calls and no stored transaction; a cohort including it completes with the local member voting.
- Durability and solo proof specs: the `unrouted` solo branch is reached as it can be now. The responsibility check answers from a view that includes self; then the coordinator's lookup fails or names someone else. Every original assertion is unchanged.

Runs, 2026-09-17:
- db-p2p `yarn test`: 2939 passing, 63 pending, 0 failing (8 failures on the first run were the durability and solo-proof fixtures above, fixed).
- quereus-plugin-optimystic `yarn test`: 966 passing, 13 pending. Its `test:integration`: 971 passing, 8 pending.
- reference-peer `yarn test`: 6 passing.
- Root `yarn build`, `yarn typecheck`, `yarn lint`, `yarn lint:docs` all clean.
- db-p2p `yarn test:integration`: 43 passing, 2 pending, 1 failing. The failure is the timing flake described under Gaps; the relay, lifecycle, redirect round-trip and churn cases all pass.
- Six-node integration spec, a passing run:

```
write summary  { blocks: 24, failures: 0, writerPickOutsideCohort: 0, pendHandledLocally: 7, driverInCohort: 7,
                 blocksRedirected: 0, totalRedirects: 0, blocksWithPhantomHolder: 0, blocksWithCohortGap: 0 }
multi-block    conv-it-multi-a   cohort DQLbeE,KKg8J6  pended by DQLbeE   holders KKg8J6,DQLbeE
               conv-it-multi-b-0 cohort QQFeqW,T2ePxa  pended by QQFeqW*  holders T2ePxa,QQFeqW
read summary   { readOk: 24, readMiss: 0, readThrew: 0, getsHandledRemotely: 21, getChecks: 21, getRedirects: 0,
                 blocksGrownByReads: 0, replicasAddedInsideCohort: 0, replicasAddedOutsideCohort: 0 }
```

- Sereus: `../sereus/packages/integration-tests` now type-checks against this repository (`tsc -p tsconfig.typecheck.json` is clean). The fix that `blocked/sereus-harness-passes-bare-bytes-as-routing-key` asked for appears to have landed there, so that blocked ticket may be stale; a human should confirm and clear it. Ran `npx vitest run src/scenarios/strand-membership-closed-strand-e2e.integration.ts src/scenarios/harness-party-control-cohort.integration.ts`: 2 files, 12 tests passed. Its `@optimystic/*` packages are symlinks into this checkout, and the db-p2p build was fresh.

# Gaps the reviewer should treat as a floor

- **Intermittent failure in the six-node spec, reported as pre-existing** (`tickets/.pre-existing-error.md`). "No read acquires a replica outside the responsible cohort" failed 4 times (13, 4, 15 and 7 extra replicas), each in a run of about 8 s. It then passed 6 times in a row at about 4 s with identical code. Diagnostics showed the extra copies land on nodes that served no read. They are pushed by `RebalanceMonitor`'s growth step, which uses its own cohort rule: FRET's nearest `clamp(ceil(sqrt(estimate)),1,3)` peers (3 here), ignoring `clusterSize` (2 here) and the network-membership filter. The monitor checks 5 s after the last connection event, so only slow runs see it. I did not change the monitor. It is a third responsibility rule this ticket did not unify, and it only diverges when `clusterSize` is below 3.
- **`ResponsibilityRefusalError` is local only.** Over the repo protocol a refusal still aborts the stream, and a remote writer sees a generic failed batch. The transactor behaves the same either way (exclude the peer, re-pick). If a remote writer ever needs to tell a routing fault from a misroute, the error would have to be encoded on the wire.
- **Nothing drives the cache staleness window end to end.** No spec changes a cohort inside the 60 s TTL on a real or mesh network and watches the guard or the `unrouted` class catch the write. The unit specs reach those branches only with doubles.
- **The redirect memo's TTL expiry is not tested.** There is no clock seam in `RepoService`, so only "one lookup inside the TTL" is pinned, not the re-lookup after it.
- **Phantom copies from the old rule are not swept.** Existing deployments may still hold copies of blocks outside their current cohort. Nothing in this ticket removes them, and the project makes no compatibility promise yet.
- **Tripwires recorded as `NOTE:`** — on `responsibilityFor`: if churn makes the one-minute window matter, shorten the TTL rather than look up on every write. On `RepoService.responsibleIds`: why the two caches share a TTL but not storage. The soft-serve NOTE in `get` was restated with a new revisit condition.
