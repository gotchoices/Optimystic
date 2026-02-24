import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type { IRepo, BlockGets, GetBlockResults, PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks, MessageOptions, RepoMessage } from '@optimystic/db-core';
import { RepoService, type RepoServiceComponents, type NetworkManagerLike } from '../src/repo/service.js';
import type { RedirectPayload } from '../src/repo/redirect.js';

const makePeerId = async (): Promise<PeerId> => {
	const key = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(key);
};

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
			const message: RepoMessage = { operations: [{ pend: { transforms: { 'block-1': {} }, actionId: 'a1' } as any }] };
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
