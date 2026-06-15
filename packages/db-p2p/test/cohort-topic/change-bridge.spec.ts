import { expect } from 'chai';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { StorageRepo } from '../../src/storage/storage-repo.js';
import { BlockStorage } from '../../src/storage/block-storage.js';
import { MemoryRawStorage } from '../../src/storage/memory-storage.js';
import { makeCohortTopicChangeNotifier } from '../../src/cohort-topic/change-bridge.js';
import { buildCommitCert, createCommitCertStore, makeClusterCommitCertExtractor } from '../../src/cluster/commit-cert.js';
import type {
	BlockId, ActionId, IBlock, BlockHeader, Transforms, CollectionId,
	CollectionChangeEvent, CommitCert, CohortTopicService, ClusterRecord, ClusterPeers, Signature,
} from '@optimystic/db-core';

const makeHeader = (id: string, collectionId = 'collection-1'): BlockHeader => ({
	id: id as BlockId,
	type: 'test',
	collectionId: collectionId as BlockId,
});

const makeBlock = (id: string, collectionId = 'collection-1'): IBlock => ({
	header: makeHeader(id, collectionId),
});

const makeInsertTransforms = (blockId: BlockId, block: IBlock): Transforms => ({
	inserts: { [blockId]: block },
	updates: {},
	deletes: [],
});

/** A minimal CohortTopicService stub: only `onLocalCommit` is exercised by the bridge. */
function stubService(): CohortTopicService {
	const reject = (): Promise<never> => Promise.reject(new Error('cohort service method not used in bridge test'));
	return {
		register: reject,
		renew: reject,
		lookup: reject,
		withdraw: reject,
		cohortGossip: (): never => { throw new Error('not used'); },
		verifier: (): never => { throw new Error('not used'); },
		onLocalCommit: undefined,
	} as unknown as CohortTopicService;
}

describe('cohort-topic: local change-notifier bridge', () => {
	let rawStorage: MemoryRawStorage;
	let repo: StorageRepo;

	beforeEach(() => {
		rawStorage = new MemoryRawStorage();
		repo = new StorageRepo((blockId) => new BlockStorage(blockId, rawStorage));
	});

	// Pend-then-commit one insert through the real StorageRepo so the catch-all change feed fires
	// exactly as it would on a consensus-driven commit (StorageRepo is the single commit funnel).
	const pendAndCommit = async (actionId: string, block: IBlock, rev: number): Promise<void> => {
		await repo.pend({ actionId: actionId as ActionId, transforms: makeInsertTransforms(block.header.id, block), policy: 'c' });
		const result = await repo.commit({ actionId: actionId as ActionId, blockIds: [block.header.id], tailId: block.header.id, rev });
		expect(result.success, 'commit succeeds').to.equal(true);
	};

	const sampleCert = (): CommitCert => ({
		thresholdSig: Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]),
		signers: ['peer-A', 'peer-B'],
		minSigs: 2,
		signedPayload: new TextEncoder().encode('hash-1:approve'),
	});

	it('a commit on a cohort-member node invokes onLocalCommit with the right collectionId/rev', async () => {
		const service = stubService();
		const calls: { event: CollectionChangeEvent; cert: CommitCert }[] = [];
		service.onLocalCommit = (event, cert): void => { calls.push({ event, cert }); };

		const cert = sampleCert();
		makeCohortTopicChangeNotifier({
			source: repo,
			service,
			selfIsCohortMember: (c: CollectionId): boolean => c === ('collection-1' as CollectionId),
			extractCommitCert: (): CommitCert => cert,
		});

		await pendAndCommit('a1', makeBlock('block-1'), 1);

		expect(calls.length, 'origination fired once').to.equal(1);
		expect(calls[0]!.event.collectionId).to.equal('collection-1');
		expect(calls[0]!.event.blockIds).to.deep.equal(['block-1']);
		expect(calls[0]!.event.actionId).to.equal('a1');
		expect(calls[0]!.event.rev).to.equal(1);
	});

	it('a non-member commit is a no-op (this node owns no fan-out for the topic)', async () => {
		const service = stubService();
		const calls: CollectionChangeEvent[] = [];
		service.onLocalCommit = (event): void => { calls.push(event); };

		makeCohortTopicChangeNotifier({
			source: repo,
			service,
			selfIsCohortMember: (): boolean => false,
			extractCommitCert: (): CommitCert => sampleCert(),
		});

		await pendAndCommit('a1', makeBlock('block-1'), 1);

		expect(calls.length, 'a non-member node must not originate').to.equal(0);
	});

	it('forwards the threshold signature byte-for-byte unchanged (never re-signs)', async () => {
		const service = stubService();
		let received: CommitCert | undefined;
		service.onLocalCommit = (_event, cert): void => { received = cert; };

		const original = sampleCert();
		const sigCopy = Uint8Array.from(original.thresholdSig); // snapshot for byte comparison
		makeCohortTopicChangeNotifier({
			source: repo,
			service,
			selfIsCohortMember: (): boolean => true,
			extractCommitCert: (): CommitCert => original,
		});

		await pendAndCommit('a1', makeBlock('block-1'), 1);

		expect(received, 'cert delivered').to.not.equal(undefined);
		// Same object, same bytes, same signers/threshold — the bridge is a pure pass-through.
		expect(received).to.equal(original);
		expect(Array.from(received!.thresholdSig)).to.deep.equal(Array.from(sigCopy));
		expect(received!.signers).to.deep.equal(['peer-A', 'peer-B']);
		expect(received!.minSigs).to.equal(2);
		// signedPayload (the commit-vote preimage reactivity sets digest from) also passes through unchanged.
		expect(Array.from(received!.signedPayload)).to.deep.equal([...new TextEncoder().encode('hash-1:approve')]);
	});

	it('a throwing downstream hook does not break the commit', async () => {
		const service = stubService();
		service.onLocalCommit = (): void => { throw new Error('reactivity origination boom'); };

		makeCohortTopicChangeNotifier({
			source: repo,
			service,
			selfIsCohortMember: (): boolean => true,
			extractCommitCert: (): CommitCert => sampleCert(),
		});

		// The commit itself must still succeed even though origination threw (isolated + logged).
		await pendAndCommit('a1', makeBlock('block-1'), 1);
	});

	it('skips origination (no-op) when no commit cert is retained — never fabricates one', async () => {
		const service = stubService();
		const calls: CollectionChangeEvent[] = [];
		service.onLocalCommit = (event): void => { calls.push(event); };

		makeCohortTopicChangeNotifier({
			source: repo,
			service,
			selfIsCohortMember: (): boolean => true,
			extractCommitCert: (): CommitCert | undefined => undefined,
		});

		await pendAndCommit('a1', makeBlock('block-1'), 1);

		expect(calls.length, 'no cert → no origination').to.equal(0);
	});

	it('does not originate before a reactivity consumer attaches onLocalCommit', async () => {
		const service = stubService(); // onLocalCommit stays undefined
		let extractCalled = false;
		makeCohortTopicChangeNotifier({
			source: repo,
			service,
			selfIsCohortMember: (): boolean => true,
			extractCommitCert: (): CommitCert => { extractCalled = true; return sampleCert(); },
		});

		await pendAndCommit('a1', makeBlock('block-1'), 1);

		// Member gate passes but no hook is attached → cert extraction is never even reached.
		expect(extractCalled, 'no hook → no work').to.equal(false);
	});

	it('still delivers per-collection subscriptions through the decorator (reactive-watch path intact)', async () => {
		const service = stubService();
		const notifier = makeCohortTopicChangeNotifier({
			source: repo,
			service,
			selfIsCohortMember: (): boolean => false, // origination off; we only test delegation
			extractCommitCert: (): CommitCert => sampleCert(),
		});

		const seen: CollectionChangeEvent[] = [];
		const unsub = notifier.onCollectionChange('collection-1' as CollectionId, (e) => seen.push(e));

		await pendAndCommit('a1', makeBlock('block-1'), 1);

		expect(seen.length, 'the per-collection subscriber fired via delegation to the StorageRepo').to.equal(1);
		expect(seen[0]!.collectionId).to.equal('collection-1');

		unsub();
		await pendAndCommit('a2', makeBlock('block-2'), 1);
		expect(seen.length, 'unsubscribe is honored through the decorator').to.equal(1);
	});
});

describe('cohort-topic: cluster commit-cert extraction', () => {
	const sigB64 = (bytes: number[]): string => uint8ArrayToString(Uint8Array.from(bytes), 'base64url');

	const peers = (ids: string[]): ClusterPeers =>
		Object.fromEntries(ids.map(id => [id, { multiaddrs: [], publicKey: '' }]));

	const recordWith = (commits: Record<string, Signature>, peerIds: string[]): ClusterRecord => ({
		messageHash: 'hash-1',
		peers: peers(peerIds),
		// buildCommitCert only reads `commits`; a harmless single op satisfies the non-empty operations tuple.
		message: { operations: [{ get: { blockIds: [] } }], expiration: Date.now() + 30_000 },
		promises: {},
		commits,
	});

	it('buildCommitCert: approve commits only, sorted by signer, concatenated byte-for-byte', () => {
		// Intentionally out of order + a reject that must be excluded.
		const record = recordWith({
			'peer-B': { type: 'approve', signature: sigB64([0xBB, 0xBB]) },
			'peer-A': { type: 'approve', signature: sigB64([0xAA, 0xAA]) },
			'peer-C': { type: 'reject', signature: sigB64([0xCC]), rejectReason: 'nope' },
		}, ['peer-A', 'peer-B', 'peer-C']);

		const payload = new TextEncoder().encode('hash-1:approve');
		const cert = buildCommitCert(record, 2, payload);

		expect(cert.signers, 'reject excluded, ascending order').to.deep.equal(['peer-A', 'peer-B']);
		// thresholdSig = decode(A) ++ decode(B) aligned with signers[i] ↔ chunk i.
		expect(Array.from(cert.thresholdSig)).to.deep.equal([0xAA, 0xAA, 0xBB, 0xBB]);
		expect(cert.minSigs).to.equal(2);
		// The caller-supplied commit-vote preimage rides through unchanged (reactivity's digest source).
		expect(cert.signedPayload, 'same bytes object the caller supplied').to.equal(payload);
		expect(Array.from(cert.signedPayload)).to.deep.equal([...new TextEncoder().encode('hash-1:approve')]);
	});

	it('CommitCertStore: put/get round-trips, TTL-expires, and bounds entries', () => {
		const store = createCommitCertStore({ ttlMs: 1_000, maxEntries: 2 });
		const cert = (n: number): CommitCert => ({ thresholdSig: Uint8Array.from([n]), signers: [`p${n}`], minSigs: 1, signedPayload: Uint8Array.from([n]) });

		store.put('a1' as ActionId, cert(1), 0);
		expect(store.get('a1' as ActionId, 500)).to.deep.equal(cert(1));
		// Past the TTL the entry is gone.
		expect(store.get('a1' as ActionId, 1_001), 'expired by TTL').to.equal(undefined);

		// Cap: inserting a third distinct key evicts the oldest.
		store.put('b1' as ActionId, cert(2), 0);
		store.put('b2' as ActionId, cert(3), 0);
		store.put('b3' as ActionId, cert(4), 0);
		expect(store.get('b1' as ActionId, 0), 'oldest evicted past the cap').to.equal(undefined);
		expect(store.get('b3' as ActionId, 0)).to.deep.equal(cert(4));
	});

	it('makeClusterCommitCertExtractor: resolves the cert for a change event, undefined when absent', () => {
		const store = createCommitCertStore();
		const cert: CommitCert = { thresholdSig: Uint8Array.from([1, 2, 3]), signers: ['p'], minSigs: 1, signedPayload: Uint8Array.from([4, 5, 6]) };
		store.put('a1' as ActionId, cert);
		const extract = makeClusterCommitCertExtractor(store);

		const event = (actionId: string): CollectionChangeEvent => ({
			collectionId: 'collection-1' as CollectionId,
			blockIds: ['block-1' as BlockId],
			actionId: actionId as ActionId,
			rev: 1,
		});

		expect(extract(event('a1'))).to.equal(cert);
		expect(extract(event('missing')), 'no retained cert → undefined (bridge then skips)').to.equal(undefined);
	});

	it('end-to-end: a stored cluster cert flows through the bridge unchanged on commit', async () => {
		const rawStorage = new MemoryRawStorage();
		const repo = new StorageRepo((blockId) => new BlockStorage(blockId, rawStorage));
		const store = createCommitCertStore();

		// Stash the authoritative cert as the cluster member would, keyed by the action being committed.
		const record = recordWith({
			'peer-A': { type: 'approve', signature: sigB64([0x11, 0x22]) },
			'peer-B': { type: 'approve', signature: sigB64([0x33, 0x44]) },
		}, ['peer-A', 'peer-B']);
		const expected = buildCommitCert(record, 2, new TextEncoder().encode('hash-1:approve'));
		store.put('a1' as ActionId, expected);

		const service = stubService();
		let received: CommitCert | undefined;
		service.onLocalCommit = (_event, cert): void => { received = cert; };

		makeCohortTopicChangeNotifier({
			source: repo,
			service,
			selfIsCohortMember: (): boolean => true,
			extractCommitCert: makeClusterCommitCertExtractor(store),
		});

		await repo.pend({ actionId: 'a1' as ActionId, transforms: makeInsertTransforms('block-1' as BlockId, makeBlock('block-1')), policy: 'c' });
		await repo.commit({ actionId: 'a1' as ActionId, blockIds: ['block-1' as BlockId], tailId: 'block-1' as BlockId, rev: 1 });

		expect(received, 'cert delivered to origination').to.equal(expected);
		expect(Array.from(received!.thresholdSig)).to.deep.equal([0x11, 0x22, 0x33, 0x44]);
	});
});
