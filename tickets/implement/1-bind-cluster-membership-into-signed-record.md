description: Right now the group of nodes responsible for a piece of data is a private guess by whoever starts a transaction, and that guess is never part of what the nodes cryptographically sign — so two nodes can silently disagree about who is responsible while looking like they agree. Make the responsible group part of the signed transaction identity so any disagreement produces a visibly different transaction instead of a silent split.
prereq:
files:
  - packages/db-p2p/src/repo/cluster-coordinator.ts (createMessageHash ~117-121, makeRecord ~139-166, executeClusterTransaction ~172-244)
  - packages/db-p2p/src/cluster/cluster-repo.ts (computeMessageHash ~529-533, computePromiseHash ~572-576, computeCommitHash ~578-582, mergeRecords ~428-460, validateRecord ~509-523)
  - packages/db-core/src/cluster/structs.ts (ClusterRecord, ClusterPeers, Signature)
  - packages/db-p2p/src/cluster/commit-cert.ts (buildCommitCert — signedPayload preimage)
  - packages/db-p2p/src/cluster/i-transaction-state-store.ts (persisted coordinator/participant records)
  - docs/correctness.md (§2 "Cluster" definition, Theorem 1, Theorem 2)
difficulty: hard
----

## Background — what "cluster membership" means here

A **cluster** is the set of peers responsible for a given block. Today that set lives in
`ClusterRecord.peers` (`packages/db-core/src/cluster/structs.ts`), a map keyed by peer id. The
coordinator fills it by calling `keyNetwork.findCluster(blockId)` at transaction start
(`cluster-coordinator.ts:126-166`) and freezes the result into the record.

The problem this ticket fixes: **the peer set is never covered by any signature.** The three hashes
that anchor a transaction all omit `peers`:

- `messageHash = SHA256(canonicalJson(message))` (`createMessageHash`, coordinator `:117-121`; `computeMessageHash`, member `:529-533`)
- `promiseHash = SHA256(messageHash + canonicalJson(message))` (`computePromiseHash`, `:572-576`)
- `commitHash  = SHA256(messageHash + canonicalJson(message) + canonicalJson(promises))` (`computeCommitHash`, `:578-582`)

Consequence: two coordinators (or one coordinator across churn) can produce the **same
`messageHash`** while disagreeing on the peer set. Honest members that later try to reconcile the two
records hit the hard `throw new Error('Peers mismatch')` in `ClusterMember.mergeRecords`
(`cluster-repo.ts:443-445`) and reject each other instead of converging. Every safety argument in
`docs/correctness.md` (Theorem 1, Theorem 2) assumes "the cluster responsible for block B" is a
well-defined agreed set; nothing enforces that.

## What this ticket does

Bind the peer set into the signed transaction identity. After this change, a record is only valid for
the exact membership it was signed against; two different peer sets produce two **different**
`messageHash`es — i.e. two distinct competing transactions the existing race/conflict machinery already
knows how to resolve — rather than one hash with a silent internal disagreement.

This ticket is the cryptographic-binding half only. The **member-side admission check** that decides
whether a declared peer set is a *legitimate* cluster for the block (the partition / self-shrink
defense) is the follow-up `cluster-membership-admission-gate`, which depends on this one.

### Membership digest

Introduce a canonical **membership digest** derived from the peer set:

```
membershipDigest(peers) = SHA256(canonicalJson( Object.keys(peers).sort() ))   // base64url
```

- Derive it from the **sorted peer-id list only** — not multiaddrs or public keys. Multiaddrs churn and
  public keys are already a function of the id, so including them would make identity unstable without
  adding agreement value. The set of ids IS the membership.
- Compute it once (coordinator `makeRecord`) and carry it on the record; members recompute and check it.

### Record versioning (migration-safe)

Add an explicit membership-binding version to `ClusterRecord` so the change is **not retroactive**:

```ts
export type ClusterRecord = {
  messageHash: string;
  peers: ClusterPeers;
  membershipVersion?: 1 | 2;   // absent/1 = legacy unbound; 2 = peer set bound into the hashes
  membershipDigest?: string;   // present iff membershipVersion === 2; base64url
  message: RepoMessage;
  // ...unchanged...
}
```

Hash functions dispatch on the record's `membershipVersion`:

| hash | v1 (legacy — unchanged) | v2 (bound) |
|------|-------------------------|------------|
| `messageHash` | `SHA256(message)` | `SHA256(message + membershipDigest)` |
| `promiseHash` | `SHA256(messageHash + message)` | `SHA256(messageHash + message + membershipDigest)` |
| `commitHash` | `SHA256(messageHash + message + promises)` | `SHA256(messageHash + message + membershipDigest + promises)` |

(`+` = string concatenation of the existing canonical-JSON images, exactly as today.)

- **New coordinators always emit `membershipVersion: 2`.**
- **Verification dispatches on the record's declared version.** A v1 record (or one with no
  `membershipVersion`) verifies under the legacy hashing exactly as today, so **already-committed history
  and its stored commit certificates keep verifying** — the sync/recovery path (Theorem 14) recomputes
  the commit hash from the stored record and must get the same answer it does now. Records are never
  rewritten.
- The persisted record (coordinator + participant state store, and whatever the transaction log retains
  for later commit-cert verification) **must include `membershipVersion` and `membershipDigest`** so a
  v2 record recovered after a restart re-verifies correctly. Confirm the state-store serialization
  round-trips the new fields.

### `mergeRecords` becomes an invariant, not a divergence path

With the peer set bound into `messageHash`, **equal `messageHash` now implies equal peer set** for v2
records. The `'Peers mismatch'` branch (`cluster-repo.ts:443-445`) therefore can no longer fire on an
honest reconciliation — two honest members with different views now hold two *different* hashes, i.e.
two competing transactions, not one contested record. Keep the check as a **defensive invariant
assertion** (a v2 record whose peers disagree at equal hash is a bug or a hash-collision attack), but:

- For **v2** records, on a peers-mismatch-at-equal-hash, treat it as a protocol violation (log
  loudly; reject the incoming record). It must not be reachable on honest paths.
- Do not silently accept the incoming set. The first-seen / equivocation semantics for signatures are
  unchanged.

`validateRecord` must additionally, for v2 records, recompute `membershipDigest(record.peers)` and
reject if it does not equal `record.membershipDigest` (a record whose declared digest doesn't match its
own peer set is malformed).

### Coordinator changes

- `makeRecord`: set `membershipVersion: 2` and `membershipDigest = membershipDigest(peers)`.
- `createMessageHash`: for v2, fold the digest in per the table. Note `createMessageHash` currently takes
  only `message`; it will need the digest (or the peer set) threaded through from `executeClusterTransaction`
  where both `peers` and `message` are in scope.
- The coordinator's own promise/commit hashing (if it recomputes any) must match the member's v2 hashing.

## Edge cases & interactions

- **Migration / already-committed history.** A v1 record must verify byte-identically to today. Write an
  explicit test that a record with no `membershipVersion` produces the pre-change `messageHash`,
  `promiseHash`, and `commitHash`. Historical commit certs (`buildCommitCert` `signedPayload`) were signed
  over the v1 `commitHash`; those bytes must still verify. Do **not** back-fill or upgrade old records.
- **`signedPayload` reuse by reactivity.** `buildCommitCert` reuses the exact commit-vote preimage as a
  notification signature and never re-signs (`commit-cert.ts:23-30`). For a v2 record the preimage is the
  v2 `commitHash`-derived payload; make sure the member passes the v2 payload so the reused bytes stay
  self-consistent. No change to the concatenation convention.
- **State-store round-trip.** A v2 record persisted mid-transaction and recovered after a crash
  (`recoverTransactions`, coordinator `:780-810`; participant `persistParticipantState`) must re-verify —
  i.e. the store must serialize `membershipVersion` + `membershipDigest`. A v2 record that comes back as
  v1 (fields dropped) would fail its own digest check.
- **Digest determinism.** `membershipDigest` must be independent of peer-map key insertion order and of
  multiaddr/pubkey contents. Test: two `ClusterPeers` objects with the same id set but different
  multiaddrs / insertion order yield the **same** digest; adding or removing one id changes it.
- **Empty / single-peer clusters.** `membershipDigest({})` and single-id sets must be well-defined
  (solo-node and small-cluster paths still run). The digest of an empty set is a fixed constant; a v2
  record with an empty peer set is still a valid (if immediately size-rejected) record.
- **Mixed-version peers during rollout.** A v2 coordinator talking to a not-yet-upgraded v1 member (or
  vice versa) will disagree on hashing. Decide and document the posture: the cluster consensus code is a
  single deployable unit (all cluster members upgrade together), so treat a version the local code does
  not implement as a rejectable record rather than attempting cross-version consensus. State this
  explicitly so the reviewer knows a mixed fleet is out of scope and why.
- **Interaction with the dispute cascade.** The arbitrator/escalation machinery consumes `record.peers`.
  The bound membership object (peers + digest + version) must stay stable and verifiable for that
  consumer; do not strip the new fields when handing a record to the dispute path.

## Key tests (TDD targets)

- v1 record hashes are byte-identical to the pre-change implementation (regression guard for migration).
- v2 `messageHash` differs when the peer-id set differs but `message` is identical — two peer sets ⇒ two
  hashes.
- v2 `messageHash`/`promiseHash`/`commitHash` are stable under multiaddr churn and peer-map key reordering
  (digest depends only on the sorted id set).
- `validateRecord` rejects a v2 record whose `membershipDigest` ≠ `membershipDigest(record.peers)`.
- `mergeRecords` on two v2 records with equal `messageHash` but different `peers` rejects loudly (invariant
  violation) and does not merge.
- A v2 record persisted and recovered from the state store re-verifies (fields round-trip).
- A stored v1 commit cert still verifies under the version-dispatched hashing.

## TODO

- Add `membershipVersion` + `membershipDigest` to `ClusterRecord` (`structs.ts`) and a shared
  `membershipDigest(peers)` helper (place it where both coordinator and member can import it).
- Coordinator: set the fields in `makeRecord`; thread the digest into `createMessageHash` for v2.
- Member: version-dispatch `computeMessageHash` / `computePromiseHash` / `computeCommitHash`; add the
  digest-matches-peers check to `validateRecord`.
- Convert the `mergeRecords` `'Peers mismatch'` branch into a v2 invariant assertion (reject + log), keep
  v1 behavior.
- Ensure the transaction state store serializes the two new fields; verify recovery re-verifies.
- Update `docs/correctness.md`: the §2 "Cluster" definition (membership is bound into transaction
  identity), and Theorem 1 / Theorem 2 proof sketches to state that equal `messageHash` implies equal
  membership for v2 records (this ticket establishes the *binding*; note that *agreement on which set is
  legitimate* is completed by the admission gate follow-up).
- Run `yarn build` and the db-p2p cluster tests; stream output with `tee`.
