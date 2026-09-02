----
description: When only one machine holds a piece of data, its writes are saved without the signed receipt that other machines demand before accepting a copy — so that data can never be handed to a second machine. Make the lone machine sign its own receipt.
files: packages/db-p2p/src/cluster/commit-proof.ts, packages/db-p2p/src/cluster/cluster-repo.ts, packages/db-p2p/src/repo/coordinator-repo.ts, packages/db-p2p/src/libp2p-node-base.ts, packages/db-p2p/test/coordinator-repo-solo-commit-proof.spec.ts (new), packages/db-p2p/test/commit-proof.spec.ts, docs/internals.md, docs/correctness.md
difficulty: hard
repro: verified
----

# Mint a one-peer commit proof on the solo-cohort commit path

## The defect, restated

A `BlockCommitProof` is minted in exactly one place today: `ClusterMember.applyConsensusOperation`
projects the consensus `ClusterRecord` via `buildBlockCommitProof` and hands it to
`StorageRepo.commit`, which retains it under `persistProofIfContentMatches`. Two commit paths in
`CoordinatorRepo.commit` pass no proof:

- the **solo-cohort short-circuit** (`getClusterSize(blockIds[0])` returns `<= 1`, so the commit goes
  straight to `this.storageRepo.commit(request, options)` and consensus never runs);
- the **post-consensus local fallback** (the `storageRepo.commit(request, options)` run when the
  local member did not execute during consensus).

`BlockTransferService.handlePush` refuses a pushed block that carries no verifying proof —
`requirePushCertificate` defaults to `true`, logged as `push:reject-uncertified … reason=no-proof` —
so a revision written on either path can never gain a second holder. It is also never confirmed by
`BlockTransferCoordinator.confirmReplicated`, so a rebalance never releases it and a ring shift's
confirm phase aborts on it (`docs/arachnode-ring-handoff.md` § Phase B).

Every workspace starts on one machine, so this is not only pre-proof migration history: current code
keeps producing uncertifiable blocks wherever a write lands on a cohort of one.

### Reproduced in-repo (2026-09-02)

The spec under **Tests** below was written and run against `main`. It fails on its first assertion:

```
1) REPRO solo-cohort commit proof
     retains a verifying proof for a commit on a cohort of one:
   AssertionError: a solo commit must retain a proof: expected undefined to not equal undefined
```

The spec was then removed from the tree so `main` stays green — recreate it as the first step of
this ticket, where it is the reproducing test the fix turns green.

A separate throwaway check confirmed the cryptography works out: a fully-signed **one-signer** proof
(`makeSignedProof(1, commit)` from `test/support/commit-proof-fixtures.ts`) passes
`verifyBlockCommitProofContent` under the production thresholds (`superMajorityThreshold` 0.75,
`simpleMajorityThreshold` 0.5) — `ceil(0.75 × 1) = 1` approve satisfies the promise round and
`1 > 1 × 0.5` satisfies the commit round — and serializes to **830 bytes**. Nothing in the verifier
needs to change.

## The fix (decided)

Mint a real proof over a one-peer membership. A cohort of one is still a cohort; the artifact stays
honest — "one peer, which was the whole cohort at the time, committed these bytes at this revision" —
and remains offline-verifiable from the peer id alone, exactly like every other proof.

### 1. `commit-proof.ts` — the producing sibling of the verifier

Add a minting function beside the verification it must agree with, so the hash recipe lives in one
file:

```ts
export async function mintSoloCommitProof(
	peerId: string, privateKey: PrivateKey, message: RepoMessage
): Promise<BlockCommitProof>
```

It derives `membershipDigestFromIds([peerId])`, then `computeClusterMessageHash`,
`computeClusterPromiseHash` and `computeClusterCommitHash` over that digest — the same helpers
`verifyBlockCommitProofClaim` already imports — signs each round's hash with
`clusterVoteSigningPayload(hash, 'approve')` (base64url-encoded, the way `ClusterMember.signVote`
does it), and returns `{ v: 1, messageHash, message, promises, commits, membershipVersion: 2,
membershipDigest, peerIds: [peerId] }`. The commit hash's preimage includes the *promises* map, so
the promise round must be signed first.

New imports needed in that file: `PrivateKey` from `@libp2p/interface`, `clusterVoteSigningPayload`
from `@optimystic/db-core`, and `toString as uint8ArrayToString` from `uint8arrays/to-string`.

### 2. `ClusterMember` — the key holder

`CoordinatorRepo` has a `localPeerId` but no signing key; `ClusterMember` has both (`peerId` and
`privateKey` are its own constructor fields). Add a thin public delegate:

```ts
async mintSoloCommitProof(message: RepoMessage): Promise<BlockCommitProof>
```

calling the `commit-proof.ts` function with its own id and key. Nothing else moves.

### 3. `CoordinatorRepo` — the two call sites

`LocalClusterWithExecutionTracking` already carries optional methods the local `ClusterMember`
happens to implement (`wasTransactionExecuted`, `getExecutedPendResult`, `getExecutedCommitResult`).
Add `mintSoloCommitProof` the same way, and retain the local cluster on the instance — today the
constructor only binds selected methods into `localClusterRef` for `ClusterCoordinator` and keeps no
field of its own.

**Solo short-circuit.** Build the same message shape the multi-peer path builds, including the
`coordinatingBlockIds` that `ClusterCoordinator.executeClusterTransaction` adds at its choke point,
so a solo artifact is shaped like every other:

```ts
const message: RepoMessage = {
	operations: [{ commit: request }],
	coordinatingBlockIds: [blockIds[0]!],
	expiration: options?.expiration ?? Date.now() + this.DEFAULT_TIMEOUT
};
const proof = await this.localCluster?.mintSoloCommitProof?.(message);
const result = await (this.storageRepo as IRepo & ICommitProofPersister).commit(request, options, proof);
```

The cast is the named `ICommitProofPersister` contract — the identical shape
`ClusterMember.applyConsensusOperation` already uses, and a plain `IRepo` double ignores the extra
argument. `proof` is `undefined` when no local cluster is wired (direct constructors, unit-test
doubles), which is exactly today's behavior.

**Post-consensus local fallback.** Do NOT self-sign here: consensus happened elsewhere, so a
one-peer proof would be a *false* statement about that commit's cohort. Thread the record's REAL
proof instead — `executeClusterTransaction` returns the finalized `record` (its `promises` and
`commits` are populated by `executeTransaction` before it resolves), so `buildBlockCommitProof(record)`
is available and genuine. Pass it to both `storageRepo.commit` calls in that branch. Retention still
runs through `persistProofIfContentMatches`, so a record that never reached threshold simply yields
a proof no verifier accepts; that is the same posture `ClusterMember` already takes when it passes
its projection unconditionally. **State this decision in a comment at the site** — the fix ticket
that raised it asked for the choice to be visible in the code, not only in a ticket.

### 4. Log the cohort composition on the solo path

`ClusterCoordinator.getClusterForBlock` returns an empty peer map when `findCluster` throws, so
`getClusterSize` returns **0** and the `<= 1` branch is also the degraded-routing branch. Mint the
proof there anyway (self genuinely committed these bytes), but emit one line — cohort size, and
whether the sole peer is self — so an operator can tell a real cohort of one from a routing failure.

Gating the mint on "the sole cohort peer is self" was considered and **not** chosen: a proof's peer
list is already not evidence of cohort membership by design (caller obligation #1 in the
`verifyBlockCommitProofClaim` doc comment), so the gate buys no safety while opening a silent
no-proof hole exactly when routing is degraded. It would also need a new public accessor on
`ClusterCoordinator`, since `getClusterSize` discards the peer ids.

## Edge cases, settled

- **Growth from one to many.** Nothing keys proof retention or verification to cohort size, so a
  block with a one-peer proof at rev 3 and a ten-peer proof at rev 4 verifies at both. Pin it with a
  test rather than assuming it.
- **A commit with no `blockDigests`.** The proof is minted, `persistProofIfContentMatches` logs
  `commit:proof-undeclared` and retains nothing. Identical to the consensus path; no special case.
- **Multi-block solo commits.** Only `blockIds[0]`'s cohort size is consulted (existing behavior,
  unchanged). The minted proof's message covers the whole request and storage persists it per block
  under the digest-match rule — again identical to the consensus path.
- **`MAX_PROOF_SIGNERS` and size.** A one-signer proof is the cheapest possible; no new bound. The
  size test in `test/commit-proof.spec.ts` is titled "a 10-peer, two-block, fully-signed proof fits
  far inside MAX_CONTROL_MESSAGE_BYTES" and asserts against that cap, so it pins the multi-peer
  figure and needs no change.
- **Push-path verification cost.** A one-signer proof costs 2 Ed25519 verifies plus the hash
  recomputation per block, against 20 verifies for a ten-peer cohort — that is arithmetic, not a
  measurement. A joiner's first catch-up now does that work per block where it previously did none.
  If it ever shows up in a profile, the per-request bound already flagged in `handlePush`'s NOTE is
  the lever, not this ticket.
- **Existing uncertifiable blocks are NOT migrated by this.** Every store written before this lands
  still holds revisions for which no signature exists. Operators still need the
  `requirePushCertificate: false` window to clear that backlog; what changes is that the backlog
  stops growing. Say so in the review handoff.
- **A stale one-peer proof is a genuine new risk** — a node briefly alone (peers unreachable, not
  absent) mints a proof for a revision the rest of the cohort never saw, and a certified claim
  currently out-ranks a corroborated one at equal revision. That is a separate, confirmed defect
  this ticket makes reachable; it is filed as `single-signer-proof-outweighs-corroboration` and
  should land alongside this. Do not try to solve it here.

## Docs to update

- `docs/internals.md` — the `requirePushCertificate` bullet claims "Any block written again under
  current code gets a proof, so only cold, never-updated blocks stay uncertified." That is false
  today for solo cohorts and becomes true once this lands. Correct it either way, and describe the
  one-peer proof under the "Durable commit proof (`BlockCommitProof`)" section.
- `docs/correctness.md` — the paragraph on the cost of not declaring a content digest enumerates why
  a revision retains no proof; the solo path belongs in that enumeration, as a closed hole.
- `packages/db-p2p/src/libp2p-node-base.ts` — the `blockTransfer` option's doc comment frames the
  strict default purely as a migration concern. Narrow it to pre-fix history.

## Tests

Recreate the reproducing spec at `packages/db-p2p/test/coordinator-repo-solo-commit-proof.spec.ts`.
It failed on `main` and must pass after the fix; drop the "REPRO" framing when you add it.

```ts
import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type {
	ActionId, BlockHeader, BlockId, ClusterPeers, IBlock, IKeyNetwork, Transforms, FindCoordinatorOptions
} from '@optimystic/db-core';
import { canonicalBlockHash } from '@optimystic/db-core';
import { toString as u8ToString } from 'uint8arrays';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { CoordinatorRepo } from '../src/repo/coordinator-repo.js';
import type { ClusterClient } from '../src/cluster/client.js';
import { verifyBlockCommitProofContent } from '../src/cluster/commit-proof.js';
import { PROOF_THRESHOLDS } from './support/commit-proof-fixtures.js';

const BLOCK_ID = 'block-solo-proof' as BlockId;
const COLLECTION_ID = 'solo-proof-collection' as BlockId;
const ACTION = 'action-solo-1' as ActionId;

const makeClusterPeers = (peerIds: PeerId[]): ClusterPeers => {
	const peers: ClusterPeers = {};
	for (const peerId of peerIds) {
		peers[peerId.toString()] = {
			multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
			publicKey: u8ToString(peerId.publicKey?.raw ?? new Uint8Array(), 'base64url')
		};
	}
	return peers;
};

const makeKeyNetwork = (cluster: ClusterPeers): IKeyNetwork => ({
	async findCoordinator(_key: Uint8Array, _options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		throw new Error('not implemented');
	},
	async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
		return { ...cluster };
	}
});

const makeBlock = (payload: string): IBlock => ({
	header: { id: BLOCK_ID, type: 'test', collectionId: COLLECTION_ID } as BlockHeader,
	payload
} as unknown as IBlock);

describe('solo-cohort commit proof', function () {
	this.timeout(5_000);

	it('retains a verifying proof for a commit on a cohort of one', async () => {
		const privateKey = await generateKeyPair('Ed25519');
		const selfPeerId = peerIdFromPrivateKey(privateKey);
		const raw = new MemoryRawStorage();
		const storageRepo = new StorageRepo(id => new BlockStorage(id, raw));
		const coordinated = new CoordinatorRepo(
			makeKeyNetwork(makeClusterPeers([selfPeerId])),
			((_p: PeerId) => ({} as unknown as ClusterClient)) as never,
			storageRepo,
			{ allowUnvalidatedSmallCluster: true },
			undefined,   // localCluster — the fix needs a real one here
			selfPeerId
		);

		const block = makeBlock('hello');
		const transforms: Transforms = { inserts: { [BLOCK_ID]: block }, updates: {}, deletes: [] };
		const pended = await coordinated.pend({ actionId: ACTION, rev: 1, transforms, policy: 'c' });
		expect(pended.success, 'pend must land').to.equal(true);

		const digest = await canonicalBlockHash(block);
		const committed = await coordinated.commit({
			actionId: ACTION, blockIds: [BLOCK_ID], tailId: BLOCK_ID, rev: 1,
			blockDigests: { [BLOCK_ID]: { digest } }
		});
		expect(committed.success, 'commit must land').to.equal(true);

		const proof = await storageRepo.getBlockProof(BLOCK_ID, 1);
		expect(proof, 'a solo commit must retain a proof').to.not.equal(undefined);

		const verdict = await verifyBlockCommitProofContent(
			proof!, { blockId: BLOCK_ID, rev: 1, actionId: ACTION }, block, PROOF_THRESHOLDS);
		expect(verdict.ok, `proof must verify: ${JSON.stringify(verdict)}`).to.equal(true);
	});
});
```

The `localCluster` argument is `undefined` above, which is what makes this a *repro* rather than the
finished test: with no local cluster there is no signing key, so the fix cannot mint. Wire a real
`ClusterMember` (or a minimal double exposing only `mintSoloCommitProof`) into that slot as part of
the fix, and keep an `undefined`-cluster case as a second assertion that the path still commits
successfully while retaining no proof.

Also add to `packages/db-p2p/test/commit-proof.spec.ts`: `mintSoloCommitProof`'s output verifies via
`verifyBlockCommitProofContent` for the exact `(blockId, rev, actionId)` it committed and fails with
`claim-not-in-message` for a neighbouring revision; plus the growth case (one-peer proof at rev N and
a multi-peer proof at rev N+1, both verifying).

## Verification

- `yarn workspace @optimystic/db-p2p test` — the whole package, not only the new spec.
- `yarn build` then `yarn typecheck` from root (typecheck must run after build).
- The scenario that motivated this lives in the sibling `sereus` checkout and is evidence rather
  than a gate here: from `../sereus/packages/integration-tests`, run
  `yarn vitest run src/scenarios/strand-membership-closed-strand-e2e.integration.ts` — two tests
  fail today on the catch-up gap. Run it if that checkout is present; do not block on it if it is not.

## TODO

- Add `mintSoloCommitProof(peerId, privateKey, message)` to `packages/db-p2p/src/cluster/commit-proof.ts`, documented as the producing sibling of the verifier.
- Add the thin `ClusterMember.mintSoloCommitProof(message)` delegate in `packages/db-p2p/src/cluster/cluster-repo.ts`.
- Add `mintSoloCommitProof` to `LocalClusterWithExecutionTracking` as an optional method, and retain the local cluster on `CoordinatorRepo`.
- Mint and pass the proof on `CoordinatorRepo.commit`'s solo short-circuit, building the message with `coordinatingBlockIds`.
- Thread `buildBlockCommitProof(record)` into the post-consensus local fallback's two `storageRepo.commit` calls, with a comment stating why that path is NOT self-signed.
- Log cohort size and whether the sole peer is self on the solo path, so a `findCluster` failure is distinguishable from a genuine cohort of one.
- Recreate `packages/db-p2p/test/coordinator-repo-solo-commit-proof.spec.ts` with a real local cluster wired, plus the no-cluster case.
- Add the `mintSoloCommitProof` round-trip, the replay refusal and the one-peer-then-multi-peer growth case to `packages/db-p2p/test/commit-proof.spec.ts`.
- Correct the `requirePushCertificate` claim in `docs/internals.md`, extend the proof-retention enumeration in `docs/correctness.md`, and narrow the `blockTransfer` option comment in `packages/db-p2p/src/libp2p-node-base.ts`.
- Run `yarn workspace @optimystic/db-p2p test`, then `yarn build` and `yarn typecheck` from root.
- In the review handoff, state plainly that pre-existing uncertifiable blocks are not migrated by this change and still need the `requirePushCertificate: false` window.
