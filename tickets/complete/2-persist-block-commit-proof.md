description: A node now keeps the group's signed approval of each write on disk next to the write itself, so anyone can later check offline that a copy of a block really is what the group agreed on — and only keeps that approval when its own copy matches what the group declared.
files: packages/db-p2p/src/cluster/commit-proof.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/storage/raw-store-codec.ts, packages/db-p2p/src/storage/kv-raw-storage.ts, packages/db-p2p/src/storage/i-raw-storage.ts, packages/db-p2p/src/storage/i-block-storage.ts, packages/db-p2p/src/storage/block-storage.ts, packages/db-p2p/src/storage/cached-raw-storage.ts, packages/db-core/src/cluster/membership.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/commit-proof.spec.ts, docs/internals.md
----

# What landed

`BlockCommitProof` — a durable, self-contained artifact proving that a cluster cohort agreed on a
commit, replacing nothing but standing beside the existing in-memory `CommitCert` (60-second TTL,
signs an opaque hash, useless as repair evidence once the moment passes).

- **`packages/db-p2p/src/cluster/commit-proof.ts`** — the artifact (`BlockCommitProof`: the commit
  `RepoMessage` verbatim, promise-round and commit-round vote signatures, membership-v2 digest plus
  the sorted peer-id list; no public keys, since Ed25519 keys recover from peer ids), the projection
  `buildBlockCommitProof(record)`, and two pure verifiers — `verifyBlockCommitProofClaim` (proves
  "block B at revision R under action A was committed by this cohort" without the block bytes) and
  `verifyBlockCommitProofContent` (adds the declared-digest-equals-`canonicalBlockHash` check). Both
  are total on hostile input: every failure is a distinguishable `ProofFailure`, nothing throws.
- **`membershipDigestFromIds`** in `db-core/src/cluster/membership.ts`, with `membershipDigest`
  delegating — one implementation, so an offline verifier reading a stored `peerIds` list and a live
  coordinator reading `ClusterPeers` can never disagree.
- **Storage** — `getBlockProof`/`saveBlockProof` on `IRawStorage`/`KvRawStorage` and the rev-only
  pair on `IBlockStorage`/`BlockStorage`. Proofs ride the transactions store under the synthetic key
  `` `~proof:${rev}` `` (`blockProofActionKey`), so every existing `RawStoreDriver` backend persists
  them with no driver change. Keyed by revision, they outlive the checkpoint sweep.
- **Retention rule** — `StorageRepo.commit(request, options?, proof?)` persists the proof **only
  when the member's own materialization matches the digest the commit op declared**; otherwise it is
  withheld and logged (`commit:proof-digest-mismatch` / `commit:proof-undeclared`), and a persist
  fault never fails a commit that already landed (`commit:proof-persist-failed`). A diverged member
  therefore never serves its divergent bytes as certified.
- **Commit path** — `ClusterMember.applyConsensusOperation` projects the consensus record into a
  proof and hands it down, logging `cluster-member:commit-proof-skipped` for a v1/unversioned record
  whose signer set is unbound and can never be certified.
- **Docs** — a "Durable commit proof" subsection in `docs/internals.md` under the commit path.

Nothing consumes the stored artifact yet: serving it is `serve-block-commit-proof`, honoring it
during repair is `accept-certified-claims-in-repair`, and requiring one on a replica push is
`require-proof-on-block-push`.

## Review findings

### Verified clean

Each of these was the reason for a specific read, not a glance:

- **Failure-path interleaving** (the handoff's first review-focus item). A proof is persisted inside
  `internalCommit` only after that block's own `setLatest`, per block. A mid-batch failure `break`s,
  leaving every unreached block with no proof and no revision. So no stored proof can certify a
  revision this node did not land.
- **Anti-replay** (second focus item). `findClaimedCommitOp` requires the op's `blockIds` to contain
  the claimed id **and** its `actionId` and `rev` to match. `RepoMessage.operations` is a 1-element
  tuple (`db-core/src/network/repo-protocol.ts`), so the loop is redundant today but correct if that
  ever widens. The three replay shapes are pinned by test.
- **Aliasing** (third focus item). `buildBlockCommitProof` carries `record.message`/`promises`/
  `commits` by reference, so the question was whether a later mutation of the live record could alter
  a stored proof. It cannot: `ClusterMember` never mutates a record's maps in place — every vote
  addition rebuilds them (`{ ...record.promises, [id]: sig }` at cluster-repo.ts:906/933/1366/2058)
  and `detectEquivocation` returns fresh maps into a fresh record. `saveBlockProof` also JSON-encodes
  synchronously at the call.
- **Threshold parity with what members actually enforce.** The verifier's promise gate
  (`approves >= Math.ceil(t * n)`) matches `cluster-repo.ts:810`/`859` exactly, and its commit gate
  (`approves > n * simpleMajorityThreshold`) matches `hasMajority`'s `count > total / 2`
  (cluster-repo.ts:877) when passed 0.5. The handoff asked whether the "pass 0.5, not the config's
  0.51" comment reads clearly enough — it does: it names `ClusterMember.hasMajority`, quotes the
  comparison, and says explicitly that 0.51 is wrong here.
- **`~proof:` keys cannot leak into revision walks.** `RawStoreDriver` has no `listTransactions` and
  no transaction delete at all; `recover()` and `materializeBlock` only probe action ids read from the
  revisions store.
- **The `ICommitProofPersister` cast** at cluster-repo.ts:1541 is safe today —
  `libp2p-node-base.ts:809`/`904` passes the real `StorageRepo`, not a decorator — and its
  decorator hazard is already documented, mirroring the sibling `ICommitDigestPreviewer` capability
  probe at cluster-repo.ts:1264.
- **The `libp2p-node-base.ts` side-fix** (`const target: IRepo = …`) is behavior-neutral: that proxy
  is the plain client-facing seam and no proof flows through it.

### Major — filed

- **`tickets/fix/2.5-reserved-proof-key-collides-with-client-action-ids.md`.** The `~proof:`
  namespace is documented as reserved, but nothing enforces it. Action ids are chosen by whoever
  originates the write and are never re-derived or format-checked server-side: `StorageRepo.pend`
  passes `request.actionId` through verbatim (its optional `validatePend` hook checks the transaction
  body and operations hash, never the id), and `BlockStorage.saveRestored` (block-storage.ts:459)
  writes an action id taken verbatim from a peer-supplied `BlockArchive`. A client that commits an
  action literally named `~proof:5` collides with the proof key for revision 5 — in one arrival order
  a later `saveBlockProof` **overwrites a committed transform**, corrupting that block's history for
  every node on that path; in the other the proof is silently destroyed. A forged proof is not among
  the consequences: the verifier is total and reads a transform-shaped value as `malformed-proof`.
  The ticket frames the choice between guarding the untrusted seams and giving proofs their own
  store, and warns that the obvious guard site (`KvRawStorage.saveTransaction`) would break the
  proof's own write path through `CachedRawStorage`. `repro: static`; the ticket names the test that
  would confirm it. Site-claim grep over all open stages found nothing else touching these files.

### Minor — fixed in this pass

- **A Crash-D3 block was the one landing path that retained no proof.** When a crash loses
  `setLatest`, `commit()` self-heals via `recover()` and then *excludes* that block from the
  `internalCommit` loop (its pending record is gone) — so the proof this very call was carrying was
  dropped on the floor. Fixed by extracting the already-landed back-fill into
  `StorageRepo.backFillProof` and calling it from both skip-`internalCommit` partitions (the
  idempotent re-commit branch, which already had it, and the recovered-block loop, which did not).
  Regression test added.
- **The verifier's contract omitted what a passing verdict does *not* prove.** A verdict says "the
  cohort in `peerIds` agreed", never "that is the cohort responsible for this block" — anyone holding
  N keys can stand up their own N-peer cohort and self-certify any block at any revision, and no
  offline check can close that (cohorts are chosen by live placement and rotate). Separately, the
  verifier does one Ed25519 check per approve vote with nothing capping `peerIds`, the vote maps, or
  the message. Both obligations are now stated on `verifyBlockCommitProofClaim` and in
  `docs/internals.md`. **Not** filed as tickets: `4-accept-certified-claims-in-repair` already scopes
  the cohort-overlap capability (its lines 54–57) and the `peerIds` cap (114–115); this pass only made
  the obligation visible at the code site, so a caller who never reads that ticket cannot miss it.
- **The reserved-namespace comment in `raw-store-codec.ts` asserted an invariant that does not
  hold.** Rewritten to state the reservation as an unenforced convention and point at the filed
  ticket, so nobody builds on it meanwhile.
- **`saveReplicatedBlock` had no note about the proof gap**, despite the handoff asking that it be
  confirmed — the gap was documented only in `docs/internals.md`. Added at the site, pointing at
  `require-proof-on-block-push`.
- **Two test gaps closed.** An empty cohort: `ceil(0.75 × 0) = 0` makes the promise gate vacuous, so
  only the strict commit comparison (`0 > 0` is false) stops a signer-less proof — now pinned, so a
  later relaxation of either comparison cannot make one verifiable. And the Crash-D3 back-fill above.

### Tripwire — recorded, not filed

- **Proof storage grows with the square of a commit's block count.** One commit of N blocks stores
  the same proof under each block's `~proof:<rev>` key, and the proof itself carries the op's N
  `blockIds`/`blockDigests`. Measured base cost is 4578 bytes for a 10-peer two-block commit
  (`test/commit-proof.spec.ts` "size"), and nothing bounds `CommitRequest.blockIds` — grep over
  `network-transactor.ts` and the cluster commit path found no cap. Fine at the handful-of-blocks
  batches the transactor produces today. Parked as a `NOTE:` on
  `StorageRepo.persistProofIfContentMatches` with the remedy if it ever trips: store the proof once
  under its `messageHash` and key each revision to a pointer.

### Considered and declined — none

No finding site in this diff carries an accepted-tradeoff `NOTE:`, so nothing was left alone on that
basis. The deviations the handoff flagged for weighing were all judged correct as built: the extra
`malformed-proof` failure value (the spec's enum had no honest fit for structurally hostile input),
mapping an undigestable block to `digest-mismatch` (the bytes provably are not the declared content),
and the threshold documentation.

### Source hygiene

`commit-proof.ts` is 323 lines with every non-obvious decision explained at its site and no comment
restating what the code says. `storage-repo.ts` is 1214 lines and was already the largest file here;
this change is roughly net-neutral on it (the inline back-fill became a named method). No size ticket
was filed — it is not this diff's debt, and no open ticket claims the file.

## Validation

Run after the review's fixes, all green:

- `yarn lint` — clean.
- `yarn build`, `yarn typecheck` — clean across all packages.
- `yarn workspace @optimystic/db-p2p test` — **2083 passing / 44 pending** (up from 2081; the two
  new tests are the empty cohort and the Crash-D3 back-fill).
- `yarn workspace @optimystic/db-core test` — 1423 passing.
- All three `RawStoreDriver` backends, since they are what carries the `~proof:` key:
  `db-p2p-storage-fs` 54 passing / 1 pending, `db-p2p-storage-ns` 51 passing, `db-p2p-storage-web`
  45 passing.

**Deferred, stated plainly:** the root `yarn test` across every workspace exceeded the 10-minute
foreground budget and was stopped rather than run to completion — it is not agent-runnable inside a
ticket. The implement stage recorded a green root run, and this review's changes are confined to
`db-p2p` (plus `docs/`), so the suites above cover them; the remaining workspaces
(`quereus-plugin-*`, `demo`, `reference-peer`, `substrate-simulator`) were not re-run here and are
worth a CI pass.
