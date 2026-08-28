import { expect } from 'chai'
import { NetworkTransactor } from '../src/transactor/network-transactor.js'
import { blockIdToBytes } from '../src/utility/block-id-to-bytes.js'
import { peerIdFromString } from '../src/network/types.js'
import {
	computeClusterMessageHash,
	computeClusterPromiseHash,
	computeClusterCommitHash,
} from '../src/cluster/membership.js'
import type { Signature } from '../src/cluster/structs.js'
import { Collection } from '../src/collection/index.js'
import { TestTransactor } from '../src/testing/test-transactor.js'
import type {
	ActionBlocks, BlockActionStatus, BlockContentDigests, BlockGets, BlockId, BlockOperation,
	BlockStore, ClusterPeers, CommitRequest, CommitResult, FindCoordinatorOptions, GetBlockResults,
	IBlock, IKeyNetwork, IRepo, ITransactor, PendRequest, PendResult, PeerId, RepoCommitRequest,
	RepoMessage,
} from '../src/index.js'
import { generateRandomActionId } from './generate-random-action-id.js'

/** Stable text key for a coordinator-lookup key so a test can pin block -> peer explicitly. */
const keyHex = (key: Uint8Array): string =>
	Array.from(key).map(b => b.toString(16).padStart(2, '0')).join('')

/** Routes each block id to an explicit ordered preference list of peers, so a test controls both
 *  the first-attempt batching AND where a retry (which excludes the failed peer) lands. */
class MappedKeyNetwork implements IKeyNetwork {
	/** hex(coordinator key) -> ordered peer-id strings */
	private readonly routes = new Map<string, string[]>()

	async route(blockId: BlockId, peers: string[]) {
		this.routes.set(keyHex(await blockIdToBytes(blockId)), peers)
	}

	async findCoordinator(key: Uint8Array, options?: Partial<FindCoordinatorOptions>): Promise<PeerId> {
		const excluded = new Set((options?.excludedPeers ?? []).map(p => p.toString()))
		const pick = (this.routes.get(keyHex(key)) ?? []).find(p => !excluded.has(p))
		if (!pick) throw new Error('No coordinator found')
		return peerIdFromString(pick)
	}

	async findCluster(key: Uint8Array): Promise<ClusterPeers> {
		const peers: ClusterPeers = {}
		for (const p of this.routes.get(keyHex(key)) ?? []) peers[p] = { multiaddrs: [], publicKey: '' }
		return peers
	}
}

/** Records every RepoCommitRequest it receives; optionally throws on the first N commits so a test
 *  can drive the re-batch-onto-another-coordinator retry in `processBatches`. */
class RecordingRepo implements IRepo {
	readonly commits: RepoCommitRequest[] = []
	private calls = 0

	constructor(private readonly throwFirst = 0) { }

	async get(): Promise<GetBlockResults> { return {} }
	async pend(): Promise<PendResult> { throw new Error('unused on the commit path') }
	async cancel(): Promise<void> { }
	async commit(request: RepoCommitRequest): Promise<CommitResult> {
		this.calls++
		if (this.calls <= this.throwFirst) throw new Error('forced transient failure')
		// Snapshot so a later mutation of the caller's object cannot rewrite history.
		this.commits.push(structuredClone(request))
		return { success: true }
	}
}

const sorted = (ids: readonly string[]) => [...ids].sort()
const digestKeys = (request: { blockDigests?: BlockContentDigests }) =>
	sorted(Object.keys(request.blockDigests ?? {}))
const hasDigestsKey = (request: object) =>
	Object.prototype.hasOwnProperty.call(request, 'blockDigests')

const fakeDigest = (id: string, baseRev?: number) =>
	baseRev === undefined ? { digest: `d:${id}` } : { digest: `d:${id}`, baseRev }

describe('commit content digest threading', () => {
	describe('NetworkTransactor per-batch subsetting', () => {
		/** Five routable blocks over three peers; the preference lists also pin where a retry lands. */
		async function setup(throwFirstOnB = 0) {
			const ids = {
				header: 'blk-header' as BlockId,
				tail: 'blk-tail' as BlockId,
				b1: 'blk-one' as BlockId,
				b2: 'blk-two' as BlockId,
				b3: 'blk-three' as BlockId,
			}
			const net = new MappedKeyNetwork()
			await net.route(ids.header, ['peer-A', 'peer-C'])
			await net.route(ids.tail, ['peer-A', 'peer-C'])
			await net.route(ids.b1, ['peer-B', 'peer-C'])
			await net.route(ids.b2, ['peer-C', 'peer-A'])
			await net.route(ids.b3, ['peer-B', 'peer-A'])

			const repos: Record<string, RecordingRepo> = {
				'peer-A': new RecordingRepo(),
				'peer-B': new RecordingRepo(throwFirstOnB),
				'peer-C': new RecordingRepo(),
			}

			const networkTransactor = new NetworkTransactor({
				timeoutMs: 1000,
				abortOrCancelTimeoutMs: 500,
				keyNetwork: net,
				getRepo: (peerId: PeerId) => {
					const repo = repos[peerId.toString()]
					if (!repo) throw new Error(`no repo for ${peerId.toString()}`)
					return repo
				},
			})
			return { ids, repos, networkTransactor }
		}

		it('gives each peer only the digests for the blocks in its own batch', async () => {
			const { ids, repos, networkTransactor } = await setup()
			const blockDigests: BlockContentDigests = {
				[ids.header]: fakeDigest(ids.header),
				[ids.tail]: fakeDigest(ids.tail, 7),
				[ids.b1]: fakeDigest(ids.b1, 7),
				[ids.b2]: fakeDigest(ids.b2),
			}

			const result = await networkTransactor.commit({
				actionId: generateRandomActionId(),
				rev: 8,
				headerId: ids.header,
				tailId: ids.tail,
				blockIds: [ids.tail, ids.b1, ids.b2],
				blockDigests,
			})
			expect(result.success).to.be.true

			// Every recorded request, on every peer, carries exactly the digests for its own payload.
			for (const [peer, repo] of Object.entries(repos)) {
				for (const request of repo.commits) {
					const expected = sorted(request.blockIds.filter(id => blockDigests[id] !== undefined))
					expect(digestKeys(request), `${peer} batch ${request.blockIds.join(',')}`)
						.to.deep.equal(expected)
				}
			}

			// And specifically: b1's cohort (peer-B) never sees b2's declaration, and vice versa.
			expect(repos['peer-B']!.commits.flatMap(digestKeys)).to.deep.equal([ids.b1])
			expect(repos['peer-C']!.commits.flatMap(digestKeys)).to.deep.equal([ids.b2])
		})

		it('carries the header and tail digests on their own single-block batches', async () => {
			const { ids, repos, networkTransactor } = await setup()
			const blockDigests: BlockContentDigests = {
				[ids.header]: fakeDigest(ids.header),
				[ids.tail]: fakeDigest(ids.tail, 7),
				[ids.b2]: fakeDigest(ids.b2),
			}

			await networkTransactor.commit({
				actionId: generateRandomActionId(),
				rev: 8,
				headerId: ids.header,          // not in blockIds -> committed as its own batch
				tailId: ids.tail,              // committed as its own batch
				blockIds: [ids.tail, ids.b2],
				blockDigests,
			})

			// Header and tail both route to peer-A, but as two separate single-block commits.
			const aCommits = repos['peer-A']!.commits
			expect(aCommits.map(c => sorted(c.blockIds))).to.deep.equal([[ids.header], [ids.tail]])
			expect(aCommits.map(digestKeys)).to.deep.equal([[ids.header], [ids.tail]])
			expect(aCommits[0]!.blockDigests![ids.header]).to.deep.equal(fakeDigest(ids.header))
			expect(aCommits[1]!.blockDigests![ids.tail]).to.deep.equal(fakeDigest(ids.tail, 7))
		})

		it('omits the field entirely on a batch whose blocks are all undeclared', async () => {
			const { ids, repos, networkTransactor } = await setup()
			// Partial map: only b2 is declared. The tail and b1 are legal undeclared ids.
			const blockDigests: BlockContentDigests = { [ids.b2]: fakeDigest(ids.b2) }

			const result = await networkTransactor.commit({
				actionId: generateRandomActionId(),
				rev: 8,
				tailId: ids.tail,
				blockIds: [ids.tail, ids.b1, ids.b2],
				blockDigests,
			})
			expect(result.success, 'undeclared ids still commit').to.be.true

			// peer-A got only the tail; peer-B only b1 - neither is declared, so neither request
			// carries the key at all (not an empty object).
			for (const peer of ['peer-A', 'peer-B']) {
				for (const request of repos[peer]!.commits) {
					expect(hasDigestsKey(request), `${peer} must omit blockDigests entirely`).to.be.false
				}
			}
			expect(repos['peer-C']!.commits.flatMap(digestKeys)).to.deep.equal([ids.b2])
		})

		it('omits the field entirely when the commit declares nothing', async () => {
			const { ids, repos, networkTransactor } = await setup()
			await networkTransactor.commit({
				actionId: generateRandomActionId(),
				rev: 8,
				tailId: ids.tail,
				blockIds: [ids.tail, ids.b1],
			})
			for (const repo of Object.values(repos)) {
				for (const request of repo.commits) {
					expect(hasDigestsKey(request)).to.be.false
				}
			}
		})

		it('subsets at send time, so a retry onto another coordinator still gets its own subset', async () => {
			// peer-B throws once. b1 and b3 both batch onto peer-B first; the retry excludes B, and
			// b1 re-resolves to peer-C while b3 re-resolves to peer-A - a SPLIT of the failed batch.
			// A subset computed up front (per original batch) would ship both digests to both peers.
			const { ids, repos, networkTransactor } = await setup(1)
			const blockDigests: BlockContentDigests = {
				[ids.b1]: fakeDigest(ids.b1, 7),
				[ids.b3]: fakeDigest(ids.b3, 7),
			}

			await networkTransactor.commit({
				actionId: generateRandomActionId(),
				rev: 8,
				tailId: ids.tail,
				blockIds: [ids.tail, ids.b1, ids.b3],
				blockDigests,
			})

			// The failed first attempt recorded nothing; the retries landed split across C and A.
			const cCommit = repos['peer-C']!.commits.find(c => c.blockIds.includes(ids.b1))
			const aCommit = repos['peer-A']!.commits.find(c => c.blockIds.includes(ids.b3))
			expect(cCommit, 'b1 retried onto peer-C').to.exist
			expect(aCommit, 'b3 retried onto peer-A').to.exist
			expect(digestKeys(cCommit!)).to.deep.equal([ids.b1])
			expect(digestKeys(aCommit!)).to.deep.equal([ids.b3])
		})
	})

	describe('Collection.sync declares its blocks', () => {
		interface TestAction { id?: string; op?: BlockOperation }

		/** Captures every CommitRequest reaching the transactor, delegating everything else. */
		class CapturingTransactor implements ITransactor {
			readonly commits: CommitRequest[] = []
			constructor(private readonly inner: TestTransactor) { }
			get(b: BlockGets): Promise<GetBlockResults> { return this.inner.get(b) }
			getStatus(a: ActionBlocks[]): Promise<BlockActionStatus[]> { return this.inner.getStatus(a) }
			pend(r: PendRequest): Promise<PendResult> { return this.inner.pend(r) }
			cancel(a: ActionBlocks): Promise<void> { return this.inner.cancel(a) }
			async commit(r: CommitRequest): Promise<CommitResult> {
				this.commits.push(structuredClone(r))
				return this.inner.commit(r)
			}
		}

		/** Blocks carry an `items` array so an `update` action has something valid to splice into. */
		const makeBlock = (store: BlockStore<IBlock>, id: string): IBlock =>
			({ header: store.createBlockHeader('TEST', id), items: [] }) as IBlock

		const initOptions = {
			modules: {
				insert: async (action: { data: TestAction }, store: BlockStore<IBlock>) => {
					store.insert(makeBlock(store, action.data.id!))
				},
				update: async (action: { data: TestAction }, store: BlockStore<IBlock>) => {
					store.update(action.data.id!, action.data.op!)
				},
				remove: async (action: { data: TestAction }, store: BlockStore<IBlock>) => {
					store.delete(action.data.id!)
				},
			},
			createHeaderBlock: (id: string, store: BlockStore<IBlock>) => ({
				header: store.createBlockHeader('TEST', id),
			}),
		}

		it('declares insert and update blocks, and never a delete-only block', async () => {
			const inner = new TestTransactor()
			const transactor = new CapturingTransactor(inner)
			const collection = await Collection.createOrOpen<TestAction>(transactor, 'digest-collection', initOptions)

			// Round 1: create the collection and two blocks. Everything here is an insert.
			await collection.act(
				{ type: 'insert', data: { id: 'block-keep' } },
				{ type: 'insert', data: { id: 'block-drop' } },
			)
			await collection.sync()

			const first = transactor.commits.at(-1)!
			expect(first.blockDigests, 'a create-and-insert commit declares its blocks').to.exist
			expect(digestKeys(first)).to.include.members(['block-keep', 'block-drop'])
			// Inserted blocks are base-independent: no baseRev.
			expect(first.blockDigests!['block-keep']!.baseRev).to.be.undefined
			expect(first.blockDigests!['block-drop']!.baseRev).to.be.undefined
			// Every declared id is one the commit actually carries.
			expect(first.blockIds).to.include.members(digestKeys(first))

			// Round 2: update one block, delete the other, insert a third.
			const commitsBefore = transactor.commits.length
			await collection.act(
				{ type: 'update', data: { id: 'block-keep', op: ['items', 0, 0, ['v']] } },
				{ type: 'remove', data: { id: 'block-drop' } },
				{ type: 'insert', data: { id: 'block-new' } },
			)
			await collection.sync()

			const second = transactor.commits.at(-1)!
			expect(transactor.commits.length).to.be.greaterThan(commitsBefore)
			const keys = digestKeys(second)
			expect(keys, 'updated block is declared').to.include('block-keep')
			expect(keys, 'inserted block is declared').to.include('block-new')
			expect(keys, 'a delete materializes to nothing, so it is never declared').to.not.include('block-drop')
			// The deleted id is still part of the commit - a partial map is legal.
			expect(second.blockIds).to.include('block-drop')
			// An update digest names the committed revision of the base it was computed from.
			expect(second.blockDigests!['block-keep']!.baseRev).to.be.a('number')
			expect(second.blockDigests!['block-new']!.baseRev).to.be.undefined
		})

		it('declares the collection log tail it appends to', async () => {
			const inner = new TestTransactor()
			const transactor = new CapturingTransactor(inner)
			const collection = await Collection.createOrOpen<TestAction>(transactor, 'tail-collection', initOptions)
			await collection.act({ type: 'insert', data: { id: 'tail-block' } })
			await collection.sync()

			const request = transactor.commits.at(-1)!
			expect(request.blockDigests, 'the log tail transform is digested like any other block').to.exist
			expect(digestKeys(request)).to.include(request.tailId)
		})
	})

	// The whole point of putting blockDigests INSIDE the request rather than beside it: the cluster
	// hash helpers canonicalise the message generically, so a peer that has never heard of the field
	// still folds it into the same preimage. This pins that no one later "optimizes" the helpers into
	// a field allowlist, which would silently split the cohort's signatures.
	describe('mixed-version hash guarantee', () => {
		it('hashes a commit message identically after a JSON round-trip by an unaware peer', async () => {
			const message: RepoMessage = {
				operations: [{
					commit: {
						actionId: 'action-1',
						blockIds: ['b1' as BlockId, 'b2' as BlockId],
						tailId: 'b1' as BlockId,
						rev: 4,
						blockDigests: {
							['b1' as BlockId]: { digest: 'aaa', baseRev: 3 },
							['b2' as BlockId]: { digest: 'bbb' },
						},
					},
				}],
				expiration: 1_700_000_000_000,
			}
			// An un-upgraded peer parses the wire bytes with no knowledge of `blockDigests` - it keeps
			// whatever it parsed and hashes that.
			const asUnawarePeerSeesIt = JSON.parse(JSON.stringify(message)) as RepoMessage

			const digest = 'membership-digest'
			const promises: Record<string, Signature> = { 'peer-A': { type: 'approve', signature: 'sig' } }

			for (const membership of [undefined, digest]) {
				const mine = await computeClusterMessageHash(message, membership)
				const theirs = await computeClusterMessageHash(asUnawarePeerSeesIt, membership)
				expect(theirs, 'messageHash').to.equal(mine)

				expect(await computeClusterPromiseHash(theirs, asUnawarePeerSeesIt, membership), 'promiseHash')
					.to.equal(await computeClusterPromiseHash(mine, message, membership))

				expect(await computeClusterCommitHash(theirs, asUnawarePeerSeesIt, promises, membership), 'commitHash')
					.to.equal(await computeClusterCommitHash(mine, message, promises, membership))
			}
		})

		// The round-trip above is only half the property: it stays green even if someone rewrites the
		// canonicalising helpers to hash an explicit allowlist of known fields, because BOTH sides
		// would then drop `blockDigests` alike. What actually pins the generic canonicalisation is
		// that the field CHANGES the hash — a cohort that declares content signs something different
		// from one that declares nothing, which is the whole basis of part 3's member-side check.
		it('folds blockDigests into the hash rather than ignoring it as an unknown field', async () => {
			const commit: CommitRequest = {
				actionId: 'action-1',
				blockIds: ['b1' as BlockId, 'b2' as BlockId],
				tailId: 'b1' as BlockId,
				rev: 4,
			}
			const bare: RepoMessage = { operations: [{ commit }], expiration: 1_700_000_000_000 }
			const declared: RepoMessage = {
				operations: [{ commit: { ...commit, blockDigests: { ['b1' as BlockId]: { digest: 'aaa', baseRev: 3 } } } }],
				expiration: 1_700_000_000_000,
			}
			const altered: RepoMessage = {
				operations: [{ commit: { ...commit, blockDigests: { ['b1' as BlockId]: { digest: 'bbb', baseRev: 3 } } } }],
				expiration: 1_700_000_000_000,
			}

			const bareHash = await computeClusterMessageHash(bare)
			const declaredHash = await computeClusterMessageHash(declared)
			expect(declaredHash, 'declaring content must not hash like declaring nothing').to.not.equal(bareHash)
			expect(await computeClusterMessageHash(altered), 'a different declaration must hash differently')
				.to.not.equal(declaredHash)
		})
	})
})
