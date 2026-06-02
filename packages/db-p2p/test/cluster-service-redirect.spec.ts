import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type { ICluster, ClusterRecord, ClusterPeers, RepoMessage } from '@optimystic/db-core';
import { ClusterService, type ClusterServiceComponents } from '../src/cluster/service.js';

const makePeerId = async (): Promise<PeerId> => {
	const key = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(key);
};

/** Stub ICluster that records whether (and with what) update() was invoked. */
type StubCluster = ICluster & { calls: number; lastRecord?: ClusterRecord };

const makeStubCluster = (): StubCluster => {
	const stub: StubCluster = {
		calls: 0,
		async update(record: ClusterRecord): Promise<ClusterRecord> {
			stub.calls += 1;
			stub.lastRecord = record;
			return record;
		}
	};
	return stub;
};

const makeComponents = (opts: {
	cluster: ICluster,
	peerId?: PeerId,
	getConnectionAddrs?: (pid: PeerId) => string[]
}): ClusterServiceComponents => ({
	logger: { forComponent: () => ({ error: () => {}, info: () => {}, trace: () => {}, debug: () => {} }) as any },
	registrar: {
		handle: async () => {},
		unhandle: async () => {}
	},
	cluster: opts.cluster,
	peerId: opts.peerId,
	getConnectionAddrs: opts.getConnectionAddrs,
});

/** Build a ClusterPeers map from peer ids, optionally with multiaddrs per peer. */
const makePeers = (ids: PeerId[], addrsFor?: (id: string) => string[]): ClusterPeers => {
	const peers: ClusterPeers = {};
	for (const id of ids) {
		const idStr = id.toString();
		peers[idStr] = {
			multiaddrs: addrsFor ? addrsFor(idStr) : [],
			publicKey: 'stub-public-key'
		};
	}
	return peers;
};

const makeRecord = (peers: ClusterPeers): ClusterRecord => ({
	messageHash: 'hash-1',
	peers,
	message: { operations: [] } as unknown as RepoMessage,
	promises: {},
	commits: {}
});

describe('ClusterService redirect logic', () => {
	describe('checkRedirect', () => {
		it('returns redirect when self is NOT in record.peers and peer set >= responsibilityK', async () => {
			const self = await makePeerId();
			const a = await makePeerId();
			const b = await makePeerId();
			const stub = makeStubCluster();
			const service = new ClusterService(
				makeComponents({ cluster: stub, peerId: self }),
				{ responsibilityK: 2 }
			);

			const record = makeRecord(makePeers([a, b])); // self absent, size 2 >= K(2)
			const result = service.checkRedirect(record);

			expect(result).to.not.be.null;
			expect(result!.redirect.reason).to.equal('not_in_cluster');
			const peerIds = result!.redirect.peers.map(p => p.id);
			expect(peerIds).to.have.members([a.toString(), b.toString()]);
			expect(peerIds).to.not.include(self.toString());
		});

		it('does NOT call cluster.update when it redirects (driven via the update path)', async () => {
			const self = await makePeerId();
			const a = await makePeerId();
			const b = await makePeerId();
			const stub = makeStubCluster();
			const service = new ClusterService(
				makeComponents({ cluster: stub, peerId: self }),
				{ responsibilityK: 2 }
			);

			const record = makeRecord(makePeers([a, b]));
			const redirect = service.checkRedirect(record);
			// Mirror the update-path contract: redirect ?? await cluster.update(record)
			const response = redirect ?? await stub.update(record);

			expect(stub.calls).to.equal(0);
			expect((response as any).redirect).to.not.be.undefined;
		});

		it('returns null (no redirect) when self IS in record.peers — no empty-promises regression', async () => {
			const self = await makePeerId();
			const a = await makePeerId();
			const stub = makeStubCluster();
			const service = new ClusterService(
				makeComponents({ cluster: stub, peerId: self }),
				{ responsibilityK: 2 }
			);

			const record = makeRecord(makePeers([self, a])); // self present
			const redirect = service.checkRedirect(record);
			expect(redirect).to.be.null;

			// And the update path processes locally (stub.update IS called).
			const response = redirect ?? await stub.update(record);
			expect(stub.calls).to.equal(1);
			expect(stub.lastRecord).to.equal(record);
			expect((response as any).redirect).to.be.undefined;
		});

		it('returns null when peer set is smaller than responsibilityK (small mesh)', async () => {
			const self = await makePeerId();
			const a = await makePeerId();
			const stub = makeStubCluster();
			const service = new ClusterService(
				makeComponents({ cluster: stub, peerId: self }),
				{ responsibilityK: 3 } // peer set size 1 < 3
			);

			const record = makeRecord(makePeers([a])); // self NOT a member, but mesh is small
			const result = service.checkRedirect(record);
			expect(result).to.be.null;
		});

		it('returns null when no peerId is configured (no identity to scope against)', async () => {
			const a = await makePeerId();
			const b = await makePeerId();
			const stub = makeStubCluster();
			const service = new ClusterService(
				makeComponents({ cluster: stub }), // no peerId
				{ responsibilityK: 1 }
			);

			const record = makeRecord(makePeers([a, b]));
			const result = service.checkRedirect(record);
			expect(result).to.be.null;
		});

		it('returns null when record.peers is empty', async () => {
			const self = await makePeerId();
			const stub = makeStubCluster();
			const service = new ClusterService(
				makeComponents({ cluster: stub, peerId: self }),
				{ responsibilityK: 1 }
			);

			const record = makeRecord({}); // empty peer set
			const result = service.checkRedirect(record);
			expect(result).to.be.null;
		});

		it('defaults responsibilityK to 1: a single non-member peer redirects', async () => {
			const self = await makePeerId();
			const a = await makePeerId();
			const stub = makeStubCluster();
			const service = new ClusterService(
				makeComponents({ cluster: stub, peerId: self }) // no init → K defaults to 1
			);

			const record = makeRecord(makePeers([a])); // size 1 >= K(1), self absent
			const result = service.checkRedirect(record);
			expect(result).to.not.be.null;
			expect(result!.redirect.peers.map(p => p.id)).to.deep.equal([a.toString()]);
		});

		it('prefers multiaddrs embedded in record.peers for redirect targets', async () => {
			const self = await makePeerId();
			const a = await makePeerId();
			const stub = makeStubCluster();
			const service = new ClusterService(
				makeComponents({ cluster: stub, peerId: self }),
				{ responsibilityK: 1 }
			);

			const addr = '/ip4/127.0.0.1/tcp/4001';
			const record = makeRecord(makePeers([a], (id) => id === a.toString() ? [addr] : []));
			const result = service.checkRedirect(record);

			expect(result).to.not.be.null;
			expect(result!.redirect.peers[0]!.addrs).to.deep.equal([addr]);
		});

		it('falls back to getConnectionAddrs when record.peers has no multiaddrs', async () => {
			const self = await makePeerId();
			const a = await makePeerId();
			const stub = makeStubCluster();
			const fallback = '/ip4/10.0.0.5/tcp/5001';
			const service = new ClusterService(
				makeComponents({
					cluster: stub,
					peerId: self,
					getConnectionAddrs: (pid: PeerId) => pid.equals(a) ? [fallback] : []
				}),
				{ responsibilityK: 1 }
			);

			const record = makeRecord(makePeers([a])); // no embedded multiaddrs
			const result = service.checkRedirect(record);

			expect(result).to.not.be.null;
			expect(result!.redirect.peers[0]!.addrs).to.deep.equal([fallback]);
		});
	});
});
