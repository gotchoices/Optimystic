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
	getConnectionAddrs?: (pid: PeerId) => string[],
	recordPeerAddresses?: (pid: PeerId, multiaddrs: string[]) => void,
	/** Only for the no-resolver path: `getPeerAddrs` reads `components.libp2p` as its last resort. */
	libp2p?: unknown
}): ClusterServiceComponents => ({
	...(opts.libp2p === undefined ? {} : { libp2p: opts.libp2p }),
	logger: { forComponent: () => ({ error: () => {}, info: () => {}, trace: () => {}, debug: () => {} }) as any },
	registrar: {
		handle: async () => {},
		unhandle: async () => {}
	},
	cluster: opts.cluster,
	peerId: opts.peerId,
	getConnectionAddrs: opts.getConnectionAddrs,
	recordPeerAddresses: opts.recordPeerAddresses,
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
			const result = await service.checkRedirect(record);

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
			const redirect = await service.checkRedirect(record);
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
			const redirect = await service.checkRedirect(record);
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
			const result = await service.checkRedirect(record);
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
			const result = await service.checkRedirect(record);
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
			const result = await service.checkRedirect(record);
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
			const result = await service.checkRedirect(record);
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
			const result = await service.checkRedirect(record);

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
			const result = await service.checkRedirect(record);

			expect(result).to.not.be.null;
			expect(result!.redirect.peers[0]!.addrs).to.deep.equal([fallback]);
		});

		/**
		 * Ticket: findcluster-publishes-inbound-source-addresses (gotchoices/Optimystic#13).
		 *
		 * With no `getConnectionAddrs` injected (the embedder path — production supplies one), the
		 * service reads live connections itself. A redirect payload goes to a third party, so it
		 * obeys the same rule the cluster record does: an inbound connection's `remoteAddr` is the
		 * far side's ephemeral source socket and is publishable to nobody.
		 */
		it('reading connections itself, publishes the outbound address and never the inbound source socket', async () => {
			const self = await makePeerId();
			const dialed = await makePeerId();
			const dialedUs = await makePeerId();
			const outboundAddr = `/ip4/10.0.0.5/tcp/5001/p2p/${dialed.toString()}`;
			const sourceSocket = `/ip4/127.0.0.1/tcp/58247/p2p/${dialedUs.toString()}`;
			const service = new ClusterService(
				makeComponents({
					cluster: makeStubCluster(),
					peerId: self,
					libp2p: {
						getConnections: (pid: PeerId) => pid.equals(dialed)
							? [{ direction: 'outbound', remoteAddr: { toString: () => outboundAddr } }]
							: [{ direction: 'inbound', remoteAddr: { toString: () => sourceSocket } }]
					}
				}),
				{ responsibilityK: 1 }
			);

			const result = await service.checkRedirect(makeRecord(makePeers([dialed, dialedUs])));

			expect(result).to.not.be.null;
			const addrsById = Object.fromEntries(result!.redirect.peers.map(p => [p.id, p.addrs]));
			expect(addrsById[dialed.toString()], 'an address we dialed is real and must be published')
				.to.deep.equal([outboundAddr]);
			expect(addrsById[dialedUs.toString()],
				`the source socket ${sourceSocket} is reachable by nobody else`).to.deep.equal([]);
		});

		/**
		 * Ticket: third-party-address-set-has-two-definitions.
		 *
		 * The direction filter above is only half the rule; the other half is the peer's own
		 * advertised addresses, which `identify` puts in the peerStore. `RepoService`'s equivalent
		 * fallback is covered in `redirect.spec.ts`, but the two services reach the node by
		 * different routes — `RepoService` through an injected `setLibp2p`, `ClusterService`
		 * through the (throw-happy) components proxy — so this asserts that the object this
		 * service hands `publishableAddrsForPeer` really does carry the peerStore.
		 */
		it('reading connections itself, unions in what the peer advertised to us', async () => {
			const self = await makePeerId();
			const dialedUs = await makePeerId();
			const relay = await makePeerId();
			const sourceSocket = `/ip4/127.0.0.1/tcp/58247/p2p/${dialedUs.toString()}`;
			const advertised = `/ip4/10.0.0.9/tcp/4001/p2p/${relay.toString()}/p2p-circuit`;
			const service = new ClusterService(
				makeComponents({
					cluster: makeStubCluster(),
					peerId: self,
					libp2p: {
						peerId: self,
						getConnections: () => [{ direction: 'inbound', remoteAddr: { toString: () => sourceSocket } }],
						peerStore: {
							get: async (pid: PeerId) => pid.equals(dialedUs)
								? { addresses: [{ multiaddr: { toString: () => advertised } }] }
								// libp2p's peerStore THROWS for a peer it has no record of.
								: (() => { throw new Error('Not Found'); })()
						}
					}
				}),
				{ responsibilityK: 1 }
			);

			const result = await service.checkRedirect(makeRecord(makePeers([dialedUs])));

			expect(result).to.not.be.null;
			expect(result!.redirect.peers[0]!.addrs,
				'a sibling that only ever dialed us is described by its advertised circuit address, not by nothing')
				.to.deep.equal([advertised]);
		});
	});

	/**
	 * The wire ingress for a cluster record is where a node meets a cohort sibling it may never
	 * have had a connection to. libp2p only propagates addresses between directly-connected
	 * peers, so the record's own `multiaddrs` are often the only route information that will ever
	 * reach this node about a relay-only member. These tests drive `processOperation` — the real
	 * ingress — rather than reconstructing it, because the ORDER (learn, then redirect-or-process)
	 * is the part that matters: the redirect branch dials too.
	 */
	describe('address learning from inbound records', () => {
		const ADDR_A = '/ip4/10.0.0.5/tcp/5001';
		const ADDR_B = '/ip4/10.0.0.6/tcp/5002';

		/** Component sink that records every (peer, addrs) offer, in order. */
		const makeSink = () => {
			const offers: Array<{ peer: string, addrs: string[] }> = [];
			return { offers, sink: (pid: PeerId, addrs: string[]) => { offers.push({ peer: pid.toString(), addrs }); } };
		};

		it('offers every non-self peer\'s addresses on the process-locally path', async () => {
			const self = await makePeerId();
			const a = await makePeerId();
			const stub = makeStubCluster();
			const { offers, sink } = makeSink();
			const service = new ClusterService(
				makeComponents({ cluster: stub, peerId: self, recordPeerAddresses: sink }),
				{ responsibilityK: 1 }
			);

			// self IS a member → no redirect, cluster.update runs.
			const addrsFor = (id: string): string[] => id === a.toString() ? [ADDR_A] : [ADDR_B];
			const record = makeRecord(makePeers([self, a], addrsFor));
			await service.processOperation({ operation: 'update', record });

			expect(stub.calls, 'this is the process-locally path').to.equal(1);
			expect(offers.map(o => o.peer), 'self is not offered — the node already knows itself').to.deep.equal([a.toString()]);
			expect(offers[0]!.addrs).to.deep.equal([ADDR_A]);
		});

		it('offers addresses on the REDIRECT path too — that branch dials as well', async () => {
			const self = await makePeerId();
			const a = await makePeerId();
			const b = await makePeerId();
			const stub = makeStubCluster();
			const { offers, sink } = makeSink();
			const service = new ClusterService(
				makeComponents({ cluster: stub, peerId: self, recordPeerAddresses: sink }),
				{ responsibilityK: 1 }
			);

			// self is NOT a member → redirect. The old code returned before ever reading multiaddrs.
			const record = makeRecord(makePeers([a, b], () => [ADDR_A]));
			const response = await service.processOperation({ operation: 'update', record });

			expect((response as any).redirect, 'precondition: this must be the redirect branch').to.not.be.undefined;
			expect(stub.calls).to.equal(0);
			expect(offers.map(o => o.peer)).to.have.members([a.toString(), b.toString()]);
		});

		it('skips peers with no multiaddrs and unparseable peer ids', async () => {
			const self = await makePeerId();
			const a = await makePeerId();
			const b = await makePeerId();
			const stub = makeStubCluster();
			const { offers, sink } = makeSink();
			const service = new ClusterService(
				makeComponents({ cluster: stub, peerId: self, recordPeerAddresses: sink }),
				{ responsibilityK: 1 }
			);

			const peers = makePeers([self, a, b], (id) => id === a.toString() ? [ADDR_A] : []);
			peers['not-a-peer-id'] = { multiaddrs: [ADDR_B], publicKey: 'stub-public-key' };
			await service.processOperation({ operation: 'update', record: makeRecord(peers) });

			expect(offers.map(o => o.peer), 'only the addressed, parseable, non-self peer').to.deep.equal([a.toString()]);
		});

		it('processes normally when no recordPeerAddresses component is wired', async () => {
			const self = await makePeerId();
			const a = await makePeerId();
			const stub = makeStubCluster();
			const service = new ClusterService(
				makeComponents({ cluster: stub, peerId: self }), // no sink
				{ responsibilityK: 1 }
			);

			const record = makeRecord(makePeers([self, a], () => [ADDR_A]));
			await service.processOperation({ operation: 'update', record });

			expect(stub.calls).to.equal(1);
		});
	});
});
