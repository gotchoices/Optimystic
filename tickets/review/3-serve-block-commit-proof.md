description: A machine answering a request for a copy of a record now sends along the group's signed approval it had stored beside it, so the asker gets something it can check on its own.
files: packages/db-p2p/src/storage/block-archive.ts, packages/db-p2p/src/storage/struct.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/cluster/commit-proof.ts, packages/db-p2p/src/cluster/quorum-restore.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/test/block-archive-proof.spec.ts, packages/db-p2p/test/support/commit-proof-fixtures.ts, packages/db-p2p/test/commit-proof.spec.ts
difficulty: medium
----

# Carry the commit proof on the repair wire

Both block-repair wires now carry the `BlockCommitProof` that `persist-block-commit-proof` put on
disk. **No decision logic changed** — a proof reaches both repair stages and is not read by anything
that decides. Honouring it is `accept-certified-claims-in-repair`.

## What landed

### The archive wire

- **`ArchiveRevisions`** (`storage/struct.ts`) gains `proof?: BlockCommitProof`, documented with the
  three legitimate reasons it can be absent (pre-proof revision, diverged member, un-upgraded peer).
  It sits **inside** the revision entry, so a proof and the `(rev, actionId)` it certifies travel
  together by construction of the shape.
- **`singleRevisionArchive(blockId, source, block, proof?)`** — one new optional parameter, no second
  builder, per the ticket's instruction.
- **`serveBlockArchive`** takes `ArchiveServingRepo = IRepo & { getBlockProof?(...) }` — the
  structural widening with an **optional** method, so plain-`IRepo` test doubles keep working.
- **`servableProof(repo, blockId, latest)`** — new exported helper, the single proof-lookup rule.
  Fails closed to "no proof" (never to "no archive") on: no accessor, a throwing lookup, or a stored
  proof whose own message does not name this `(blockId, rev, actionId)`. That last is the serving
  assertion the ticket asked for, and it is a real guard against publishing an artifact that can only
  fail verification.
- **`proofClaimsCommit(proof, claim)`** — exported from `cluster/commit-proof.ts`, delegating to the
  same private `findClaimedCommitOp` the verifier's claim step uses, so the cheap structural check
  and full verification cannot disagree about which operation a claim names.
- **`StorageRepo.getBlockProof(blockId, rev)`** — public, delegates to block storage.

### The latest-query wire

- **`CertifiedActionRev = ActionRev & { proof?: BlockCommitProof }`** and
  **`latestClaimFromArchive(archive)`** both live in `storage/block-archive.ts`;
  `coordinator-repo.ts` re-exports the type so it still reads next to `ClusterLatestCallback`.
  **This is a deviation from the ticket**, which asked for the type beside the callback. Reason: the
  remote producer previously hand-rolled the archive read inline (`Object.keys(...).map(Number)`,
  `Math.max`, reach into `revisions[maxRev]`) — a third place reading the archive shape, which is
  exactly the drift `singleRevisionArchive` exists to prevent. Extracting the projection made it
  unit-testable and put the claim and its proof on one read of one entry.
- **`ClusterLatestCallback`** now returns `CertifiedActionRev | undefined`. **The three-way contract
  is unchanged and was preserved verbatim** — value = claim, resolved `undefined` = holds nothing,
  rejection = silence. `servableProof` never throws, so no proof fault can turn a claim into silence
  or silence into a claim.
- **Both producers in `libp2p-node-base.ts`**: the self short-circuit now calls `servableProof`
  (sharing the mis-pairing guard); the remote path calls `latestClaimFromArchive`.
- **`RevClaim`** (`cluster/quorum-restore.ts`) gains `proof?`, populated by
  `CoordinatorRepo.queryClusterForLatest`. `selectQuorumRev` ignores it — corroboration still counts
  distinct peers exactly as before. `ClusterLatestQuery.local` widened to `CertifiedActionRev` so the
  self proof is not silently type-erased.
- **Mesh harness** (`testing/mesh-harness.ts`): its latest-consult callback now calls the same
  `servableProof`. Parity with the real service is **structural** (one shared function), not two
  implementations compared — see the honesty note below.

## Two findings from implementation

### 1. Pre-existing defect found and filed: `fix/3.5-block-archive-rev-pin-is-a-no-op`

The ticket's edge-case list assumed `serveBlockArchive`'s `rev` argument pins the read. **It does
not, and never has.** It packs `rev` into a synthetic `ActionContext`, and `StorageRepo.get` reads
only that context's `committed` list — never its `rev`. A rev-1 request is answered with the repo's
latest. Found by a test that asserted the pin and failed; confirmed by reading
`StorageRepo.get`'s `if (context)` branch. `RestorationCoordinator` is the one caller that passes a
real `rev`, so it is reachable, not dormant — hence a `fix/` ticket rather than a tripwire.

Not fixed here: honouring the pin changes repair-wire semantics and is its own decision (the ticket
lays out two shapes). What this ticket **does** guarantee, and what the test now pins, is that the
proof always matches the revision *actually* served — so whichever revision the un-honoured pin
resolves to, the archive can never publish a proof paired with a revision it does not certify. The
misleading doc comment on `serveBlockArchive` was corrected in place to state the gap loudly.

### 2. The ticket's size premise was wrong

The ticket says sync responses are bounded by `MAX_CONTROL_MESSAGE_BYTES` (1 MiB). They are not:
that constant bounds the inbound **request** (`sync/service.ts` decoder). The **response** — the one
carrying the archive — is bounded by `MAX_BLOCK_MESSAGE_BYTES` (8 MiB), set by
`SyncClient.requestBlock`. The `NOTE:` at the serving site records the correct constant and the
measured numbers: a whole proof-carrying single-revision archive is **4801 bytes at a 10-peer cohort
and 8851 bytes at 20** (~405 bytes per additional peer), so reaching the cap would take a cohort in
the tens of thousands. No plausible cluster size is near it. The test prints both numbers and asserts
the 20-peer archive stays under 1% of the cap.

## Test coverage — 17 new tests, all green

New spec `test/block-archive-proof.spec.ts` (16) plus one shared-fixture refactor.

- **`serveBlockArchive`** — proof served and verifies against the served block via
  `verifyBlockCommitProofContent`; a repo that retained none omits the key *entirely* (`'proof' in
  entry === false`, not `proof: undefined`) with every pre-proof field untouched; a plain `IRepo`
  with no accessor still serves; **full JSON round trip** (`JSON.stringify` → `JSON.parse`, what the
  sync protocol actually does) and the proof still verifies afterwards, so `message` survives
  `canonicalJson` recomputation; a mis-paired stored proof (wrong rev / wrong block / wrong action,
  written straight to raw storage past the retention rule) is withheld; a throwing lookup still
  serves the archive; the size measurement above.
- **`latestClaimFromArchive`** — proof read from the same entry as the claim; bare claim with no
  `proof` key when none present; highest revision wins and takes *its own* proof when several
  revisions carry different ones; `undefined` for empty/actionless/missing-revisions archives;
  unknown extra fields survive a JSON round trip and are ignored (both compatibility directions —
  the sync protocol is plain `JSON.parse` with no schema that could reject them).
- **`servableProof` / `StorageRepo.getBlockProof`** — right proof, `undefined` for the wrong rev and
  the wrong block.
- **Mesh end-to-end** — a real 3-node cohort commit (with `blockDigests` declared, as a real client
  does): every holder retains a proof that verifies with `verifyBlockCommitProofClaim`, serves it on
  the archive wire, and the consult lookup returns the identical proof.

## Known gaps — please probe these

Written for a reviewer who should treat these tests as a floor.

- **Harness/service parity is structural, not differentially tested.** The mesh harness and
  `serveBlockArchive` share `servableProof`, so they cannot diverge on the proof lookup — but there
  is no test that would catch someone re-hand-rolling the lookup in the harness later. The mesh test
  asserts the two agree at the value level, which is close to tautological given the shared function.
  A stronger pin would compare a real `SyncService` response against a harness answer.
- **The `libp2p-node-base.ts` producers are not directly tested.** They live inline in the node
  composition root and need a live libp2p node. The extracted pieces (`latestClaimFromArchive`,
  `servableProof`) are tested hard; the *wiring* of those pieces into the callback is only covered by
  the existing read-repair specs, which pass unchanged. Worth a skeptical read of both call sites.
- **The transport-error-rejects contract is verified by reasoning, not by a new test.**
  `servableProof` provably never throws (its only two failure modes both return `undefined`), and
  it is awaited *after* the rejection points in both producers. The existing read-repair specs that
  cover rejection→silent all still pass. But no new test exercises "proof lookup fails on a peer that
  would otherwise be silent".
- **No test forces the `serve:proof-claim-mismatch` log line to be observed**, only the withholding
  behaviour. `test/support/capture-log.ts` exists if that is worth pinning.
- **Fixture refactor touched an existing spec.** `test/commit-proof.spec.ts`'s signing harness moved
  to `test/support/commit-proof-fixtures.ts` so the two proof specs cannot verify against
  differently-built proofs. Behaviour-neutral (34 passing before and after), but it is a diff in a
  file this ticket otherwise had no business in — worth confirming nothing was lost in the move.
- **`ClusterLatestQuery.local` now carries a proof nobody uses.** Deliberate (the type stays honest
  about the value), but it is dead weight until the next ticket. Reasonable to argue it should have
  stayed `ActionRev`.

## Validation

All run from the repo root or the `db-p2p` workspace, all green:

- `yarn build` — clean across all packages.
- `yarn lint` — clean (exit 0, no output).
- `yarn workspace @optimystic/db-p2p test` — **2100 passing / 44 pending**, up from 2083 at the start
  of this ticket (+17 new).
- `npx tsc --noEmit` in `packages/db-p2p` (its `tsconfig.json` includes both `src` and `test`, so
  this typechecks the new spec too) — clean.

**Deferred, stated plainly:** the root `yarn test` across every workspace was **not** run — the
prior ticket recorded it exceeding the 10-minute foreground budget, and this run hit its token budget
warning before that point. Changes are confined to `packages/db-p2p` (`src` and `test`), which the
suite above covers in full. `db-core` was not re-run either; nothing in this diff touches it. Both are
worth a CI pass.

No pre-existing test failures were encountered — the one failure during this run was my own test's
wrong assumption about the `rev` pin, which is what surfaced the defect filed above.
