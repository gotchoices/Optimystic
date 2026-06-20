import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type { IRepo, BlockGets, GetBlockResults, PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks, MessageOptions, RepoMessage, IBlock } from '@optimystic/db-core';
import { RepoService, type RepoServiceComponents, type NetworkManagerLike } from '../src/repo/service.js';
import type { RedirectPayload } from '../src/repo/redirect.js';

const makePeerId = async (): Promise<PeerId> => {
	const key = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(key);
};

/** Build a minimal valid IBlock for a pend transforms fixture. */
const makeBlock = (id: string): IBlock => ({ header: { id, type: 'test', collectionId: 'c1' } });

/** Stable map key for a byte array. */
const mapKey = (key: Uint8Array): string => Array.from(key).join(',');

/**
 * Compute the map key for the bytes `checkRedirect` actually passes to getCluster.
 * After the key-derivation fix the redirect path passes the RAW encoded blockKey
 * (no pre-hash), matching the coordinator's findCluster(encode(blockId)).
 */
const blockKeyMapKey = (blockKey: string): string => mapKey(new TextEncoder().encode(blockKey));

/**
 * Network manager that returns a different cluster per blockKey, so a test can assert
 * which block a redirect was actually keyed on (e.g. blockIds[0] vs tailId for commit).
 */
const makeKeyedNetworkManager = (byBlockKey: Map<string, PeerId[]>, fallback: PeerId[]): NetworkManagerLike => ({
	async getCluster(key: Uint8Array): Promise<PeerId[]> {
		return byBlockKey.get(mapKey(key)) ?? fallback;
	}
});

const makeStubRepo = (): IRepo => ({
	async get(_blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
		return { 'block-1': { state: { latest: { rev: 1, action: 'a' } }, transforms: {} } as any };
	},
	async pend(_request: PendRequest, _options?: MessageOptions): Promise<PendResult> {
		return { success: true, pending: [], blockIds: ['block-1'] };
	},
	async cancel(_actionRef: ActionBlocks, _options?: MessageOptions): Promise<void> {},
	async commit(_request: CommitRequest, _options?: MessageOptions): Promise<CommitResult> {
		return { success: true };
	},
});

const makeNetworkManager = (cluster: PeerId[]): NetworkManagerLike => ({
	async getCluster(_key: Uint8Array): Promise<PeerId[]> {
		return cluster;
	}
});

const makeComponents = (opts: {
	repo: IRepo,
	peerId: PeerId,
	networkManager?: NetworkManagerLike,
	getConnectionAddrs?: (pid: PeerId) => string[]
}): RepoServiceComponents => ({
	logger: { forComponent: () => ({ error: () => {}, info: () => {}, trace: () => {}, debug: () => {} }) as any },
	registrar: {
		handle: async () => {},
		unhandle: async () => {}
	},
	repo: opts.repo,
	peerId: opts.peerId,
	networkManager: opts.networkManager,
	getConnectionAddrs: opts.getConnectionAddrs,
});

describe('RepoService redirect logic', () => {
	describe('checkRedirect', () => {
		it('returns redirect when node is NOT in cluster (responsibilityK=1)', async () => {
			const self = await makePeerId();
			const coordinator = await makePeerId();
			const nm = makeNetworkManager([coordinator]); // cluster has only coordinator, not self
			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, networkManager: nm }),
				{ responsibilityK: 1 }
			);

			const message: RepoMessage = { operations: [{ get: { blockIds: ['block-1'], context: { committed: [], rev: 0 } } }] };
			const result = await service.checkRedirect('block-1', 'get', message);

			expect(result).to.not.be.null;
			expect(result!.redirect.reason).to.equal('not_in_cluster');
			expect(result!.redirect.peers).to.have.length(1);
			expect(result!.redirect.peers[0]!.id).to.equal(coordinator.toString());
		});

		it('returns null (no redirect) when node IS in cluster', async () => {
			const self = await makePeerId();
			const other = await makePeerId();
			const nm = makeNetworkManager([self, other]); // self is in cluster
			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, networkManager: nm }),
				{ responsibilityK: 1 }
			);

			const message: RepoMessage = { operations: [{ get: { blockIds: ['block-1'], context: { committed: [], rev: 0 } } }] };
			const result = await service.checkRedirect('block-1', 'get', message);

			expect(result).to.be.null;
		});

		it('returns null when cluster is smaller than responsibilityK (small mesh)', async () => {
			const self = await makePeerId();
			const other = await makePeerId();
			const nm = makeNetworkManager([other]); // self NOT in cluster, but cluster size (1) < K (3)
			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, networkManager: nm }),
				{ responsibilityK: 3 }
			);

			const message: RepoMessage = { operations: [{ get: { blockIds: ['block-1'], context: { committed: [], rev: 0 } } }] };
			const result = await service.checkRedirect('block-1', 'get', message);

			expect(result).to.be.null;
		});

		it('returns null when no networkManager is available', async () => {
			const self = await makePeerId();
			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self }), // no networkManager
				{ responsibilityK: 1 }
			);

			const message: RepoMessage = { operations: [{ get: { blockIds: ['block-1'], context: { committed: [], rev: 0 } } }] };
			const result = await service.checkRedirect('block-1', 'get', message);

			expect(result).to.be.null;
		});

		it('includes multiaddrs from getConnectionAddrs in redirect payload', async () => {
			const self = await makePeerId();
			const coordinator = await makePeerId();
			const nm = makeNetworkManager([coordinator]);
			const service = new RepoService(
				makeComponents({
					repo: makeStubRepo(),
					peerId: self,
					networkManager: nm,
					getConnectionAddrs: (pid: PeerId) => {
						if (pid.equals(coordinator)) return ['/ip4/127.0.0.1/tcp/4001'];
						return [];
					}
				}),
				{ responsibilityK: 1 }
			);

			const message: RepoMessage = { operations: [{ get: { blockIds: ['block-1'], context: { committed: [], rev: 0 } } }] };
			const result = await service.checkRedirect('block-1', 'get', message);

			expect(result).to.not.be.null;
			expect(result!.redirect.peers[0]!.addrs).to.deep.equal(['/ip4/127.0.0.1/tcp/4001']);
		});

		it('excludes self from redirect peers', async () => {
			const self = await makePeerId();
			const coordinator = await makePeerId();
			// Cluster includes self but also another closer peer — simulate self NOT being a member
			// by making getCluster return [coordinator] only
			const nm = makeNetworkManager([coordinator]);
			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, networkManager: nm }),
				{ responsibilityK: 1 }
			);

			const message: RepoMessage = { operations: [{ get: { blockIds: ['block-1'], context: { committed: [], rev: 0 } } }] };
			const result = await service.checkRedirect('block-1', 'get', message);

			expect(result).to.not.be.null;
			const peerIds = result!.redirect.peers.map(p => p.id);
			expect(peerIds).to.not.include(self.toString());
		});

		it('attaches cluster info to message', async () => {
			const self = await makePeerId();
			const coordinator = await makePeerId();
			const nm = makeNetworkManager([self, coordinator]);
			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, networkManager: nm }),
				{ responsibilityK: 1 }
			);

			const message: RepoMessage = { operations: [{ get: { blockIds: ['block-1'], context: { committed: [], rev: 0 } } }] };
			await service.checkRedirect('block-1', 'get', message);

			expect((message as any).cluster).to.be.an('array');
			expect((message as any).cluster).to.include(self.toString());
			expect((message as any).cluster).to.include(coordinator.toString());
		});
	});

	describe('redirect for all operation types', () => {
		let self: PeerId;
		let coordinator: PeerId;
		let service: RepoService;

		beforeEach(async () => {
			self = await makePeerId();
			coordinator = await makePeerId();
			const nm = makeNetworkManager([coordinator]); // self not in cluster
			service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, networkManager: nm }),
				{ responsibilityK: 1 }
			);
		});

		it('redirects get operations', async () => {
			const message: RepoMessage = { operations: [{ get: { blockIds: ['block-1'], context: { committed: [], rev: 0 } } }] };
			const result = await service.checkRedirect('block-1', 'get', message);
			expect(result).to.not.be.null;
			expect(result!.redirect.reason).to.equal('not_in_cluster');
		});

		it('redirects pend operations', async () => {
			const message: RepoMessage = { operations: [{ pend: { transforms: { inserts: { 'block-1': makeBlock('block-1') }, updates: {}, deletes: [] }, actionId: 'a1' } as any }] };
			const result = await service.checkRedirect('block-1', 'pend', message);
			expect(result).to.not.be.null;
		});

		it('redirects commit operations', async () => {
			const message: RepoMessage = { operations: [{ commit: { tailId: 'block-1', actionId: 'a1', blockIds: ['block-1'] } as any }] };
			const result = await service.checkRedirect('block-1', 'commit', message);
			expect(result).to.not.be.null;
		});

		it('redirects cancel operations', async () => {
			const message: RepoMessage = { operations: [{ cancel: { actionRef: { blockIds: ['block-1'], actionId: 'a1' } } }] };
			const result = await service.checkRedirect('block-1', 'cancel', message);
			expect(result).to.not.be.null;
		});
	});

	// These exercise the per-op key DERIVATION in handleIncomingStream (extracted into
	// deriveBlockKey), which the explicit-key checkRedirect tests above never touch.
	describe('deriveBlockKey', () => {
		let service: RepoService;

		beforeEach(async () => {
			const self = await makePeerId();
			service = new RepoService(makeComponents({ repo: makeStubRepo(), peerId: self }), { responsibilityK: 1 });
		});

		it('derives get key from blockIds[0]', () => {
			const op: RepoMessage['operations'][number] = { get: { blockIds: ['block-A', 'block-B'], context: { committed: [], rev: 0 } } } as any;
			const { blockKey, opName } = service.deriveBlockKey(op);
			expect(opName).to.equal('get');
			expect(blockKey).to.equal('block-A');
		});

		it('derives pend key from blockIdsForTransforms(...)[0]', () => {
			const op: RepoMessage['operations'][number] = { pend: { transforms: { inserts: { 'block-A': makeBlock('block-A') }, updates: {}, deletes: [] }, actionId: 'a1' } } as any;
			const { blockKey, opName } = service.deriveBlockKey(op);
			expect(opName).to.equal('pend');
			expect(blockKey).to.equal('block-A');
		});

		it('derives cancel key from actionRef.blockIds[0]', () => {
			const op: RepoMessage['operations'][number] = { cancel: { actionRef: { blockIds: ['block-A'], actionId: 'a1' } } };
			const { blockKey, opName } = service.deriveBlockKey(op);
			expect(opName).to.equal('cancel');
			expect(blockKey).to.equal('block-A');
		});

		it('derives undefined cancel key when blockIds is empty (handled locally, no redirect)', () => {
			const op: RepoMessage['operations'][number] = { cancel: { actionRef: { blockIds: [], actionId: 'a1' } } };
			const { blockKey, opName } = service.deriveBlockKey(op);
			expect(opName).to.equal('cancel');
			expect(blockKey).to.be.undefined;
		});

		// The bug: commit redirect was keyed on tailId, but CoordinatorRepo.commit anchors
		// consensus + verifyResponsibility on blockIds[0]. For a non-tail commit batch
		// (blockIds[0] !== tailId) the key must be blockIds[0], NOT tailId.
		it('derives commit key from blockIds[0], NOT tailId (non-tail batch)', () => {
			const op: RepoMessage['operations'][number] = { commit: { blockIds: ['block-A', 'block-B'], actionId: 'a1', tailId: 'tail-Z', rev: 1 } } as any;
			const { blockKey, opName } = service.deriveBlockKey(op);
			expect(opName).to.equal('commit');
			expect(blockKey).to.equal('block-A');
			expect(blockKey).to.not.equal('tail-Z');
		});
	});

	// End-to-end: derive the commit key, then redirect-check it on a large multi-cluster
	// mesh. This is the path the existing commit suite never hits — it passes the key to
	// checkRedirect explicitly, so it cannot catch tailId-vs-blockIds[0].
	describe('commit redirect keys on blockIds[0] (large mesh)', () => {
		it('redirects toward blockIds[0] cluster; would NOT redirect if keyed on tailId', async () => {
			const self = await makePeerId();
			const blockACoordinator = await makePeerId();
			const otherTailMember = await makePeerId();

			// block-A's cluster excludes self (and is large enough to trip the redirect);
			// tail-Z's cluster INCLUDES self (so keying on tail-Z would NOT redirect).
			const byKey = new Map<string, PeerId[]>();
			byKey.set(blockKeyMapKey('block-A'), [blockACoordinator, otherTailMember]); // self NOT a member
			byKey.set(blockKeyMapKey('tail-Z'), [self, otherTailMember]);               // self IS a member
			const nm = makeKeyedNetworkManager(byKey, [self]);

			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, networkManager: nm }),
				{ responsibilityK: 2 } // cluster.length (2) >= K → not a small mesh
			);

			const message: RepoMessage = {
				operations: [{ commit: { blockIds: ['block-A', 'block-B'], actionId: 'a1', tailId: 'tail-Z', rev: 1 } } as any]
			};
			const { blockKey } = service.deriveBlockKey(message.operations[0]);
			expect(blockKey).to.equal('block-A');

			const result = await service.checkRedirect(blockKey!, 'commit', message);

			// Redirect MUST fire (self not in block-A's cluster) and target block-A's cluster.
			expect(result, 'redirect should fire when keyed on blockIds[0]').to.not.be.null;
			expect(result!.redirect.reason).to.equal('not_in_cluster');
			const peerIds = result!.redirect.peers.map(p => p.id);
			expect(peerIds).to.include(blockACoordinator.toString());
			expect(peerIds).to.not.include(self.toString());

			// Sanity: had it (wrongly) keyed on tailId, self IS in that cluster → no redirect.
			const tailKeyed = await service.checkRedirect('tail-Z', 'commit', message);
			expect(tailKeyed, 'keying on tailId would not redirect (self in tail cluster)').to.be.null;
		});
	});

	// End-to-end: derive the pend key, then redirect-check it on a large multi-cluster mesh.
	// The bug: pend was keyed on Object.keys(transforms)[0] — a structural field name
	// ('inserts'/'updates'/'deletes'), NOT a block id. The key must be
	// blockIdsForTransforms(transforms)[0]. This path the existing pend suite never hits.
	describe('pend redirect keys on blockIdsForTransforms(...)[0] (large mesh)', () => {
		it('redirects toward block-A cluster; would NOT redirect if keyed on the structural field name', async () => {
			const self = await makePeerId();
			const blockACoordinator = await makePeerId();
			const otherMember = await makePeerId();

			// block-A's cluster excludes self (large enough to trip the redirect);
			// the structural-field-name key 'inserts' falls through to the fallback cluster,
			// which INCLUDES self (so keying on 'inserts' would NOT redirect).
			const byKey = new Map<string, PeerId[]>();
			byKey.set(blockKeyMapKey('block-A'), [blockACoordinator, otherMember]); // self NOT a member
			const nm = makeKeyedNetworkManager(byKey, [self]);                      // fallback includes self

			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, networkManager: nm }),
				{ responsibilityK: 2 } // cluster.length (2) >= K → not a small mesh
			);

			const message: RepoMessage = {
				operations: [{ pend: { transforms: { inserts: { 'block-A': makeBlock('block-A') }, updates: {}, deletes: [] }, actionId: 'a1' } as any }]
			};
			const { blockKey } = service.deriveBlockKey(message.operations[0]);
			expect(blockKey).to.equal('block-A');

			const result = await service.checkRedirect(blockKey!, 'pend', message);

			// Redirect MUST fire (self not in block-A's cluster) and target block-A's cluster.
			expect(result, 'redirect should fire when keyed on blockIdsForTransforms(...)[0]').to.not.be.null;
			expect(result!.redirect.reason).to.equal('not_in_cluster');
			const peerIds = result!.redirect.peers.map(p => p.id);
			expect(peerIds).to.include(blockACoordinator.toString());
			expect(peerIds).to.not.include(self.toString());

			// Sanity: had it (wrongly) keyed on the structural field name 'inserts', that key
			// hits the fallback cluster which includes self → no redirect (the misroute the fix removes).
			const fieldKeyed = await service.checkRedirect('inserts', 'pend', message);
			expect(fieldKeyed, 'keying on the structural field name would not redirect (self in fallback cluster)').to.be.null;
		});
	});
});

describe('RepoClient redirect handling', () => {
	// These tests verify the redirect detection logic in client.ts
	// by testing the response parsing behavior

	it('detects redirect payload in response', () => {
		const response: RedirectPayload = {
			redirect: {
				peers: [{ id: 'QmPeer123', addrs: ['/ip4/127.0.0.1/tcp/4001'] }],
				reason: 'not_in_cluster'
			}
		};
		expect(response.redirect.peers.length).to.be.greaterThan(0);
		expect(response.redirect.reason).to.equal('not_in_cluster');
	});

	it('redirect payload peers include addrs', () => {
		const response: RedirectPayload = {
			redirect: {
				peers: [
					{ id: 'QmPeer123', addrs: ['/ip4/127.0.0.1/tcp/4001', '/ip4/10.0.0.1/tcp/4001'] },
					{ id: 'QmPeer456', addrs: [] }
				],
				reason: 'not_in_cluster'
			}
		};
		expect(response.redirect.peers[0]!.addrs).to.have.length(2);
		expect(response.redirect.peers[1]!.addrs).to.have.length(0);
	});
});
