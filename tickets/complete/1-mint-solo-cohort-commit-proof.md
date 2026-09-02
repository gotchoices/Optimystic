description: A machine that saves data no other machine holds now signs its own receipt for it, so that data can later be copied elsewhere instead of being stranded on one machine. Reviewed, gaps in test coverage closed, and three overstated claims in the documentation corrected.
files: packages/db-p2p/src/cluster/commit-proof.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/cluster-coordinator.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/coordinator-repo-solo-commit-proof.spec.ts, packages/db-p2p/test/commit-proof.spec.ts, packages/db-p2p/test/coordinator-repo-commit-divergence.spec.ts, docs/internals.md, docs/correctness.md
----

# Complete: solo-cohort commit proof (one-peer self-signed proof)

## What shipped

A block's data is stored by a small group of machines (its "cohort") that vote to agree on each
write. Those votes become a durable receipt — a `BlockCommitProof` — that anyone can check offline,
and receivers refuse a pushed block without one (`requirePushCertificate`, on by default). When the
cohort turns out to be a single machine, `CoordinatorRepo.commit` skips voting, and that path used
to produce no receipt at all: a block born on a one-machine cohort could never afterwards be copied
to a second machine. The lone machine now signs a one-peer receipt itself.

Two commit paths changed, deliberately differently:

- **Solo-cohort short-circuit** — `mintSoloCommitProof(peerId, privateKey, message)`
  (`cluster/commit-proof.ts`, beside the verifier so the hash recipe lives once) self-signs the
  promise round then the commit round over a one-peer membership. `ClusterMember` holds the key and
  exposes it as a thin delegate; `CoordinatorRepo.commit` builds a message shaped exactly like the
  multi-peer one (`coordinatingBlockIds` included) and passes the proof through the
  `ICommitProofPersister` contract. No local cluster wired → `undefined` proof → the old proof-less
  behavior, unchanged.
- **Post-consensus local fallback** — NOT self-signed. Consensus genuinely ran on the cohort, so the
  record's real votes are projected via `buildBlockCommitProof(record)` and threaded to storage. A
  one-peer proof here would be a false statement about who committed.

`ClusterCoordinator.getClusterPeerIds` was added so `commit` can log `commit:solo-cohort` with
`{ blockId, cohortSize, soleIsSelf }` — the operator's only way to tell a genuine cohort of one from
degraded routing. `ICoordinatorClusterSeam` names the four coordinator methods `CoordinatorRepo`
consumes, so a hand-written test double that misses a newly-called method now fails to compile
rather than throwing `is not a function` at runtime (which is what cost the implement stage 21
failing specs).

Docs: `docs/internals.md` (*One-peer proofs (solo cohorts)*, plus the certified-push backlog
bullet), `docs/correctness.md` (Theorem 14's *cost of not declaring*), and the `blockTransfer`
option comment in `libp2p-node-base.ts`.

## Review findings

Read both implement commits (`cdc97e53`, `650e98e2`) as a diff before the handoff summary.

### Correctness — nothing wrong found in the shipped behavior

Hand-verified the things a passing suite would not have caught:

- `ICoordinatorClusterSeam` against `ClusterCoordinator`'s real signatures — all four match,
  including `executeClusterTransaction`'s optional `localPendResult` / `localCommitResult` and the
  `MessageOptions` parameter. The seam is the whole set: `grep` confirms `this.coordinator` is used
  at exactly five call sites across four methods.
- The mint's recipe against `ClusterMember.signVote` and `computeCluster{Message,Promise,Commit}Hash`
  — identical payload construction and base64url encoding, and the promise-before-commit ordering is
  genuinely load-bearing (the commit hash's preimage includes the promises map).
- Nothing in the verifier rejects a one-peer proof: no minimum-signer floor, no expiration check
  (the minted message's 30-second `expiration` is inert), and `MAX_PROOF_SIGNERS` is an upper cap
  only.
- `buildBlockCommitProof` on the fallback path reads a record that `executeClusterTransaction`
  resolves only after `executeTransaction` populated its votes, so the projection is genuine.

### Found and fixed in this pass

**Test coverage — the implement stage's own list of gaps, closed.**

- *The post-consensus fallback's proof threading was completely untested, and would have passed
  either way.* `coordinator-repo-commit-divergence.spec.ts`'s `makeRecord` produces pre-v2 records,
  for which `buildBlockCommitProof` returns `undefined` — so the specs covering that branch never
  saw a proof at all. That is a production behavior change with no guard. Added a describe with two
  tests (a membership-v2 record's projection reaches storage; a v1 record yields `undefined` rather
  than an uncertifiable half-proof), and widened the spec's storage double to the
  `ICommitProofPersister` signature so the argument is observable instead of vanishing. Confirmed a
  real guard: stubbing the proof argument to `undefined` fails it.
- *The degraded-routing entry into the solo branch was unexercised.* Added a test whose
  `findCluster` throws — the real production shape, since `isResponsibleForBlock` falls open on a
  throw while `getClusterPeerIds` reports an empty cohort. It pins that the commit still mints and
  retains a verifying proof, and that the log line reads `cohortSize 0 / soleIsSelf false`.
  Confirmed a real guard: gating the mint on `peerCount === 1` fails it.
- *The `commit:solo-cohort` log line's contents were unasserted*, despite the handoff resting its
  main design argument on that line being the operator's discriminator. Both solo tests now assert
  it, via a captured `log` handle.
- *The push round-trip was argued, not demonstrated.* Added a test that runs the retained solo proof
  through `certifyContent(...)` with `proofThresholds(...)` — the exact call `handlePush` makes,
  including the `MAX_PROOF_SIGNERS` cap the raw verifier does not apply.

**Documentation — three claims were false as written.** The implement stage wrote, in
`docs/correctness.md`, `docs/internals.md` and the `blockTransfer` option comment, that a missing
content digest is now "the *only* in-code path that still produces a proof-less revision" and that
"every commit path under current code attaches a proof". It is not: the read-driven promotion in
`StorageRepo.get` (line 288) calls `internalCommit` with no proof argument, promoting a pending the
cohort committed elsewhere. That is legitimate — there is no proof to hand it, and the push
back-fill attaches one to an already-held revision as soon as valid evidence arrives — but a reader
would have concluded the uncertified backlog is bounded more tightly than it is. All three sites now
name that path and its healing mechanism. Not filed as a defect: the behavior is correct and already
designed for.

**Duplication.** `ClusterCoordinator.getClusterSize` re-derived the cohort independently of the new
`getClusterPeerIds` — two `findCluster` calls, two `Object.keys`, one rule. `getClusterSize` now
delegates, so the size a caller branches on and the ids it logs cannot come from different
derivations. Separately, the solo spec had hand-rolled its own `makeClusterPeers` next to the one
`test/support/commit-proof-fixtures.ts` already exports; it now reuses the fixture.

### Considered and deliberately not filed

- **The mint is not gated on "the sole cohort peer is me."** The rationale is recorded at the site
  and holds up: a proof's `peerIds` is already not evidence of cohort membership (documented caller
  obligation #1), so the gate buys no safety, and a failed `findCluster` lands in the same branch —
  gating would open a silent no-proof hole exactly during a routing outage. The stale-one-peer-proof
  risk it does create is a separate confirmed defect already tracked as
  `single-signer-proof-outweighs-corroboration` (in `review/`, its code landed in `2048eb91` /
  `d00ff883`). Not re-filed. Worth recording for a future reader: with `localPeerId` set, a *sole
  peer that is not this node* reaches the branch only through skew between the 60-second
  responsibility cache and the uncached cohort lookup — the dominant degraded case is `cohortSize 0`.
- **`coordinator-repo.ts` is 1937 lines** (`wc -l`), up from the 1122 measured when
  `debt-freshness-state-scattered-across-coordinator-repo` was filed; `commit` alone is ~190. That
  ticket already claims the site, so this is evidence, not a new ticket — appended as a sixth
  measurement arm there, noting that the extraction should now name a commit seam as well as a
  freshness one.
- **No tripwire was added.** The existing `NOTE:` on `ICoordinatorClusterSeam` (test doubles still
  name the private `coordinator` field by string, so a rename would silently stop applying them) is
  still accurate and still conditional on a rename that has not happened. Nothing new met the
  "fine now, only matters if X" bar — the read-driven-promotion gap is a present fact, so it went
  into the docs rather than a `NOTE:`.

### Not verified

The optional out-of-repo scenario `../sereus/packages/integration-tests`
(`strand-membership-closed-strand-e2e.integration.ts`) was not run, for the same reason the
implement stage gave: its own global setup aborts with `Stale build detected` for two `@serfab`
packages, and rebuilding another repository was out of scope. It was corroborating evidence, never
a gate — the push round-trip it would have exercised is now covered at the `certifyContent` gate
directly.

## Verification

- `yarn lint` — clean.
- `yarn lint:docs` — 45 documents, 71 anchored citations, 574 file mentions, 310 links, all resolve.
- `yarn workspace @optimystic/db-p2p exec tsc --noEmit -p tsconfig.json` — clean (the tsconfig
  includes `test`, so the specs type-check too).
- `yarn workspace @optimystic/db-p2p test` — **2511 passing, 49 pending, 0 failing** (2507 before
  this pass; the four new tests are the difference). Baseline before any review edit was also green.
- Both new behavioral guards were mutation-checked: the source was temporarily broken in the two
  ways they exist to catch, each test failed, and the source was restored and re-diffed against
  `HEAD` to confirm nothing was left behind.

No pre-existing failures were encountered, so no `tickets/.pre-existing-error.md` was written.

## Still true after this pass

**Nothing is migrated.** Revisions written before this landed carry no signatures and can never gain
them from a commit — the signatures do not exist to recover. Operators still need the
`requirePushCertificate: false` window on receivers to clear that backlog. What changed is that the
commit path stops adding to it.
