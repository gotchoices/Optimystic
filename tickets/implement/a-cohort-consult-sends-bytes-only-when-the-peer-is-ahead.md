description: When a machine checks with the other members of its group whether its copy of a block is current, the other member answers with the whole block even when the asker already has exactly that version. Tell the other member what version the asker holds, so it sends the block's contents only when it has something newer.
prereq:
architecture: docs/transactions.md#lazy-read-repair-window
files: packages/db-p2p/src/sync/protocol.ts, packages/db-p2p/src/sync/service.ts, packages/db-p2p/src/storage/block-archive.ts, packages/db-p2p/src/libp2p-node-base.ts (`clusterLatestCallback`, the `CommitLogTrustAnchor` `latestClaimFrom` adapter), packages/db-p2p/src/repo/coordinator-repo.ts (`ClusterLatestCallback`, `readRepairBlock`, `startHeldBlockConsult`, `runHeldBlockConsult`, `fetchBlockFromCluster`, `queryClusterForLatest`), packages/db-p2p/src/testing/mesh-harness.ts (`clusterLatestCallback`), packages/db-p2p/test/block-archive-proof.spec.ts, docs/transactions.md, docs/internals.md
----

# A cohort consult sends bytes only when the peer is ahead

GitHub [#43](https://github.com/gotchoices/Optimystic/issues/43), arm 2 (split out of plan ticket `feat-a-cohort-consult-batches-blocks-per-peer`). Sibling tickets: `a-cohort-consult-asks-each-peer-about-all-its-blocks-at-once` (builds on this one's wire shape) and `a-member-that-applied-a-commit-counts-its-copy-checked` (independent).

## Today

A coordinator's read-repair consult (`queryClusterForLatest` in `packages/db-p2p/src/repo/coordinator-repo.ts`) asks each cohort peer for its latest revision through `clusterLatestCallback` in `packages/db-p2p/src/libp2p-node-base.ts`, which sends `SyncClient.requestBlock({ blockId, rev: undefined })`. The peer answers with `serveBlockArchive` (`packages/db-p2p/src/storage/block-archive.ts`): a single-revision archive carrying the block **twice** — once as `revisions[rev].action.transform.insert` and once as `revisions[rev].block` — plus the commit proof. The coordinator reads only the claim `(rev, actionId, proof)` out of it (`latestClaimFromArchive`) unless a corroborated revision above its own follows, in which case the acquisition reuses the archive (`ConsultedArchives`, ticket `a-cold-read-reuses-the-consults-archives`).

On a quiet two-member group most background consults find the peer at exactly the revision the asker holds (sereus measured 103–134 `sync` requests a minute between two idle machines of one party, #43). Every one of them ships the block's bytes twice for nothing.

## Design

The asker tells the peer what it holds of the block; the peer sends the claim always, and the block's bytes only when it holds something the asker does not.

### Wire (`packages/db-p2p/src/sync/protocol.ts`)

```ts
export interface SyncRequest {
	blockId: BlockId;
	// …existing fields unchanged…
	/**
	 * What the asker holds of each block it asks about: its newest committed `(rev, actionId)`.
	 * A block missing from the map is one the asker holds nothing of. Present → the server answers
	 * in `answers` and may leave a block's content out (see SyncBlockAnswer). Absent → the
	 * original single-archive answer, exactly as before.
	 */
	held?: Record<BlockId, ActionRev>;
}

/** Why a block's bytes were left out of an answer. `'held'`: the asker already holds the revision served, or a newer one. */
export type SyncContentOmitted = 'held';

export interface SyncBlockAnswer {
	/** The archive served; absent → this peer holds nothing of the block. With `contentOmitted`,
	 *  the archive's revision entry carries no `block` and no `action.transform.insert`. */
	archive?: BlockArchive;
	contentOmitted?: SyncContentOmitted;
}

export interface SyncResponse {
	// …existing fields unchanged…
	/** Present whenever the request carried `held`: one answer per asked block. */
	answers?: Record<BlockId, SyncBlockAnswer>;
}
```

`SyncContentOmitted` is a union of one on purpose: the batching ticket adds `'size'` (bytes left out to keep a multi-block response under the wire cap), which must NOT be treated like `'held'` (see *Interaction with archive reuse* below).

No protocol version bump. A server on an older build ignores `held` and answers `{ success, archive }` with full bytes; the asker treats a response without `answers` exactly as today's answer. A newer server receiving a request without `held` answers the old way. Neither direction can lose information, which is why this does not need the advertise-a-version treatment `tickets/blocked/a-transaction-pends-and-commits-its-collections-together.md` recommends for writes (there, an older build silently dropped collections).

### Serving rule (`packages/db-p2p/src/storage/block-archive.ts`)

Add one function beside `serveBlockArchive`, used by `SyncService` when the request carries `held` (keep `serveBlockArchive` itself unchanged — `RestorationCoordinator`, the mesh harness and `makeFetchArchive` call it):

```ts
export async function serveConsultAnswer(repo: ArchiveServingRepo, blockId: BlockId, held: ActionRev | undefined): Promise<SyncBlockAnswer>
```

It reads the block exactly as `serveBlockArchive` does (unpinned — the consult always asks for the latest), then:

- holds nothing → `{}`;
- the asker holds nothing, OR the served revision is above `held.rev`, OR the served revision equals `held.rev` under a different action id → the full archive, as today;
- otherwise (served revision below `held.rev`, or equal with the same action id) → the archive with the proof but without the block, built by `singleRevisionArchive(blockId, served, undefined, proof)`, and `contentOmitted: 'held'`.

Factor the shared read (`repo.get` with `skipClusterFetch`, the `materialized ?? latest` label, `servableProof`) into one private helper so `serveBlockArchive` and `serveConsultAnswer` cannot drift; the pinned-read refusal stays in `serveBlockArchive` only (the consult is never pinned).

The bytes are omitted only when the peer is **not ahead** of the asker, so an omitted block is never the content an acquisition would need: the read path acquires only a corroborated revision strictly above this node's own (`fetchBlockFromCluster`, the `baselineRev` comparison).

### Asking side

- `ClusterLatestCallback` (`coordinator-repo.ts`) gains an optional fourth parameter, `held?: ActionRev` — what this node holds of the block (`state.latest` of the local read). Thread it from `readRepairBlock` (it has `localEntry.state.latest`) through `startHeldBlockConsult` / `runHeldBlockConsult` and `fetchBlockFromCluster` to `queryClusterForLatest`. `fetchBlockFromCluster` currently takes `localRev`; replace that parameter with `held?: ActionRev` and derive `localRev = held?.rev` inside, rather than carrying both (they must not disagree).
- `clusterLatestCallback` in `libp2p-node-base.ts` sends `{ blockId, rev: undefined, held: held ? { [blockId]: held } : {} }` — always the new form, an empty map meaning "I hold nothing", so a newer peer answers in `answers` either way. On a response with `answers`: project the claim from `answers[blockId].archive` with `latestClaimFromArchive` as today, and attach the archive (see next section). On a response without `answers` (older server): today's code path exactly.
- The self short-circuit is unchanged (it reads local storage; no bytes cross a wire).
- The mesh harness's `clusterLatestCallback` (`packages/db-p2p/src/testing/mesh-harness.ts`) applies the same rule through `serveConsultAnswer`, so mesh specs exercise the omitted shape rather than always attaching bytes.

### Interaction with archive reuse (`a-cold-read-reuses-the-consults-archives`)

An answer with `contentOmitted: 'held'` still carries an archive — a truthful claim on `(rev, actionId)` with no bytes — and is returned with it, so `queryClusterForLatest` puts it into `consulted` and the acquisition does not ask that peer again. That is correct only because of the serving rule above: such a peer's revision is at or below this node's own, so it is never a candidate for the acquisition's content quorum (`createReconcileBlock` in `packages/db-p2p/src/cluster/reconcile-block.ts` votes it on `(rev, actionId)` and it abstains on content, which is exactly the evidence it holds). When the peer IS ahead it sends bytes, so a cold or lagging read still costs one request per peer. Write that reasoning as the comment where the callback attaches an omitted archive, and say there that a future omission reason that can apply to a peer AHEAD of the asker (the batching ticket's `'size'`) must return the claim without the archive instead.

### The commit-log trust anchor

The `latestClaimFrom` adapter for `CommitLogTrustAnchor` in `libp2p-node-base.ts` calls `clusterLatestCallback` with no `held`, so it still receives bytes it throws away. Leave it (it runs once per distant root certificate, not per read) and add a tripwire `NOTE:` there: if anchor lookups ever show in request accounting, give the request a claims-only mode.

### The duplicate copy of the block

When bytes are sent they are still sent twice. That is not this ticket's to change: `BlockStorage.saveRestored` stores `action.transform` and `noDivergentRewrite` compares it, so the restore wire depends on the transform copy. Add a tripwire `NOTE:` at `singleRevisionArchive`: the block rides twice; fine while consults mostly omit bytes; if acquisition or restore traffic ever dominates, serve the content once and rebuild the other copy on receipt.

## Edge cases & interactions

- **Asker holds nothing** (missing block, the cold-read and new-collection-probe paths): always full bytes. Verified by the serving test.
- **Same revision, different action id** (a fork between the two copies): full bytes, so the asker's repair has the peer's content. Serving test.
- **Peer behind the asker**: no bytes; its claim still counts toward corroboration exactly as before. Serving test.
- **Older server**: no `answers` → today's path. By inspection of the callback; there is no two-build fixture (`debt-no-scenario-runs-two-builds-in-one-cohort`).
- **Older asker against a newer server**: no `held` → `serveBlockArchive` unchanged. By inspection.
- **Silence and the three-way contract** (`ClusterLatestCallback`'s doc): unchanged — a transport failure still rejects; `answers[blockId]` with no archive is "holds nothing". A response with `answers` that lacks the asked block is a malformed answer: treat it as silence (reject), never as "holds nothing". By inspection.
- **Proof**: attached in the omitted shape too (`servableProof` for the served revision), so a certified claim stays certified without bytes. Serving test asserts the proof is present.
- **Disclosure of the asker's revision**: a cohort member learns the asker's `(rev, actionId)` for a block it is responsible for. Echoing it back gains a lying peer nothing it could not get by answering "holds nothing" (both read as "nothing ahead"); no new trust is extended. State this in the `held` field's doc.
- **Background consults** (`runHeldBlockConsult`): `held` is captured from the triggering read, like `localRev` is today. By inspection.

## Tests

One table-driven spec for `serveConsultAnswer` (in `packages/db-p2p/test/block-archive-proof.spec.ts`, which already builds a proof-retaining repo): asker holds nothing → bytes; served above held → bytes; equal revision, different action → bytes; equal revision, same action → no bytes, `contentOmitted: 'held'`, proof present; served below held → no bytes; repo holds nothing → no archive. Nothing else new — the existing read-repair and acquisition specs over the mesh harness cover the asking side once the harness uses the same rule.

## TODO

- Add `held`, `SyncBlockAnswer`, `SyncContentOmitted` and `answers` to `packages/db-p2p/src/sync/protocol.ts`.
- Add `serveConsultAnswer` to `packages/db-p2p/src/storage/block-archive.ts`, sharing the read with `serveBlockArchive` through one helper; add the duplicate-copy `NOTE:` at `singleRevisionArchive`.
- `SyncService.handleSyncRequest`: when the request has `held`, answer `{ success: true, answers: { [blockId]: await serveConsultAnswer(...) }, responderId }`; otherwise unchanged. Catch per block as `buildArchive` does (a serve fault → `{}` for that block, logged).
- Thread `held?: ActionRev` through `ClusterLatestCallback`, `readRepairBlock`, `startHeldBlockConsult`, `runHeldBlockConsult`, `fetchBlockFromCluster` (replacing `localRev`), `queryClusterForLatest`.
- Update `clusterLatestCallback` in `libp2p-node-base.ts` (new request form, both response shapes, the archive-reuse comment) and add the anchor-adapter `NOTE:`.
- Update the mesh harness callback to serve through `serveConsultAnswer`.
- Write the serving spec; run `yarn workspace @optimystic/db-p2p test` and `yarn test:integration` from root (the integration specs exercise real `sync` requests).
- Docs: `docs/transactions.md` § Lazy read-repair window — say the consult carries what the asker holds and a peer not ahead answers with the claim and proof alone; the archive-reuse paragraph (find "ConsultedArchives" there) — state that an omitted-bytes answer is reused as a claim. `docs/internals.md` — the paragraph citing `ConsultedArchives` under "A *behind* member actively reconciles". Run `yarn lint:docs`.
