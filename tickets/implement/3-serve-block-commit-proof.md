----
description: When one machine asks another for a copy of a record, let the answer include the group's signed approval that was stored alongside it, so the asker has something it can check on its own.
prereq: persist-block-commit-proof
files: packages/db-p2p/src/storage/struct.ts, packages/db-p2p/src/storage/block-archive.ts, packages/db-p2p/src/storage/storage-repo.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/sync/protocol.ts, packages/db-p2p/src/testing/mesh-harness.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/protocol-limits.ts
difficulty: medium
----

# Carry the commit proof on the repair wire

## What this is

`persist-block-commit-proof` puts a `BlockCommitProof` on disk beside each certified revision.
Nothing reads it yet, because neither of the two repair wires can carry it:

- **The archive wire.** `ArchiveRevisions` (`packages/db-p2p/src/storage/struct.ts:19`) is
  `Record<number, { action: ActionTransform, block?: IBlock }>` — no room for a proof.
- **The latest-query wire.** `ClusterLatestCallback` fetches a whole archive over the sync protocol
  and then **discards everything except `(actionId, maxRev)`** (`libp2p-node-base.ts:864-880`).

This ticket widens both. It changes no decision logic — `accept-certified-claims-in-repair` does
that. After this ticket, a proof is available at both repair stages and simply unused.

**Why both.** The lone-holder case — the availability defect this whole chain exists to fix — dies at
the *first* stage if only the second is widened: `CoordinatorRepo.queryClusterForLatest` needs a
corroborated revision before `acquireBlockFromCohort` is ever called. A proof that only reaches the
content stage never gets there.

## Archive shape

```ts
export type ArchiveRevisions = Record<number, {
	action: ActionTransform;
	block?: IBlock;
	/** The cohort's commit proof for this revision, when the serving repo retained one. Absent for a
	 *  pre-proof revision, and for a member whose own materialization diverged from the declared
	 *  digest (it stores no proof — see StorageRepo.internalCommit). */
	proof?: BlockCommitProof;
}>;
```

`singleRevisionArchive(blockId, source, block, proof?)` (`block-archive.ts:22`) gains the parameter.
Note its existing doc comment: the three sites that build this shape had already drifted once, which
is why the shape is a single function. Keep it that way — add the parameter, do not add a second
builder.

`serveBlockArchive` (`block-archive.ts:45`) reads the proof and passes it. It currently takes a bare
`IRepo`, which has no proof accessor, so either widen its parameter to the narrower structural type
it actually needs (`IRepo & { getBlockProof?(blockId, rev) }`) or take an explicit proof-lookup
callback. Prefer the structural widening with an **optional** method, so the mesh harness and unit
test doubles that pass plain repos keep working.

`StorageRepo` needs a public `getBlockProof(blockId, rev): Promise<BlockCommitProof | undefined>`
delegating to the block storage.

Both other builders of this shape must stay consistent: `SyncService` (`sync/service.ts:156`, which
already routes through `serveBlockArchive`) and the mesh harness (`testing/mesh-harness.ts:207`,
same). Confirm nothing else hand-rolls the shape.

## Latest-query wire

```ts
/** A cohort peer's answer to the latest-revision consult: the revision it claims, plus the cohort's
 *  commit proof for that revision when it retained one. */
export type CertifiedActionRev = ActionRev & { proof?: BlockCommitProof };

export type ClusterLatestCallback =
	(peerId: PeerId, blockId: BlockId, context?: ActionContext) => Promise<CertifiedActionRev | undefined>;
```

The **three-way contract must survive verbatim** (documented at `libp2p-node-base.ts:912-918` and on
the callback type): a value is the peer's claim, a resolved `undefined` is "I hold nothing", and a
**rejection is silence** — transport errors must keep propagating, never collapse into `undefined`.
That collapse previously let a slow two-node cohort report a present block as authoritatively absent.

Two producers to update:

- The **self-read short-circuit** (`libp2p-node-base.ts:866-874`) reads local storage directly; add
  the local proof lookup for the revision it returns.
- The **remote path** (`:880-895`) already has `response.archive.revisions[maxRev]` in hand — attach
  `revisionData.proof`.

`CoordinatorRepo.queryClusterForLatest` consumes the callback; widen its `RevClaim` construction to
carry the proof through to `selectQuorumRev` (which ignores it until the next ticket).

## Size

`MAX_CONTROL_MESSAGE_BYTES = 1 MiB` (`protocol-limits.ts`) bounds sync responses, which already carry
whole blocks. Add a proof and the response grows by the measured proof size from
`persist-block-commit-proof`. Confirm against the real number and add a `NOTE:` at the archive
serving site recording the headroom; if a plausible cohort size puts a single-revision archive within
sight of the cap, say so there rather than leaving it implicit.

## Edge cases & interactions

- **A peer with no proof** (pre-proof revision, or a diverged member) serves `proof: undefined`, and
  everything downstream must behave exactly as it does today. Pin it.
- **A peer serving a proof for a *different* revision than the archive's** — a serving bug or a
  hostile peer. The wire carries the proof *inside* the revision entry, so the pairing is structural;
  add a serving-side assertion that the proof looked up is the one keyed by that rev.
- **Mesh harness parity.** `mesh-harness.ts:183-207` deliberately answers fetches through the same
  `serveBlockArchive`. If the harness diverges (serves no proof where the real service serves one),
  every mesh-tier test silently exercises the uncertified path. Pin harness/service parity.
- **Sync protocol serialization.** The archive crosses the wire as JSON. A proof round trip must
  preserve `message` byte-for-byte under `canonicalJson` recomputation — verify a fetched proof still
  verifies after a full serialize/deserialize cycle, not just in-process.
- **Pinned reads.** `serveBlockArchive` pins to a specific `rev` via a synthetic context when `rev` is
  given; the proof looked up must be for that same pinned rev, not the repo's latest.
- **Backwards compatibility both ways.** An un-upgraded peer serves archives with no `proof` key
  (fine, optional). An upgraded peer's archive reaching an un-upgraded reader carries an unknown key
  it ignores — confirm the sync response parser does not reject unknown fields.

## TODO

- Add `proof?: BlockCommitProof` to `ArchiveRevisions` in `storage/struct.ts`.
- Add the `proof` parameter to `singleRevisionArchive`; thread it through `serveBlockArchive`.
- Add `StorageRepo.getBlockProof`; widen `serveBlockArchive`'s repo parameter to the structural type
  with the optional accessor.
- Define `CertifiedActionRev`; widen `ClusterLatestCallback`'s return type; update both producers in
  `libp2p-node-base.ts` (self short-circuit and remote path), preserving the three-way contract.
- Widen `RevClaim` in `quorum-restore.ts` with an optional `proof`, and populate it in
  `CoordinatorRepo.queryClusterForLatest`. No behaviour change yet.
- Confirm the mesh harness serves proofs identically to `SyncService`.
- Tests: archive round trip carries a proof and it still verifies after JSON serialization; a repo
  with no stored proof serves `undefined` and every existing repair test still passes unchanged;
  latest-query returns the proof on both the self and remote paths; a transport error still rejects
  rather than resolving `undefined`; harness/service parity.
- Add the `NOTE:` recording measured archive size against `MAX_CONTROL_MESSAGE_BYTES`.
- Run `yarn build && yarn typecheck && yarn test` from the root.
