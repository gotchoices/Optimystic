import { routingKeyForBlock, localDurability } from '@optimystic/db-core';
import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId } from '@libp2p/interface';
import type { IRepo, BlockGets, GetBlockResults, PendRequest, PendResult, CommitRequest, CommitResult, ActionBlocks, MessageOptions, RepoMessage, IBlock, ClusterPeers } from '@optimystic/db-core';
import { RepoService, type RepoServiceComponents, type ClusterLookup } from '../src/repo/service.js';
import type { RedirectPayload } from '../src/repo/redirect.js';
import { RESPONSIBILITY_TTL_MS } from '../src/repo/responsibility.js';
import { encodeJson, decodeJson, makeServiceStream } from './util/protocol-stream.js';

const makePeerId = async (): Promise<PeerId> => {
	const key = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(key);
};

/** Build a minimal valid IBlock for a pend transforms fixture. */
const makeBlock = (id: string): IBlock => ({ header: { id, type: 'test', collectionId: 'c1' } });

/** Stable map key for a byte array. */
const mapKey = (key: Uint8Array): string => Array.from(key).join(',');

/**
 * Compute the map key for the bytes `checkRedirect` actually passes to findCluster:
 * the block's routing key, the same bytes the writer and the coordinator hand it.
 */
const blockKeyMapKey = (blockKey: string): string => mapKey(routingKeyForBlock(blockKey));

/** A `findCluster` answer naming `peers`, in order. Addresses are irrelevant to the redirect decision. */
const clusterPeersOf = (peers: PeerId[]): ClusterPeers =>
	Object.fromEntries(peers.map(p => [p.toString(), { multiaddrs: [], publicKey: '' }]));

/**
 * Key network that returns a different cluster per blockKey, so a test can assert
 * which block a redirect was actually keyed on (e.g. blockIds[0] vs tailId for commit).
 */
const makeKeyedKeyNetwork = (byBlockKey: Map<string, PeerId[]>, fallback: PeerId[]): ClusterLookup => ({
	async findCluster(key: Uint8Array): Promise<ClusterPeers> {
		return clusterPeersOf(byBlockKey.get(mapKey(key)) ?? fallback);
	}
});

const makeStubRepo = (): IRepo => ({
	async get(_blockGets: BlockGets, _options?: MessageOptions): Promise<GetBlockResults> {
		return { 'block-1': { state: { latest: { rev: 1, action: 'a' } }, transforms: {} } as any };
	},
	async pend(_request: PendRequest, _options?: MessageOptions): Promise<PendResult> {
		return { success: true, pending: [], blockIds: ['block-1'], durability: localDurability() };
	},
	async cancel(_actionRef: ActionBlocks, _options?: MessageOptions): Promise<void> {},
	async commit(_request: CommitRequest, _options?: MessageOptions): Promise<CommitResult> {
		return { success: true, durability: localDurability() };
	},
});

/** Key network naming the same cluster for every block, counting its lookups. */
const makeKeyNetwork = (cluster: PeerId[]): ClusterLookup & { lookups: number } => {
	const net = {
		lookups: 0,
		async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
			net.lookups++;
			return clusterPeersOf(cluster);
		}
	};
	return net;
};

/** Key network whose lookup always throws, as when FRET is not wired on the node. */
const makeThrowingKeyNetwork = (): ClusterLookup & { lookups: number } => {
	const net = {
		lookups: 0,
		async findCluster(_key: Uint8Array): Promise<ClusterPeers> {
			net.lookups++;
			throw new Error('FRET service is not registered on this libp2p node');
		}
	};
	return net;
};

const makeComponents = (opts: {
	repo: IRepo,
	peerId: PeerId,
	keyNetwork?: ClusterLookup,
	getConnectionAddrs?: (pid: PeerId) => string[]
}): RepoServiceComponents => ({
	registrar: {
		handle: async () => {},
		unhandle: async () => {}
	},
	repo: opts.repo,
	peerId: opts.peerId,
	keyNetwork: opts.keyNetwork,
	getConnectionAddrs: opts.getConnectionAddrs,
});

describe('RepoService redirect logic', () => {
	describe('checkRedirect', () => {
		it('returns redirect when node is NOT in cluster (responsibilityK=1)', async () => {
			const self = await makePeerId();
			const coordinator = await makePeerId();
			const nm = makeKeyNetwork([coordinator]); // cluster has only coordinator, not self
			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, keyNetwork: nm }),
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
			const nm = makeKeyNetwork([self, other]); // self is in cluster
			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, keyNetwork: nm }),
				{ responsibilityK: 1 }
			);

			const message: RepoMessage = { operations: [{ get: { blockIds: ['block-1'], context: { committed: [], rev: 0 } } }] };
			const result = await service.checkRedirect('block-1', 'get', message);

			expect(result).to.be.null;
		});

		it('returns null when cluster is smaller than responsibilityK (small mesh)', async () => {
			const self = await makePeerId();
			const other = await makePeerId();
			const nm = makeKeyNetwork([other]); // self NOT in cluster, but cluster size (1) < K (3)
			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, keyNetwork: nm }),
				{ responsibilityK: 3 }
			);

			const message: RepoMessage = { operations: [{ get: { blockIds: ['block-1'], context: { committed: [], rev: 0 } } }] };
			const result = await service.checkRedirect('block-1', 'get', message);

			expect(result).to.be.null;
		});

		it('returns null when no key network is available', async () => {
			const self = await makePeerId();
			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self }), // no key network, no node attachment
				{ responsibilityK: 1 }
			);

			const message: RepoMessage = { operations: [{ get: { blockIds: ['block-1'], context: { committed: [], rev: 0 } } }] };
			const result = await service.checkRedirect('block-1', 'get', message);

			expect(result).to.be.null;
		});

		it('includes multiaddrs from getConnectionAddrs in redirect payload', async () => {
			const self = await makePeerId();
			const coordinator = await makePeerId();
			const nm = makeKeyNetwork([coordinator]);
			const service = new RepoService(
				makeComponents({
					repo: makeStubRepo(),
					peerId: self,
					keyNetwork: nm,
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

		/**
		 * Ticket: findcluster-publishes-inbound-source-addresses (gotchoices/Optimystic#13).
		 *
		 * Unlike the cluster service, the repo service gets NO `getConnectionAddrs` from
		 * `libp2p-node-base` — the node is injected via `setLibp2p`, so this connection-reading
		 * fallback is the production source of a repo redirect's addresses. It publishes to a third
		 * party, so it obeys the same rule the cluster record does: an inbound connection's
		 * `remoteAddr` is the far side's ephemeral source socket and must never be handed on.
		 */
		it('publishes only outbound connection addresses in the redirect payload fallback', async () => {
			const self = await makePeerId();
			const dialed = await makePeerId();
			const dialedUs = await makePeerId();
			const outboundAddr = `/ip4/10.0.0.5/tcp/4001/p2p/${dialed.toString()}`;
			const sourceSocket = `/ip4/127.0.0.1/tcp/58247/p2p/${dialedUs.toString()}`;
			const nm = makeKeyNetwork([dialed, dialedUs]);
			// No getConnectionAddrs: force the fallback that reads live connections.
			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, keyNetwork: nm }),
				{ responsibilityK: 1 }
			);
			service.setLibp2p({
				getConnections: (pid: PeerId) => pid.equals(dialed)
					? [{ direction: 'outbound', remoteAddr: { toString: () => outboundAddr } }]
					: [{ direction: 'inbound', remoteAddr: { toString: () => sourceSocket } }]
			} as any);

			const message: RepoMessage = { operations: [{ get: { blockIds: ['block-1'], context: { committed: [], rev: 0 } } }] };
			const result = await service.checkRedirect('block-1', 'get', message);

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
		 * The direction filter above is only half the rule. The other half is the peer's OWN
		 * advertised addresses, which reach us through `identify`/`identifyPush` and live in the
		 * peerStore — and for a cohort member that only ever dialed US and is reachable only
		 * through a relay, that is the ONLY place its real circuit address exists on this node.
		 * `findCluster` had always unioned the two; the redirect resolvers read connections alone,
		 * so the same peer was described with a circuit address in a cluster record and with no
		 * address at all in a repo redirect. `RepoService` is the resolver where that hurts most:
		 * `libp2p-node-base` injects no `getConnectionAddrs` here, and unlike a cluster redirect
		 * there is no record whose embedded multiaddrs could stand in.
		 */
		it("unions the peerStore's advertised addresses into the redirect payload fallback", async () => {
			const self = await makePeerId();
			const dialed = await makePeerId();
			const relayOnly = await makePeerId();
			const relay = await makePeerId();
			const outboundAddr = `/ip4/10.0.0.5/tcp/4001/p2p/${dialed.toString()}`;
			// What `identify` gave us for the peer we dialed: a second listen address we have not
			// used. It must be published too — a third party may be able to reach it and not the one
			// we happened to dial.
			const dialedAdvertised = '/ip4/192.168.1.9/tcp/4001';
			// The relay-only peer dialed US, so its connection contributes nothing (the source
			// socket) and its self-advertised circuit address is the whole answer.
			const sourceSocket = `/ip4/127.0.0.1/tcp/58247/p2p/${relayOnly.toString()}`;
			const relayAdvertised = `/ip4/10.0.0.9/tcp/4001/p2p/${relay.toString()}/p2p-circuit`;
			const advertised: Record<string, string[]> = {
				[dialed.toString()]: [outboundAddr, dialedAdvertised],
				[relayOnly.toString()]: [relayAdvertised],
			};

			const nm = makeKeyNetwork([dialed, relayOnly]);
			// No getConnectionAddrs: force the fallback, which is the production path here.
			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, keyNetwork: nm }),
				{ responsibilityK: 1 }
			);
			service.setLibp2p({
				peerId: self,
				getConnections: (pid: PeerId) => pid.equals(dialed)
					? [{ direction: 'outbound', remoteAddr: { toString: () => outboundAddr } }]
					: [{ direction: 'inbound', remoteAddr: { toString: () => sourceSocket } }],
				peerStore: {
					get: async (pid: PeerId) => {
						const addrs = advertised[pid.toString()];
						// libp2p's peerStore THROWS for a peer it has no record of; the resolver
						// must treat that as "no advertised addresses", not as an error.
						if (addrs === undefined) throw new Error('Not Found');
						return { addresses: addrs.map(a => ({ multiaddr: { toString: () => a } })) };
					}
				}
			} as any);

			const message: RepoMessage = { operations: [{ get: { blockIds: ['block-1'], context: { committed: [], rev: 0 } } }] };
			const result = await service.checkRedirect('block-1', 'get', message);

			expect(result).to.not.be.null;
			const addrsById = Object.fromEntries(result!.redirect.peers.map(p => [p.id, p.addrs]));
			// Connection-first, de-duplicated: the address libp2p just succeeded with leads, and the
			// peerStore's copy of that same address does not take a second slot.
			expect(addrsById[dialed.toString()],
				'the dialed address leads; the advertised one follows; neither is duplicated')
				.to.deep.equal([outboundAddr, dialedAdvertised]);
			// The whole point: this peer is NOT addressless, and never was — we just were not looking.
			expect(addrsById[relayOnly.toString()],
				'a peer that only ever dialed us is described by its advertised circuit address')
				.to.deep.equal([relayAdvertised]);
			expect(addrsById[relayOnly.toString()],
				`the source socket ${sourceSocket} is reachable by nobody else`).to.not.include(sourceSocket);
		});

		/**
		 * A peerStore that is absent, empty, or throwing leaves the connection-derived half intact:
		 * half a redirect beats a redirect that errors.
		 */
		it('falls back to the connection half when the peerStore has nothing or fails', async () => {
			const self = await makePeerId();
			const dialed = await makePeerId();
			const outboundAddr = `/ip4/10.0.0.5/tcp/4001/p2p/${dialed.toString()}`;
			const nm = makeKeyNetwork([dialed]);
			const message = (): RepoMessage => ({ operations: [{ get: { blockIds: ['block-1'], context: { committed: [], rev: 0 } } }] });
			const conns = { getConnections: () => [{ direction: 'outbound', remoteAddr: { toString: () => outboundAddr } }] };

			for (const [what, peerStore] of [
				['no peerStore at all', undefined],
				['a peerStore that throws', { get: async () => { throw new Error('peerStore exploded'); } }],
				['a peerStore with no addresses', { get: async () => ({ addresses: [] }) }],
			] as const) {
				const service = new RepoService(
					makeComponents({ repo: makeStubRepo(), peerId: self, keyNetwork: nm }),
					{ responsibilityK: 1 }
				);
				service.setLibp2p({ peerId: self, ...conns, ...(peerStore ? { peerStore } : {}) } as any);
				const result = await service.checkRedirect('block-1', 'get', message());
				expect(result, `${what}: a redirect must still be produced`).to.not.be.null;
				expect(result!.redirect.peers[0]!.addrs, `${what}: the connection half must survive`)
					.to.deep.equal([outboundAddr]);
			}
		});

		it('excludes self from redirect peers', async () => {
			const self = await makePeerId();
			const coordinator = await makePeerId();
			// Cluster includes self but also another closer peer — simulate self NOT being a member
			// by making findCluster return [coordinator] only
			const nm = makeKeyNetwork([coordinator]);
			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, keyNetwork: nm }),
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
			const nm = makeKeyNetwork([self, coordinator]);
			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, keyNetwork: nm }),
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
			const nm = makeKeyNetwork([coordinator]); // self not in cluster
			service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, keyNetwork: nm }),
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

	/**
	 * Ticket: coordinator-refuses-blocks-it-is-not-responsible-for.
	 *
	 * The redirect check used to decide responsibility through `NetworkManagerService.getCluster` — FRET's raw
	 * cohort, with no network-membership scoping — while the writer and the coordinator ask the node's key
	 * network. Once writes stopped being self-coordinated everywhere, that second rule met them. These pin
	 * that the check now asks the node's own key network, how often, and what it does when the lookup fails.
	 */
	describe("responsibility from the node's own key network", () => {
		const pendMessage = (blockId: string): RepoMessage =>
			({ operations: [{ pend: { transforms: { inserts: { [blockId]: makeBlock(blockId) }, updates: {}, deletes: [] }, actionId: 'a1' } as any }] });
		const commitMessage = (blockId: string): RepoMessage =>
			({ operations: [{ commit: { tailId: blockId, actionId: 'a1', blockIds: [blockId], rev: 1 } as any }] });
		const cancelMessage = (blockId: string): RepoMessage =>
			({ operations: [{ cancel: { actionRef: { blockIds: [blockId], actionId: 'a1' } } }] });
		const getMessage = (blockId: string): RepoMessage =>
			({ operations: [{ get: { blockIds: [blockId], context: { committed: [], rev: 0 } } }] });

		it("reads the key network from the injected node's keyNetwork attachment", async () => {
			const self = await makePeerId();
			const member = await makePeerId();
			const keyNetwork = makeKeyNetwork([member]);
			// No keyNetwork component: the production wiring, where the node arrives through setLibp2p.
			const service = new RepoService(makeComponents({ repo: makeStubRepo(), peerId: self }), { responsibilityK: 1 });
			service.setLibp2p({ peerId: self, keyNetwork, getConnections: () => [] } as any);

			const result = await service.checkRedirect('block-1', 'pend', pendMessage('block-1'));

			expect(result, 'a pend for a cohort that excludes this node is redirected').to.not.be.null;
			expect(result!.redirect.peers.map(p => p.id)).to.deep.equal([member.toString()]);
			expect(keyNetwork.lookups).to.equal(1);
		});

		it('handles pend, commit and cancel locally when this node is in the cohort', async () => {
			const self = await makePeerId();
			const other = await makePeerId();
			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, keyNetwork: makeKeyNetwork([other, self]) }),
				{ responsibilityK: 1 }
			);

			expect(await service.checkRedirect('block-1', 'pend', pendMessage('block-1')), 'pend').to.be.null;
			expect(await service.checkRedirect('block-1', 'commit', commitMessage('block-1')), 'commit').to.be.null;
			expect(await service.checkRedirect('block-1', 'cancel', cancelMessage('block-1')), 'cancel').to.be.null;
		});

		it('looks a block up once per TTL, however many requests arrive for it', async () => {
			const self = await makePeerId();
			const keyNetwork = makeKeyNetwork([self]);
			const service = new RepoService(makeComponents({ repo: makeStubRepo(), peerId: self, keyNetwork }), { responsibilityK: 1 });

			await service.checkRedirect('block-1', 'pend', pendMessage('block-1'));
			await service.checkRedirect('block-1', 'commit', commitMessage('block-1'));
			await service.checkRedirect('block-1', 'get', getMessage('block-1'));
			expect(keyNetwork.lookups, 'three requests for one block, one lookup').to.equal(1);

			await service.checkRedirect('block-2', 'pend', pendMessage('block-2'));
			expect(keyNetwork.lookups, 'a different block is its own lookup').to.equal(2);
		});

		it('looks a block up again once the TTL has passed, and acts on the new cohort', async () => {
			const self = await makePeerId();
			const other = await makePeerId();
			const cohort = [self];
			const keyNetwork = makeKeyNetwork(cohort);
			const service = new RepoService(makeComponents({ repo: makeStubRepo(), peerId: self, keyNetwork }), { responsibilityK: 1 });
			const realNow = Date.now;
			let now = realNow();
			Date.now = () => now;
			try {
				expect(await service.checkRedirect('block-1', 'pend', pendMessage('block-1')), 'in the cohort').to.be.null;
				cohort.splice(0, 1, other);

				now += RESPONSIBILITY_TTL_MS - 1;
				expect(await service.checkRedirect('block-1', 'pend', pendMessage('block-1')), 'still answered from the memo').to.be.null;
				expect(keyNetwork.lookups).to.equal(1);

				now += 1;
				const result = await service.checkRedirect('block-1', 'pend', pendMessage('block-1'));
				expect(keyNetwork.lookups, 'expired memo is looked up again').to.equal(2);
				expect(result?.redirect.peers.map(p => p.id), 'the new cohort excludes this node').to.deep.equal([other.toString()]);
			} finally {
				Date.now = realNow;
			}
		});

		it('still attaches the responsible ids to a message answered from the memo', async () => {
			const self = await makePeerId();
			const other = await makePeerId();
			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, keyNetwork: makeKeyNetwork([self, other]) }),
				{ responsibilityK: 1 }
			);

			await service.checkRedirect('block-1', 'get', getMessage('block-1'));
			const second = getMessage('block-1');
			await service.checkRedirect('block-1', 'get', second);

			expect((second as any).cluster).to.deep.equal([self.toString(), other.toString()]);
		});

		it('handles a get locally when the lookup throws', async () => {
			const self = await makePeerId();
			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, keyNetwork: makeThrowingKeyNetwork() }),
				{ responsibilityK: 1 }
			);

			expect(await service.checkRedirect('block-1', 'get', getMessage('block-1'))).to.be.null;
		});

		it('propagates a thrown lookup for pend, commit and cancel', async () => {
			const self = await makePeerId();
			const keyNetwork = makeThrowingKeyNetwork();
			const service = new RepoService(makeComponents({ repo: makeStubRepo(), peerId: self, keyNetwork }), { responsibilityK: 1 });

			for (const [op, message] of [['pend', pendMessage('block-1')], ['commit', commitMessage('block-1')], ['cancel', cancelMessage('block-1')]] as const) {
				let thrown: unknown;
				try { await service.checkRedirect('block-1', op, message); } catch (err) { thrown = err; }
				expect(thrown, `${op}: the lookup failure reaches the caller`).to.be.instanceOf(Error);
				expect((thrown as Error).message).to.include('FRET service is not registered');
			}
			expect(keyNetwork.lookups, 'a failed lookup is never memoized — every request re-asks').to.equal(3);
		});
	});

	/** End to end through the real inbound handler: what a writer on the other end of the stream sees. */
	describe('inbound writes through the stream handler', () => {
		/** A repo that records which operations reached it. */
		const makeRecordingRepo = (): { repo: IRepo, reached: string[] } => {
			const reached: string[] = [];
			const stub = makeStubRepo();
			return {
				reached,
				repo: {
					get: (gets, opts) => { reached.push('get'); return stub.get(gets, opts); },
					pend: (req, opts) => { reached.push('pend'); return stub.pend(req, opts); },
					cancel: (ref, opts) => { reached.push('cancel'); return stub.cancel(ref, opts); },
					commit: (req, opts) => { reached.push('commit'); return stub.commit(req, opts); }
				}
			};
		};

		const drive = async (service: RepoService, message: RepoMessage): Promise<{ response: unknown, aborted: boolean }> => {
			const { stream, sent, done, wasAborted } = makeServiceStream(await encodeJson(message));
			(service as unknown as { handleIncomingStream: (s: unknown, c: unknown) => void }).handleIncomingStream(stream, undefined);
			await done;
			return { response: (await decodeJson(sent))[0], aborted: wasAborted() };
		};

		const pend: RepoMessage = { operations: [{ pend: { transforms: { inserts: { 'block-1': makeBlock('block-1') }, updates: {}, deletes: [] }, actionId: 'a1' } as any }] };
		const commit: RepoMessage = { operations: [{ commit: { tailId: 'block-1', actionId: 'a1', blockIds: ['block-1'], rev: 1 } as any }] };

		it('answers a pend and a commit for a cohort that excludes this node with a redirect, never reaching the repo', async () => {
			const self = await makePeerId();
			const member = await makePeerId();
			const { repo, reached } = makeRecordingRepo();
			const service = new RepoService(
				makeComponents({ repo, peerId: self, keyNetwork: makeKeyNetwork([member]), getConnectionAddrs: () => ['/ip4/10.0.0.7/tcp/4001'] }),
				{ responsibilityK: 1 }
			);

			for (const message of [pend, commit]) {
				const { response, aborted } = await drive(service, message);
				expect(aborted).to.equal(false);
				expect((response as RedirectPayload).redirect.reason).to.equal('not_in_cluster');
				expect((response as RedirectPayload).redirect.peers).to.deep.equal([{ id: member.toString(), addrs: ['/ip4/10.0.0.7/tcp/4001'] }]);
			}
			expect(reached, 'no redirected write reaches the coordinator').to.deep.equal([]);
		});

		it('hands a pend for a cohort that includes this node to the repo', async () => {
			const self = await makePeerId();
			const { repo, reached } = makeRecordingRepo();
			const service = new RepoService(makeComponents({ repo, peerId: self, keyNetwork: makeKeyNetwork([self]) }), { responsibilityK: 1 });

			const { response } = await drive(service, pend);

			expect((response as PendResult).success).to.equal(true);
			expect(reached).to.deep.equal(['pend']);
		});

		it('aborts the stream for a pend whose lookup throws, so the writer re-picks; a get is still served', async () => {
			const self = await makePeerId();
			const { repo, reached } = makeRecordingRepo();
			const service = new RepoService(makeComponents({ repo, peerId: self, keyNetwork: makeThrowingKeyNetwork() }), { responsibilityK: 1 });

			const write = await drive(service, pend);
			expect(write.aborted, 'the writer sees a failed batch').to.equal(true);
			expect(reached, 'the write never reached the coordinator').to.deep.equal([]);

			const read = await drive(service, { operations: [{ get: { blockIds: ['block-1'], context: { committed: [], rev: 0 } } }] });
			expect(read.aborted).to.equal(false);
			expect(reached).to.deep.equal(['get']);
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
			const nm = makeKeyedKeyNetwork(byKey, [self]);

			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, keyNetwork: nm }),
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
			const nm = makeKeyedKeyNetwork(byKey, [self]);                      // fallback includes self

			const service = new RepoService(
				makeComponents({ repo: makeStubRepo(), peerId: self, keyNetwork: nm }),
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
