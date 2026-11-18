description: A machine can now join a network as a pure client that reads and writes through the network's storage machines but never stores blocks for others or takes part in agreeing on their writes, so sleeping or read-only devices stay off the critical path of other people's writes.
prereq: a-peer-is-judged-serving-only-by-its-own-identify
architecture: docs/internals.md#client-nodes
files: packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/optimystic-node.ts, packages/db-p2p/src/libp2p-node.ts, packages/db-p2p/src/libp2p-node-rn.ts, packages/db-p2p/src/libp2p-key-network.ts, packages/db-p2p/src/repo/under-replication-drain.ts, packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, packages/db-p2p/test/client-only-node.integration.spec.ts, packages/db-p2p/test/node-service-set.spec.ts, docs/internals.md, docs/optimystic.md, docs/architecture.md, packages/db-p2p/readme.md, packages/quereus-plugin-optimystic/README.md
----

# Client-only node: `NodeOptions.servesBlocks: false`

Requested by Sereus (sereus#63). docs/internals.md §Client nodes is the reference.

## What was built

- `NodeOptions.servesBlocks` (default true). A client registers none of the four storage protocol services (`repo`, `cluster`, `sync`, `block-transfer`), so every node on a build with the storage-claim filter classifies it as not serving from its identify list; it is in no cohort and never coordinates. Serving-only options are ignored on a client with one `node-wiring` log line (`logIgnoredServingOptions`, the one list).
- `createLibp2pNodeBase` split along the serving role: the pre-start storage half is `prepareServingStore` (late-bound seams in `ServingStore.late`), the four service factories are `storageProtocolServices`, and everything post-start that assumes stored blocks moved verbatim into `wireServingRole`. Prepared streams on a client: `repo` only. With `cohortTopic.enabled`, a client runs the subscriber side of reactivity and matchmaking but not origination (no cert store, origination manager or change bridge, no `localChanges` feed); its commit-log trust anchor consults remote peers only (`clientClusterLatest`).
- Types: `OptimysticNodeAttachmentsBase`, with `OptimysticNodeAttachments` (`servesBlocks: true`) and `OptimysticClientNodeAttachments` (`servesBlocks: false`); `OptimysticClientNode`; `createLibp2pNode` overloads on `ClientNodeOptions` / `ServingNodeOptions` / `NodeOptions` in both entries.
- Quereus plugin: `CollectionFactory.registerLibp2pNode` accepts a client with two arguments (`coordinatedRepo` defaults to the node's own); the transactor built over a client has no `localPeerId`, no local change notifier and no local store; `getRepo` throws a named error if a client is ever picked to coordinate.
- Docs: docs/internals.md §Client nodes (new), docs/optimystic.md (role list renames "Client-only" to "Dial-only" and adds the client), docs/architecture.md §Machines that store nothing, both READMEs.

## Tests

- `node-service-set.spec.ts`: a client registers the default service set less the four storage protocol services (pins the invariant that keeps a client out of cohorts).
- `client-only-node.integration.spec.ts` (`OPTIMYSTIC_INTEGRATION=1`, ~5 s): join with two servers; client write/read, server reads it, both servers hold it; no server puts the client in a cohort or picks it as coordinator after that traffic; request count of one write; a client watch woken over the notify socket; a lone client's `createOrOpen` and `open` reject with `FindCoordinatorError`.

## Review findings

**Checked, by reading the implement diff first.** `ticket(implement): client-only-node` touches 19 files; the core is `libp2p-node-base.ts`. I extracted the old post-start span (from `fetchArchiveFromPeer` through the dispute service) from the parent commit and diffed it, whitespace-insensitive, against `wireServingRole`: the only differences are the stated substitutions (`clusterImpl` cast through inline `import()` → typed `member`; the three `let`s → `serving.late.*`; the remote half of the consult extracted to `remoteClusterLatest` with its comment intact; `assertClusterSizeCoupling` moved ahead so a client runs it). Stop wrappers still sit right after their resources. The client paths in `libp2p-key-network.ts` (`selfServes` → `membershipOf` classifies self `foreign`, so the cohort tier, the read tier and the last-resort self tier never pick a client) were read and match the docs. Type surfaces (overloads, union return, attachment shapes, `FactoryNode`) are sound; no `any` added beyond the pre-existing service-factory `components: any`.

**Checked, by running.** `yarn build`, `yarn typecheck`, `yarn lint:docs`, eslint on the changed source files: clean. db-p2p unit suite: 3720 passing, 84 pending, 0 failing. `node-service-set.spec.ts` + `startup-rollback.spec.ts`: 8 passing. `client-only-node.integration.spec.ts` with `OPTIMYSTIC_INTEGRATION=1`: 6 passing. Not re-run: the quereus-plugin-optimystic suite and the other integration specs (the implement stage ran them; this pass changed only a doc comment there and rebuilt the package).

**Minor, fixed in this pass.**
- `packages/db-p2p/readme.md` §Setting Up a Client Node: the `NetworkTransactor` example omitted `retryBackoffBaseMs`, which `CollectionFactory.createNetworkTransactor` passes; a host copying the example got no retry backoff on a declared slow link. Added.
- A client's commits are never followed to full replication (the ledger entry lives on the coordinating server, `recordedBy`, whose full-replication event the client does not hear), so `DurabilityFollower` reports them unfollowed and `onCommitFullyHeld` never fires for them. Not stated anywhere; added a paragraph to docs/internals.md §Client nodes and widened the doc comment on `CollectionFactory.getBlockDurabilityNotifier`.

**Tripwire, parked.** A client given bootstrap peers defaults to FRET's `core` profile (larger neighbour sets, more forwarding), like any node: `NOTE:` at the `fretService` construction in `packages/db-p2p/src/libp2p-node-base.ts`, revisit if FRET maintenance shows up as a cost on client phones.

**Size debt.** `wireServingRole` is about 780 lines and `createLibp2pNodeBase` about 920, in a 2931-line file (`wc -l packages/db-p2p/src/libp2p-node-base.ts`). Already owned by backlog `debt-node-factory-wiring-steps-own-their-teardown`; appended an update to it with the new shape rather than filing anew.

**Implementer's judgment calls, reviewed.**
- `responsibilityK` on the ignored list: agreed — it configures only the `repo` and `cluster` services' redirect checks, which a client does not register.
- Client write cost of 3–4 requests rather than the plan's "one request each": accurately documented, and the integration test pins it. Grouping a read's blocks onto one covering coordinator would cut the refresh to one request; not filed — no current-release anchor asks for client request counts, and it is a db-core read-path change affecting every node, not a client defect.
- Watch wake lag before registration replicates (one cohort gossip round, tick fallback up to 30 s): documented in §Client nodes; same as any watcher outside the root group. No change.
- Storage now acquired after the HLC clock starts: nothing between them holds a resource, so a failure there still leaves nothing to release. Agreed.

**Tests.** Kept both new tests: the service-set case pins the one invariant that keeps a client out of cohorts, and the integration spec is the end-to-end reproduction of the prerequisite's defect plus the documented costs. Nothing cut: the three retyped specs changed only a parameter type. No new tests added — the findings were documentation gaps, not defects with behaviour to pin.

**Pre-existing failure.** The intermittent `substrate-real-libp2p` watch failure the implementer reported was already triaged by the runner (`tess: triage pre-existing test failure`); not re-run here.

**Empty categories.** Resource cleanup and error handling: no new findings — a client acquires no storage lease and its stop wrappers (relay supervisor, prepared streams, reachability gate, cohort-topic teardown) are the shared ones, each installed after its resource. Performance: none beyond the tripwire above — a client builds strictly less than a serving node.
