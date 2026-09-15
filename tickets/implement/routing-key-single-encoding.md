description: The client library and the storage servers turn a block's name into a ring position two different ways, so on any network wider than one replica group the client looks for a block on the wrong machines and gets bounced. Make both sides use the servers' way, computed in exactly one place, so the mismatch cannot come back.
prereq:
files:
  - packages/db-core/src/utility/block-id-to-bytes.ts (today `sha256(utf8(id))`; becomes the single routing-key helper returning raw utf8 bytes under a branded type)
  - packages/db-core/src/network/i-key-network.ts:34,41 (`findCoordinator(key: Uint8Array)`, `findCluster(key: Uint8Array)` — take the branded routing key instead of bare bytes)
  - packages/db-core/src/transactor/network-transactor.ts:140,205,215,439,485,557,562,686,952,1089 (every routing site, including `consolidateCoordinators` and `queryClusterNominees`)
  - packages/db-p2p/src/libp2p-key-network.ts:709,972 (`findCoordinator`, `findCluster` — they hash whatever they are given; unchanged in behaviour, changed in parameter type)
  - packages/db-p2p/src/repo/cluster-coordinator.ts:242 (`getClusterForBlock`, raw utf8 today — switch to the helper so it is provably the same bytes)
  - packages/db-p2p/src/repo/coordinator-repo.ts:747 (`isResponsibleForBlock`, raw utf8 today — same)
  - packages/db-p2p/src/repo/service.ts:229-250 (`checkRedirect`, raw utf8 today, with the comment warning against pre-hashing — same, and the comment can now point at the helper)
  - packages/db-p2p/src/network/network-manager-service.ts:311 (`getCluster` — same)
  - packages/db-p2p/src/repo/client.ts:138-160 and packages/db-p2p/src/cluster/client.ts:115 (coordinator-cache keys deliberately matching the pre-hash; their comments go stale)
  - packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/reactivity/topic-bytes.ts:29, origination-manager.ts, subscription-manager.ts:85 (other importers of the helper; reactivity is already raw utf8 and pinned by `test/reactivity/topic-bytes-encoding.spec.ts`)
  - packages/db-p2p/test/routing-key-convention-divergence.spec.ts:90 (the assertion "the two coordinates never coincide" flips to "always coincide" — that is the regression pin)
  - packages/db-p2p/test/routing-key-convention-divergence.integration.spec.ts (six real nodes; read-side redirect counts should drop to zero after this lands; gated on OPTIMYSTIC_INTEGRATION=1)
  - packages/db-p2p/test/redirect.spec.ts:25 (`blockKeyMapKey` helper — use the shared helper)
  - packages/db-core/test/network-transactor.spec.ts, commit-digest-threading.spec.ts, packages/db-p2p/test/coordinator-cache-hint.spec.ts, coordinator-repo-integration.spec.ts (other importers)
difficulty: medium
----

# Decision (2026-09-14, maintainer)

This is arm A of `blocked/writer-and-servers-disagree-on-where-a-block-lives`, now decided: **the routing convention is raw utf8 of the block id, the servers' convention.** Arm B (self in the cohort only when genuinely nearest) is `plan/self-in-cohort-only-when-nearest`, which depends on this ticket and must not ship before it.

# What to change

1. **One helper, one type.** Replace the body of `blockIdToBytes` with `new TextEncoder().encode(blockId)` and rename it to something that says what it is (`routingKeyBytes` or similar). Return a branded type (`RoutingKey`, a `Uint8Array` with a phantom brand) so nothing can pass arbitrary bytes into cohort selection. It becomes synchronous; drop the `await`s at every call site.
2. **The key-network interface takes the branded type.** `findCluster` and `findCoordinator` on `IKeyNetwork` accept `RoutingKey`. `Libp2pKeyPeerNetwork` still hashes internally (FRET wants a ring coordinate); that is now the only hash on the path.
3. **Every server-side site uses the helper** rather than its own `TextEncoder` call, so the "same bytes" property is enforced by the type rather than by convention.
4. **Cache keys.** The coordinator caches in `repo/client.ts` and `cluster/client.ts` key on the pre-hash today. Key them on the block id string, or on the helper's output, and rewrite their comments.
5. **Flip the divergence spec.** The first assertion in the unit spec becomes "the two coordinates always coincide"; the ring-size sweep should then report zero disagreements at every width. Keep the integration spec's instrumentation; its read-side table should show zero redirects and zero extra replicas from soft-served reads.

# Why the migration is small

Nothing durable is keyed by the double hash. Servers have always placed and judged blocks at the single hash, so the data is already where the servers think it is. The only double-hash-keyed state is the in-memory, TTL-bounded coordinator caches. A mixed-version rollout keeps working: an old client keeps misrouting and being redirected exactly as today. Confirm this during implementation by grepping for every consumer of the helper's output that persists it; the reactivity topic bytes are already raw and pinned by a spec.

# Edge cases & interactions

- **Collection header blocks** have the collection name as their id, so their routing key is now the utf8 name. Confirm nothing assumed a fixed 32-byte key length (FRET hashes it, so it should not matter, but check `getNeighborIdsForKey` and any key-length assertions).
- **Reactivity** already uses raw utf8 (`topic-bytes.ts`) and its spec pins that; it should be able to import the shared helper without changing bytes. Do not change its output.
- **Coordinator-cache hint spec** (`coordinator-cache-hint.spec.ts`) asserts on cache keys; expect it to need updating rather than the code.
- **Mesh harness** (`packages/db-p2p/src/testing`) has its own key network; make sure it takes the branded type too, or the harness silently keeps a second convention.
- **Sereus** builds one key network per node and shares it between the transactor and the consensus path (see `../sereus/docs/architecture.md` "One key network per node"); after this change both consumers genuinely agree, which was that consolidation's stated intent. No sereus change should be needed, but run its `strand-membership-closed-strand-e2e` if convenient.
- **`RepoService.checkRedirect` on writes** still never fires after this ticket, because the writer still always self-coordinates (arm B). Do not try to make it fire here.

# TODO

- [ ] Rename and retype the helper; make it synchronous; brand the return type.
- [ ] Retype `IKeyNetwork.findCluster` / `findCoordinator`; fix every implementer (libp2p key network, mesh harness, any test doubles).
- [ ] Route every site in `files:` through the helper; remove the ad-hoc `TextEncoder` calls and the stale "do not pre-hash" comments, or point them at the helper.
- [ ] Rekey the two coordinator caches; rewrite their comments.
- [ ] Flip the unit spec's first assertion; confirm the ring-size sweep reports zero divergence.
- [ ] Run the integration spec with `OPTIMYSTIC_INTEGRATION=1`; record the new read-side table in the review handoff.
- [ ] `yarn build && yarn test` across the workspace; `yarn lint`.
