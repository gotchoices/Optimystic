description: A machine answering a request for a copy of a record now sends along the group's signed approval it had stored beside it, so the asker gets something it can check on its own.
files: packages/db-p2p/src/storage/block-archive.ts, packages/db-p2p/src/storage/struct.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/cluster/commit-proof.ts, packages/db-p2p/src/cluster/reconcile-block.ts, packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/repo/served-repo-proxy.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/test/block-archive-proof.spec.ts, packages/db-p2p/test/served-repo-proxy.spec.ts, packages/db-p2p/test/support/commit-proof-fixtures.ts, docs/internals.md, docs/correctness.md
----

# Carry the commit proof on the repair wire

Both block-repair wires now carry the `BlockCommitProof` that `persist-block-commit-proof` put on
disk. **No decision logic changed** — a proof reaches both repair stages and is not read by anything
that decides. Honouring it is `accept-certified-claims-in-repair`.

## What landed

### The archive wire

- **`ArchiveRevisions`** (`storage/struct.ts`) gains `proof?: BlockCommitProof`, documented with the
  legitimate reasons it can be absent. It sits **inside** the revision entry, so a proof and the
  `(rev, actionId)` it certifies travel together by construction of the shape.
- **`singleRevisionArchive(blockId, source, block, proof?)`** — one new optional parameter.
- **`serveBlockArchive`** takes `ArchiveServingRepo = IRepo & { getBlockProof?(...) }` — an optional
  method, so plain-`IRepo` test doubles keep working.
- **`servableProof(repo, blockId, latest)`** — the single proof-lookup rule. Fails closed to "no
  proof" (never to "no archive") on: no accessor, a throwing lookup, or a stored proof whose own
  message does not name this `(blockId, rev, actionId)`.
- **`proofClaimsCommit(proof, claim)`** — the cheap structural pairing check, delegating to the same
  private `findClaimedCommitOp` the verifier's claim step uses, so the two cannot disagree.
- **`StorageRepo.getBlockProof(blockId, rev)`** — public, delegates to block storage.
- **`createServedRepoProxy`** (`repo/served-repo-proxy.ts`, added during review) — the object a node
  hands its inbound protocol services, extracted from `createLibp2pNodeBase`. Forwards the four
  `IRepo` members to the coordinated repo and `getBlockProof` unconditionally to local storage.

### The latest-query wire

- **`CertifiedActionRev = ActionRev & { proof?: BlockCommitProof }`** and
  **`latestClaimFromArchive(archive)`** live in `storage/block-archive.ts`; `coordinator-repo.ts`
  re-exports the type so it reads next to `ClusterLatestCallback`. Extracting the projection
  replaced a hand-rolled inline archive read in `libp2p-node-base.ts` and put the claim and its
  proof on one read of one entry.
- **`ClusterLatestCallback`** returns `CertifiedActionRev | undefined`. The three-way contract is
  unchanged: value = claim, resolved `undefined` = holds nothing, rejection = silence.
  `servableProof` never throws, so no proof fault can turn a claim into silence or the reverse.
- **`RevClaim`** (`cluster/quorum-restore.ts`) gains `proof?`, populated by
  `CoordinatorRepo.queryClusterForLatest`. `selectQuorumRev` ignores it — corroboration still counts
  distinct peers exactly as before.
- **Mesh harness** shares `servableProof` with the real serving path.

### Two findings from the implement pass

- **Pre-existing defect filed as `fix/block-archive-rev-pin-is-a-no-op`.** `serveBlockArchive`'s
  `rev` argument does not pin the read: it packs `rev` into a synthetic `ActionContext`, and
  `StorageRepo.get` reads only that context's `committed` list. A rev-1 request is answered with the
  repo's latest. The misleading doc comment was corrected in place. What this ticket does guarantee
  — and what a test pins — is that the proof always matches the revision *actually* served.
- **The ticket's size premise was wrong.** `MAX_CONTROL_MESSAGE_BYTES` (1 MiB) bounds the inbound
  sync *request*; the response is bounded by `MAX_BLOCK_MESSAGE_BYTES` (8 MiB, set by
  `SyncClient.requestBlock`). A whole proof-carrying single-revision archive measures 4801 bytes at
  a 10-peer cohort and 8851 at 20 (~405 bytes per additional peer), so no plausible cluster size is
  near the cap.

## Review findings

### Major — fixed in this pass

**1. The sync service served every repair archive proof-less in production.** `serveBlockArchive`
reads the proof off the repo object it is handed, and `libp2p-node-base` hands `syncService` its
`repoProxy` — a hand-written `IRepo` object literal forwarding `get`/`pend`/`cancel`/`commit` and
nothing else. `servableProof` short-circuits on `typeof repo.getBlockProof !== 'function'`, so on a
real node the archive wire carried no proof at all, and the remote latest-consult (which projects
out of that archive) therefore carried none either. Only the self short-circuit, which reads
`storageRepo` directly, worked. Nothing caught it because every test — including the mesh
end-to-end one — reads a real `StorageRepo` directly, never the object a node actually serves from.

Fixed at the class rather than the instance, following this repo's own precedent (`resolveClusterPolicy`
was extracted for exactly this reason — an object built inside the composition root is unreachable
from every test that does not boot a libp2p node, so nothing asserts on it):

- `createServedRepoProxy` (`src/repo/served-repo-proxy.ts`) is now the one place the proxy is built,
  and it is unit-testable.
- Its local-store parameter is typed `ProofRetainingRepo` (new in `block-archive.ts`) — the same
  shape with `getBlockProof` **required** — so a composition root cannot hand over a store whose
  archives would all be proof-less without a compile error. `ArchiveServingRepo` keeps the accessor
  optional for genuine proof-less servers (test doubles, plain-`IRepo` embedders).
- `SyncServiceComponents.repo` widened from `IRepo` to `ArchiveServingRepo` so the seam names the
  requirement. Non-breaking: `ArchiveServingRepo` accepts every value `IRepo` did.
- Four tests in `test/served-repo-proxy.spec.ts`: the proxy serves an archive whose proof verifies;
  the proof comes from local storage even once a coordinated repo exists (a peer reports what IT
  retained); the four `IRepo` members do route to the coordinated repo once it exists; and a
  `@ts-expect-error` pinning that a plain `IRepo` is not a `ProofRetainingRepo`.

**2. `latestClaimFromArchive` spread an untrusted peer's archive into `Math.max`.** The projection
ran `Math.max(...revisions)` over keys a remote peer chooses. Measured on this Node: the spread
throws `RangeError: Maximum call stack size exceeded` past ~125,000 arguments, and 130,000 minimal
revision entries serialize to 6.34 MiB — inside the 8 MiB `MAX_BLOCK_MESSAGE_BYTES` response cap, so
a peer can make the projection throw without breaking any other protocol rule. The throw lands
inside `clusterLatestCallback`, which the coordinator reads as *silence* from that peer.

This was also a DRY regression the implement pass introduced while claiming to remove one:
`reconcile-block.ts` already had `maxRevision`, folding rather than spreading, with a doc comment
naming this exact hazard. Consolidated into one exported `maxArchiveRevision` in
`block-archive.ts`; `reconcile-block.ts` imports it and its local copy is gone. Pinned by a test
that builds a 130,000-revision archive, asserts the width is reachable within the response cap, and
projects it without throwing.

### Minor — fixed in this pass

**3. Docs were stale, in the one place that made a false claim.** `docs/correctness.md` Theorem 14
still stated that the durable proof "is not persisted with the block, `BlockArchive` has no field
for it, and the sync protocol has no path to serve it" — all three false as of this ticket and its
predecessor. Rewritten to say the artifact exists, is persisted by committing cohort members, and
travels on both repair wires, while the *deciding* is still absent. It also cited
`debt-read-repair-commit-cert-verification`, which is on neither the board nor
`tickets/.pruned-tickets.jsonl`; replaced with the live slug `accept-certified-claims-in-repair`.
`docs/internals.md` gained an **On the repair wires** subsection under the `BlockCommitProof`
section, covering both wires, the serving guard, the local-store rule, and the four legitimate
reasons a proof is absent.

### Tripwire — recorded, not ticketed

**4. A replica obtained by repair retains no proof, so it re-serves the revision proof-less.**
`BlockStorage.saveRestored` writes the served archive's revision, action, and materialization and
drops `entry.proof`. That is *correct today*: nothing has verified the proof, and persisting an
unverified one would let the node re-serve a hostile peer's artifact as evidence it retained itself.
It becomes work the moment verification exists. Parked as a `NOTE:` at `saveRestored`, stated in the
docs subsection above, and appended as an arm to `implement/accept-certified-claims-in-repair`.

### Arms appended to an existing ticket, not filed fresh

Both sites belong to `implement/accept-certified-claims-in-repair` (`reconcile-block.ts` is already
in its `files:`), so per the site-claim rule they were appended there rather than filed:

- **The reconcile path never lifts the proof off the archive it fetched.** `toCandidate` reads
  `rev`, `actionId`, and `block` out of the served entry and discards `entry.proof`. Harmless today,
  but a certified short-circuit added to the shared `selectQuorumRev` would fire on the read path
  and never on the commit-time reconcile path — the two would heal by different rules, which is
  exactly what the shared `quorum-restore.ts` primitives exist to prevent.
- **Persisting the verified proof on repair**, per finding 4.

No new tickets were filed. Both findings resolve at sites an open ticket already claims, and the two
defects found were fixable here.

### Checked, nothing wrong

- **The fixture refactor lost nothing.** The handoff flagged it for confirmation. Diffed builder by
  builder: the only semantic change is `makeMessage`'s fallback, `commit.blockIds[0] ?? BLOCK` →
  `?? commit.tailId`. Every commit in `commit-proof.spec.ts` sets a non-empty `blockIds`
  (lines 41, 337, 533), so `blockIds[0]` is always defined and the fallback never runs.
  `makeSignedProof` swapping an `expect` for a `throw` is the same failure signal. 34 passing in
  that spec, unchanged.
- **The three-way callback contract survives a proof fault.** Re-derived rather than taken on trust:
  `servableProof`'s only two failure modes both `return undefined`, and it is awaited after the
  rejection points in both producers, so a storage fault cannot convert a claim into silence or
  silence into a claim.
- **Layering and import cycles.** `struct.ts` → `cluster/commit-proof.js` is `import type` only;
  the new `reconcile-block.ts` → `storage/block-archive.js` is a value import, but `commit-proof.ts`
  imports nothing from `storage/`, so no cycle. Build and typecheck clean.
- **Wire compatibility both directions.** The existing round-trip and unknown-field tests are
  correct: the sync protocol is plain `JSON.parse` with no schema that could reject an added key,
  and a proof-less archive from an un-upgraded peer projects the same claim it always did.
- **`fix/block-archive-rev-pin-is-a-no-op`** was re-read against the code and is accurate; nothing
  here changes the pin.

### Considered and deliberately not actioned

- **The `serve:proof-claim-mismatch` log line is still unpinned.** The *behaviour* (withholding the
  mis-paired proof) is pinned by two tests; the log is diagnostics only, and the capture helper is
  itself under an open ticket (`backlog/debt-three-copies-of-the-log-capture-test-helper`). Not
  worth adding a third copy of it to assert a log string.
- **`ClusterLatestQuery.local` carries a proof nobody reads.** Deliberate per the implementer — the
  type stays honest about the value rather than silently erasing it, and it is one ticket from use.
- **A narrow behaviour shift in the remote latest-consult.** A peer whose archive has no `revisions`
  key at all used to make the inline projection throw (counted as silence) and now returns
  `undefined` (counted as an absent claim). The surrounding comment already states that intent,
  `success:false` maps the same way, and a structurally broken archive is not worth its own contract
  arm. Left as landed.
- **Harness/service parity is still structural, not differentially tested.** The mesh harness and
  `serveBlockArchive` share `servableProof`, so they cannot diverge on the lookup, but nothing would
  catch someone re-hand-rolling it in the harness later. Finding 1 removed the more dangerous half
  of this gap (the production wiring is now unit-tested); a full `SyncService`-vs-harness
  differential test is more machinery than the remaining risk justifies.

## Validation

- `yarn build` — clean across all packages.
- `yarn lint` — clean (exit 0, no output).
- `yarn workspace @optimystic/db-p2p test` — **2105 passing / 44 pending, 0 failing**, up from 2100
  at the start of the review (+5: four proxy tests, one wide-archive test).
- `npx tsc --noEmit` in `packages/db-p2p` (its tsconfig includes `src` and `test`) — clean.

**Deferred, stated plainly:** the root `yarn test` across every workspace was not run — it exceeds
the 10-minute foreground budget an agent run allows. The diff is confined to `packages/db-p2p`
(`src` and `test`) plus two `docs/` files; `db-core` is untouched. Worth a CI pass.

No pre-existing test failures were encountered.
