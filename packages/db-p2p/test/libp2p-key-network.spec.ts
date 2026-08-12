import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { multiaddr } from '@multiformats/multiaddr';
import type { PeerId, Libp2p, Connection, PendingDial } from '@libp2p/interface';
import type { SerializedTable } from 'p2p-fret';
import { waitFor } from '@optimystic/db-core/test';
import {
	Libp2pKeyPeerNetwork,
	FindCoordinatorError,
	FIND_COORDINATOR_ERROR_CODES,
	type NetworkStatePersistence,
	type PersistedNetworkState,
	type SelfCoordinationConfig
} from '../src/libp2p-key-network.js';

const makePeerId = async (): Promise<PeerId> => {
	const key = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(key);
};

/** A `queued`/`active`/… entry for a mock's dial queue. */
function pendingDial(status: PendingDial['status'], id = 'd0'): PendingDial {
	return { id, status, multiaddrs: [] } as unknown as PendingDial;
}

/** Minimal mock Libp2p that satisfies Libp2pKeyPeerNetwork's usage */
function createMockLibp2p(peerId: PeerId, options?: {
	connections?: Connection[];
	fret?: any;
	peerStore?: any;
	/** Dials libp2p is currently attempting; the futility test reads `queued`/`active` entries. */
	dialQueue?: PendingDial[];
}): Libp2p {
	const listeners: Map<string, Set<Function>> = new Map();
	return {
		peerId,
		getConnections: () => options?.connections ?? [],
		getDialQueue: () => options?.dialQueue ?? [],
		getMultiaddrs: () => [],
		addEventListener: (event: string, handler: Function) => {
			if (!listeners.has(event)) listeners.set(event, new Set());
			listeners.get(event)!.add(handler);
		},
		removeEventListener: () => {},
		...(options?.peerStore ? { peerStore: options.peerStore } : {}),
		services: {
			fret: options?.fret
		}
	} as unknown as Libp2p;
}

/** In-memory persistence implementation for testing */
class MemoryPersistence implements NetworkStatePersistence {
	public saved: PersistedNetworkState | undefined;
	private stored: PersistedNetworkState | undefined;

	constructor(initial?: PersistedNetworkState) {
		this.stored = initial;
	}

	async load(): Promise<PersistedNetworkState | undefined> {
		return this.stored;
	}

	async save(state: PersistedNetworkState): Promise<void> {
		this.saved = state;
		this.stored = state;
	}
}

describe('Libp2pKeyPeerNetwork', () => {
	let selfPeerId: PeerId;

	before(async () => {
		selfPeerId = await makePeerId();
	});

	// The inter-attempt sleep is worth paying only when something could arrive during it. The
	// verdict comes from evidence available at the moment of the call — a non-self candidate we
	// route to, or a dial libp2p is actually attempting — never from construction-time config
	// (`networkMode`) or a monotonic history mark (`networkHighWaterMark`), both of which kept
	// the window open forever on nodes that could never fill it.
	describe('retryCouldImprove()', () => {
		const improve = (network: Libp2pKeyPeerNetwork, ids: string[]): boolean =>
			(network as any).retryCouldImprove(ids);

		it('returns false for a self-only candidate list with an empty dial queue', () => {
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			expect(improve(network, [selfPeerId.toString()])).to.be.false;
		});

		it('returns false for an empty candidate list with an empty dial queue', () => {
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			expect(improve(network, [])).to.be.false;
		});

		it('returns true when a dial is active, even with a self-only candidate list', () => {
			const libp2p = createMockLibp2p(selfPeerId, { dialQueue: [pendingDial('active')] });
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			expect(improve(network, [selfPeerId.toString()])).to.be.true;
		});

		it('returns true when a dial is queued', () => {
			const libp2p = createMockLibp2p(selfPeerId, { dialQueue: [pendingDial('queued')] });
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			expect(improve(network, [selfPeerId.toString()])).to.be.true;
		});

		it('returns false when the dial queue holds only settled entries', () => {
			// A dial that has already failed (or succeeded, and so is a connection now) cannot
			// complete during the sleep — it is history, not something to wait for.
			const libp2p = createMockLibp2p(selfPeerId, {
				dialQueue: [pendingDial('error', 'd0'), pendingDial('success', 'd1')]
			});
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			expect(improve(network, [selfPeerId.toString()])).to.be.false;
		});

		it('returns true when the candidate list holds a non-self id', () => {
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			expect(improve(network, [selfPeerId.toString(), 'other-peer-id'])).to.be.true;
		});

		it('returns false for a joining node with HWM>1 that knows no peer and dials nobody', async () => {
			// The regression this test exists for: configuration ('joining' — a bootstrap
			// address was configured) and history (HWM 10 — this node once saw a 10-peer
			// network) both used to force the window open. Neither says a peer can arrive in
			// the next 500ms; the empty FRET neighbourhood and empty dial queue say it cannot.
			const persistence = new MemoryPersistence({
				version: 1,
				networkHighWaterMark: 10,
				lastConnectedTimestamp: Date.now() - 60000,
				consecutiveIsolatedSessions: 0
			});
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'joining', persistence);
			await network.initFromPersistedState();
			expect(improve(network, [selfPeerId.toString()])).to.be.false;
		});
	});

	describe('initFromPersistedState()', () => {
		it('does nothing when no persistence is configured', async () => {
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			// Should not throw
			await network.initFromPersistedState();
		});

		it('does nothing when persistence returns undefined', async () => {
			const persistence = new MemoryPersistence(undefined);
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
			await network.initFromPersistedState();
			// HWM should remain at default (1)
			expect((network as any).networkHighWaterMark).to.equal(1);
		});

		it('restores HWM and consecutiveIsolatedSessions from persisted state', async () => {
			const persistence = new MemoryPersistence({
				version: 1,
				networkHighWaterMark: 50,
				lastConnectedTimestamp: Date.now() - 120000,
				consecutiveIsolatedSessions: 2
			});
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
			await network.initFromPersistedState();

			expect((network as any).networkHighWaterMark).to.equal(50);
			// consecutiveIsolatedSessions should be incremented because HWM>1 but no FRET entries
			expect((network as any).consecutiveIsolatedSessions).to.equal(3);
		});

		it('increments consecutiveIsolatedSessions when HWM>1 but FRET table is empty', async () => {
			const persistence = new MemoryPersistence({
				version: 1,
				networkHighWaterMark: 5,
				lastConnectedTimestamp: Date.now() - 60000,
				consecutiveIsolatedSessions: 0,
				fretTable: { v: 1, peerId: selfPeerId.toString(), timestamp: Date.now(), entries: [] }
			});
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
			await network.initFromPersistedState();

			expect((network as any).consecutiveIsolatedSessions).to.equal(1);
		});

		it('does not increment consecutiveIsolatedSessions when HWM<=1', async () => {
			const persistence = new MemoryPersistence({
				version: 1,
				networkHighWaterMark: 1,
				lastConnectedTimestamp: Date.now() - 60000,
				consecutiveIsolatedSessions: 0
			});
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
			await network.initFromPersistedState();

			expect((network as any).consecutiveIsolatedSessions).to.equal(0);
		});

		it('does not increment consecutiveIsolatedSessions when FRET table has multiple entries', async () => {
			const now = Date.now();
			const makeFretEntry = (id: string, coord: string) => ({
				id, coord, relevance: 1, lastAccess: now,
				state: 'disconnected' as const, accessCount: 1,
				successCount: 1, failureCount: 0, avgLatencyMs: 10
			});
			const persistence = new MemoryPersistence({
				version: 1,
				networkHighWaterMark: 10,
				lastConnectedTimestamp: now - 60000,
				consecutiveIsolatedSessions: 1,
				fretTable: {
					v: 1,
					peerId: selfPeerId.toString(),
					timestamp: now,
					entries: [makeFretEntry('peer-a', 'AAAA'), makeFretEntry('peer-b', 'BBBB')]
				}
			});
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
			await network.initFromPersistedState();

			// Should stay at 1, not increment
			expect((network as any).consecutiveIsolatedSessions).to.equal(1);
		});
	});

	describe('persistState()', () => {
		it('does nothing when no persistence is configured', () => {
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			// Should not throw
			(network as any).persistState();
		});

		it('captures current state including HWM and sessions', async () => {
			const persistence = new MemoryPersistence({
				version: 1,
				networkHighWaterMark: 25,
				lastConnectedTimestamp: Date.now() - 30000,
				consecutiveIsolatedSessions: 1
			});
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
			await network.initFromPersistedState();

			// Trigger persist
			(network as any).persistState();

			// Poll for the fire-and-forget save to land (in-process, so the default fast cadence applies).
			await waitFor(() => persistence.saved !== undefined, { description: 'the fire-and-forget persistState() save completed' });

			expect(persistence.saved).to.not.be.undefined;
			expect(persistence.saved!.version).to.equal(1);
			expect(persistence.saved!.networkHighWaterMark).to.equal(25);
			// consecutiveIsolatedSessions was 1, incremented to 2 because HWM>1 and no FRET entries
			expect(persistence.saved!.consecutiveIsolatedSessions).to.equal(2);
		});

		it('captures FRET table when available', async () => {
			const mockFretTable: SerializedTable = {
				v: 1,
				peerId: selfPeerId.toString(),
				timestamp: Date.now(),
				entries: []
			};
			const mockFret = {
				exportTable: () => mockFretTable,
				getNetworkSizeEstimate: () => ({ size_estimate: 1, confidence: 0.5 }),
				getNeighbors: () => [],
				detectPartition: () => false
			};
			const persistence = new MemoryPersistence();
			const libp2p = createMockLibp2p(selfPeerId, { fret: mockFret });
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);

			(network as any).persistState();
			await waitFor(() => persistence.saved !== undefined, { description: 'the fire-and-forget persistState() save captured the FRET table' });

			expect(persistence.saved).to.not.be.undefined;
			expect(persistence.saved!.fretTable).to.deep.equal(mockFretTable);
		});
	});

	describe('shouldAllowSelfCoordination()', () => {
		it('allows when HWM<=1 (bootstrap node)', () => {
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			const decision = network.shouldAllowSelfCoordination();
			expect(decision.allow).to.be.true;
			expect(decision.reason).to.equal('bootstrap-node');
		});

		it('blocks when disabled', () => {
			const libp2p = createMockLibp2p(selfPeerId);
			const config: SelfCoordinationConfig = { allowSelfCoordination: false };
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, config, 'forming');
			const decision = network.shouldAllowSelfCoordination();
			expect(decision.allow).to.be.false;
			expect(decision.reason).to.equal('disabled');
		});

		it('allows after 3+ consecutive isolated sessions (HWM decay)', async () => {
			const persistence = new MemoryPersistence({
				version: 1,
				networkHighWaterMark: 50,
				lastConnectedTimestamp: Date.now() - 300000,
				consecutiveIsolatedSessions: 2 // will be incremented to 3 since HWM>1 and no FRET
			});
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
			await network.initFromPersistedState();

			expect((network as any).consecutiveIsolatedSessions).to.equal(3);
			const decision = network.shouldAllowSelfCoordination();
			expect(decision.allow).to.be.true;
			expect(decision.reason).to.equal('hwm-decay');
			expect(decision.warn).to.be.true;
		});

		it('blocks when HWM>1 and only 1 isolated session (not enough decay)', async () => {
			const persistence = new MemoryPersistence({
				version: 1,
				networkHighWaterMark: 50,
				lastConnectedTimestamp: Date.now(), // recently connected
				consecutiveIsolatedSessions: 0 // will increment to 1
			});
			const libp2p = createMockLibp2p(selfPeerId);
			const config: SelfCoordinationConfig = { gracePeriodMs: 60000 };
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, config, 'forming', persistence);
			await network.initFromPersistedState();

			expect((network as any).consecutiveIsolatedSessions).to.equal(1);
			const decision = network.shouldAllowSelfCoordination();
			// Should not allow because HWM>1, sessions<3, and grace period applies
			expect(decision.allow).to.be.false;
			// ...but the refusal is a clock, not evidence: the same node with the same
			// information self-coordinates once gracePeriodMs elapses, so the denial is
			// DEFERRABLE and findCoordinator degrades to self rather than failing the caller.
			expect(decision.reason).to.equal('grace-period-not-elapsed');
			expect(decision.deferrable, 'a grace-period denial is deferrable for a write too').to.be.true;
		});

		it('marks a partition denial hard for a write and deferrable for a read', async () => {
			const persistence = new MemoryPersistence({
				version: 1,
				networkHighWaterMark: 10,
				lastConnectedTimestamp: Date.now() - 10 * 60_000, // grace long elapsed
				consecutiveIsolatedSessions: 0
			});
			const fret = {
				getNeighbors: () => [],
				getNetworkSizeEstimate: () => ({ size_estimate: 10, confidence: 0.5 }),
				detectPartition: () => true,
				exportTable: () => undefined
			};
			const libp2p = createMockLibp2p(selfPeerId, { fret });
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
			await network.initFromPersistedState();

			const write = network.shouldAllowSelfCoordination('write');
			expect(write.allow).to.be.false;
			expect(write.reason).to.equal('partition-detected');
			expect(write.deferrable, 'a partition is positive evidence against an isolated WRITE').to.be.false;

			const read = network.shouldAllowSelfCoordination('read');
			expect(read.allow).to.be.false;
			expect(read.reason).to.equal('partition-detected');
			expect(read.deferrable, 'a partition says nothing about serving a READ from our own replica').to.be.true;
		});

		it('marks a suspicious-shrinkage denial hard for a write and deferrable for a read', async () => {
			const persistence = new MemoryPersistence({
				version: 1,
				networkHighWaterMark: 10,
				lastConnectedTimestamp: Date.now() - 10 * 60_000, // grace long elapsed
				consecutiveIsolatedSessions: 0
			});
			const fret = {
				getNeighbors: () => [],
				// 10 → 4 is a 60% drop, past the 0.5 default threshold
				getNetworkSizeEstimate: () => ({ size_estimate: 4, confidence: 0.5 }),
				detectPartition: () => false,
				exportTable: () => undefined
			};
			const libp2p = createMockLibp2p(selfPeerId, { fret });
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
			await network.initFromPersistedState();

			const write = network.shouldAllowSelfCoordination('write');
			expect(write.allow).to.be.false;
			expect(write.reason).to.equal('suspicious-shrinkage');
			expect(write.deferrable, 'lost most of the network we knew — do not coordinate a WRITE alone').to.be.false;

			const read = network.shouldAllowSelfCoordination('read');
			expect(read.allow).to.be.false;
			expect(read.reason).to.equal('suspicious-shrinkage');
			expect(read.deferrable, 'a shrunk network says nothing about serving a READ from our own replica').to.be.true;
		});

		it('marks a disabled denial hard for BOTH intents', () => {
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, { allowSelfCoordination: false }, 'forming');
			for (const intent of ['read', 'write'] as const) {
				const decision = network.shouldAllowSelfCoordination(intent);
				expect(decision.allow, `disabled blocks ${intent}`).to.be.false;
				expect(decision.reason).to.equal('disabled');
				expect(decision.deferrable, `an explicit operator switch is never deferrable (${intent})`).to.be.false;
			}
		});
	});

	describe('consecutiveIsolatedSessions reset on connection', () => {
		it('resets to 0 when connections are observed', async () => {
			const persistence = new MemoryPersistence({
				version: 1,
				networkHighWaterMark: 10,
				lastConnectedTimestamp: Date.now() - 60000,
				consecutiveIsolatedSessions: 2
			});

			const otherPeerId = await makePeerId();
			const mockConnection = {
				remotePeer: otherPeerId,
				remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/8000' }
			} as unknown as Connection;
			const libp2p = createMockLibp2p(selfPeerId, { connections: [mockConnection] });
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
			await network.initFromPersistedState();

			// consecutiveIsolatedSessions was 2, incremented to 3 (HWM>1, no FRET entries)
			expect((network as any).consecutiveIsolatedSessions).to.equal(3);

			// Simulate connection event by calling updateNetworkObservations
			(network as any).updateNetworkObservations();

			// Should be reset because connections.length > 0
			expect((network as any).consecutiveIsolatedSessions).to.equal(0);
		});
	});

	describe('findCoordinator() — solo/bootstrap node error codes', () => {
		it('returns self on first call when no excludes', async () => {
			const fret = {
				getNeighbors: () => [],
				getNetworkSizeEstimate: () => ({ size_estimate: 1, confidence: 0.5 }),
				detectPartition: () => false,
				exportTable: () => undefined
			};
			const libp2p = createMockLibp2p(selfPeerId, { fret });
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			const key = new TextEncoder().encode('optimystic/schema');
			const result = await network.findCoordinator(key);
			expect(result.toString()).to.equal(selfPeerId.toString());
		});

		it('throws SELF_COORDINATION_EXHAUSTED (not "all candidates excluded") when self is excluded on solo node', async () => {
			const fret = {
				getNeighbors: () => [],
				getNetworkSizeEstimate: () => ({ size_estimate: 1, confidence: 0.5 }),
				detectPartition: () => false,
				exportTable: () => undefined
			};
			const libp2p = createMockLibp2p(selfPeerId, { fret });
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			const key = new TextEncoder().encode('optimystic/schema');

			let caught: unknown;
			try {
				await network.findCoordinator(key, { excludedPeers: [selfPeerId] });
				expect.fail('Expected findCoordinator to throw when self is excluded on solo node');
			} catch (err) {
				caught = err;
			}

			expect(caught).to.be.instanceOf(FindCoordinatorError);
			expect((caught as FindCoordinatorError).code).to.equal(
				FIND_COORDINATOR_ERROR_CODES.SELF_COORDINATION_EXHAUSTED
			);
			// Sanity: the error should NOT be the generic "all candidates excluded" message
			expect((caught as Error).message).to.match(/exhausted/i);
		});

		it('throws NO_COORDINATOR_AVAILABLE (not self-exhausted) when HWM>1 and self excluded', async () => {
			// Simulate a node that has seen a larger network (HWM > 1) but is currently isolated
			const persistence = new MemoryPersistence({
				version: 1,
				networkHighWaterMark: 10,
				lastConnectedTimestamp: Date.now() - 10 * 60_000,
				consecutiveIsolatedSessions: 3 // enough for hwm-decay
			});
			const fret = {
				getNeighbors: () => [],
				getNetworkSizeEstimate: () => ({ size_estimate: 10, confidence: 0.5 }),
				detectPartition: () => false,
				exportTable: () => undefined
			};
			const libp2p = createMockLibp2p(selfPeerId, { fret });
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
			await network.initFromPersistedState();

			const key = new TextEncoder().encode('some-block');
			let caught: unknown;
			try {
				await network.findCoordinator(key, { excludedPeers: [selfPeerId] });
				expect.fail('Expected findCoordinator to throw');
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.instanceOf(FindCoordinatorError);
			// HWM > 1 → not the solo-exhausted case
			expect((caught as FindCoordinatorError).code).to.equal(
				FIND_COORDINATOR_ERROR_CODES.NO_COORDINATOR_AVAILABLE
			);
		});
	});

	// --- Boot-time self-selection and the coordinator cache -----------------------
	// A node that reads a key before its first dial completes has only itself in FRET,
	// so the FRET tier legitimately picks self. That pick must NOT be memoized: the
	// coordinator cache is consulted ahead of every other tier, so a cached boot-time
	// self would keep serving this node's own (possibly stale) replica for the full
	// 30-minute TTL long after real peers connected. Every tier that can select self
	// must also clear shouldAllowSelfCoordination() first, so a partitioned node cannot
	// slip past the guard just because self happens to sit in the key's FRET neighborhood.
	describe('findCoordinator() — boot-time self-selection and cache', () => {
		function connTo(peerId: PeerId): Connection {
			return {
				remotePeer: peerId,
				status: 'open',
				remoteAddr: { toString: () => `/ip4/10.0.0.1/tcp/4001/p2p/${peerId.toString()}` }
			} as unknown as Connection;
		}

		/**
		 * Mock libp2p whose connection list and FRET neighbor list are MUTABLE between
		 * calls — the shared `createMockLibp2p` helper closes over a fixed array, but
		 * these tests need to simulate a peer arriving mid-test.
		 */
		function createMutableMock(options: {
			connections: Connection[];
			neighbors: string[];
			sizeEstimate?: number;
			partitioned?: boolean;
		}) {
			const state = { connections: options.connections, neighbors: options.neighbors };
			const fret = {
				getNeighbors: () => state.neighbors,
				getNetworkSizeEstimate: () => ({ size_estimate: options.sizeEstimate ?? 1, confidence: 0.5 }),
				detectPartition: () => options.partitioned ?? false,
				exportTable: () => undefined,
				assembleCohort: () => []
			};
			const libp2p = {
				peerId: selfPeerId,
				getConnections: () => state.connections,
				getMultiaddrs: () => [],
				addEventListener: () => {},
				removeEventListener: () => {},
				services: { fret }
			} as unknown as Libp2p;
			return { libp2p, state };
		}

		it('does not cache a boot-time self pick, so a peer connecting takes over the key', async () => {
			const peerA = await makePeerId();
			const { libp2p, state } = createMutableMock({
				connections: [],
				neighbors: [selfPeerId.toString()]
			});
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			const key = new TextEncoder().encode('collection-tree-key');

			// Boot-time read, no connections yet → self is picked (correct at this instant).
			expect((await network.findCoordinator(key)).toString()).to.equal(selfPeerId.toString());

			// A real peer connects moments later and FRET learns it, nearer the key than self.
			state.connections = [connTo(peerA)];
			state.neighbors = [peerA.toString(), selfPeerId.toString()];

			// The next read must route to the real peer, not to a cached boot-time self.
			expect((await network.findCoordinator(key)).toString()).to.equal(peerA.toString());
		});

		it('writes no cache entry at all for a self pick', async () => {
			const { libp2p } = createMutableMock({
				connections: [],
				neighbors: [selfPeerId.toString()]
			});
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			const key = new TextEncoder().encode('collection-tree-key');

			const result = await network.findCoordinator(key);
			expect(result.toString()).to.equal(selfPeerId.toString());
			// Pins the no-cache rule directly rather than only through its downstream effect.
			expect((network as any).coordinatorCache.size, 'no coordinator-cache entry for a self pick').to.equal(0);
		});

		it('ignores an externally-seeded self entry — recordCoordinator is the gate', async () => {
			// recordCoordinator is public and MOST of its callers are outside this class:
			// NetworkTransactor writes back whatever findCoordinator returned (self included)
			// after each pend, and RepoClient / ClusterClient write redirect targets. Gating
			// only the internal selection tiers would let those writers re-create the entry.
			const peerA = await makePeerId();
			const { libp2p, state } = createMutableMock({
				connections: [],
				neighbors: [peerA.toString()]
			});
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			const key = new TextEncoder().encode('redirected-key');

			network.recordCoordinator(key, selfPeerId);
			expect((network as any).coordinatorCache.size, 'self-valued write ignored').to.equal(0);

			state.connections = [connTo(peerA)];
			expect((await network.findCoordinator(key)).toString()).to.equal(peerA.toString());
		});

		it('reproduces the NetworkTransactor write-back: a self pick never survives to pin the key', async () => {
			// End-to-end shape of the original poisoning: findCoordinator returns self at boot,
			// the caller pends against self, then NetworkTransactor caches the peer it actually
			// used (`recordCoordinator(key, b.peerId)` — self). A peer that arrives WITHOUT a
			// fresh connection:open event (it was already connected; only its identify landed)
			// must still take over the key, so the fix cannot rely on a connection-time sweep.
			const peerA = await makePeerId();
			const { libp2p, state } = createMutableMock({
				connections: [connTo(peerA)],
				neighbors: [selfPeerId.toString()]
			});
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			const key = new TextEncoder().encode('collection-tree-key');

			const first = await network.findCoordinator(key);
			expect(first.toString()).to.equal(selfPeerId.toString());
			// The write-back NetworkTransactor performs after the pend completes.
			network.recordCoordinator(key, first);
			expect((network as any).coordinatorCache.size, 'write-back must not seed a self entry').to.equal(0);

			// FRET now knows the already-connected peer; no connection:open fires.
			state.neighbors = [peerA.toString(), selfPeerId.toString()];
			expect((await network.findCoordinator(key)).toString()).to.equal(peerA.toString());
		});

		it('still caches a remote coordinator — the gate must not disable the cache', async () => {
			// Regression guard on the write gate: only SELF is refused. A remote entry must
			// still be written and still short-circuit selection ahead of every tier.
			const peerA = await makePeerId();
			const peerB = await makePeerId();
			const { libp2p, state } = createMutableMock({
				connections: [connTo(peerA)],
				neighbors: [peerA.toString()]
			});
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			const key = new TextEncoder().encode('remote-coordinated-key');

			network.recordCoordinator(key, peerB);
			expect((network as any).coordinatorCache.size, 'remote entry cached').to.equal(1);

			// peerB isn't connected or a FRET neighbor; only the cache can produce it.
			state.neighbors = [peerA.toString()];
			expect((await network.findCoordinator(key)).toString()).to.equal(peerB.toString());
		});

		it('honours the self-coordination guard on the FRET path (self is a neighbor of the key)', async () => {
			// Self IS a FRET neighbor of this key, which at one point let the FRET tier return
			// self and skip the guard entirely. The denial used here must be a HARD one —
			// FRET reports a partition, and this is a write — because a deferrable denial (e.g.
			// the grace period) is exactly the case that now degrades to self instead of
			// throwing. What is pinned here is that self cannot slip past a hard guard verdict
			// merely by sitting in the key's FRET neighbourhood.
			const persistence = new MemoryPersistence({
				version: 1,
				networkHighWaterMark: 5,
				lastConnectedTimestamp: Date.now() - 10 * 60_000, // grace long elapsed: the partition is the only denial
				consecutiveIsolatedSessions: 0
			});
			const { libp2p } = createMutableMock({
				connections: [],
				neighbors: [selfPeerId.toString()],
				sizeEstimate: 5,
				partitioned: true
			});
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
			await network.initFromPersistedState();

			// Precondition: the guard really does refuse for this node, and refuses HARD.
			const decision = network.shouldAllowSelfCoordination();
			expect(decision.allow).to.be.false;
			expect(decision.reason).to.equal('partition-detected');
			expect(decision.deferrable).to.be.false;

			let caught: unknown;
			try {
				await network.findCoordinator(new TextEncoder().encode('collection-tree-key'));
				expect.fail('Expected findCoordinator to throw SELF_COORDINATION_BLOCKED rather than returning self');
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.instanceOf(FindCoordinatorError);
			expect((caught as FindCoordinatorError).code).to.equal(
				FIND_COORDINATOR_ERROR_CODES.SELF_COORDINATION_BLOCKED
			);
		});

		it('drops self on the FRET path but still selects a connected peer rather than throwing', async () => {
			// Guard refusal must not short-circuit the whole call: a perfectly good peer the
			// FRET/fallback tiers would find must still be selected. `allowSelfCoordination:
			// false` is the one guard verdict that holds regardless of connection state, so it
			// isolates "self dropped" from "no peers around".
			const peerA = await makePeerId();
			// Self listed FIRST among the key's FRET neighbors, so at HEAD it would win outright.
			const { libp2p, state } = createMutableMock({
				connections: [],
				neighbors: [selfPeerId.toString(), peerA.toString()]
			});
			state.connections = [connTo(peerA)];
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, { allowSelfCoordination: false }, 'forming');
			expect(network.shouldAllowSelfCoordination().allow).to.be.false;

			const result = await network.findCoordinator(new TextEncoder().encode('collection-tree-key'));
			expect(result.toString()).to.equal(peerA.toString());
		});

		it('a genuinely solo node still self-coordinates on every call without entering the retry sleep', async () => {
			// Guard against a regression where not caching self pushes the solo path into the
			// 3×500ms retry loop. HWM 1, no connections, FRET knows only self → 'bootstrap-node'
			// allows, self is returned each time, and each call must finish far inside one
			// inter-attempt delay (500ms).
			const { libp2p } = createMutableMock({
				connections: [],
				neighbors: [selfPeerId.toString()]
			});
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			const key = new TextEncoder().encode('solo-key');

			const t0 = Date.now();
			for (let i = 0; i < 3; i++) {
				expect((await network.findCoordinator(key)).toString()).to.equal(selfPeerId.toString());
			}
			expect(Date.now() - t0, 'three solo lookups stay well under one 500ms retry delay').to.be.lessThan(400);
		});
	});

	// --- Isolated node degrades to its own replica --------------------------------
	// A node that has just lost its last connection is inside the 30s grace period, so the
	// self-coordination guard refuses. That refusal used to fail the whole lookup with
	// SELF_COORDINATION_BLOCKED — which bought no safety, because the SAME node with the SAME
	// information self-coordinates freely once the clock passes gracePeriodMs (and a self-only
	// cohort commits under allowClusterDownsize, the default). A grace-period denial is now
	// DEFERRABLE: the last-resort tier degrades to self with a warning instead of throwing,
	// and a READ skips the retry loop entirely since answering from our own replica is what an
	// isolated node must accept anyway. Only a HARD denial — an explicit `disabled` switch, or
	// a detected partition on a WRITE — still fails the caller.
	describe('findCoordinator() — isolated node degrades to its own replica', () => {
		function connTo(peerId: PeerId): Connection {
			return {
				remotePeer: peerId,
				status: 'open',
				remoteAddr: { toString: () => `/ip4/10.0.0.1/tcp/4001/p2p/${peerId.toString()}` }
			} as unknown as Connection;
		}

		/**
		 * The reproduced scenario, verbatim: this node has seen a 10-peer network, has ZERO
		 * connections, lost its last one 2.3s ago (well inside the 30s grace period), and FRET
		 * reports no shrinkage, no partition, and self as the key's only neighbour. Nothing here
		 * is evidence of anything — only a clock that has not run out.
		 *
		 * `connectedPeer` breaks the isolation: that peer is connected and is a FRET neighbour of
		 * the key, but ranks BEHIND self — the adversarial ordering, since a self admitted at the
		 * FRET tier would then take the key ahead of it.
		 *
		 * `dialInFlight` puts one `active` entry in libp2p's dial queue: a connection that can
		 * complete during an inter-attempt sleep, which is what makes the retry window worth
		 * paying. Without it this node knows of no peer and is attempting none, so the window is
		 * futile and the lookup goes straight to the last-resort tier.
		 */
		type MutableNetworkState = { connections: Connection[]; neighbors: string[] };

		async function justDisconnectedNode(options?: {
			partitioned?: boolean;
			connectedPeer?: PeerId;
			dialInFlight?: boolean;
			/** Persisted high-water mark; >1 is the "has seen a real network" shape. */
			highWaterMark?: number;
			networkMode?: 'forming' | 'joining';
			/** FRET neighbours of the key; defaults to self (plus `connectedPeer`, when given). */
			neighbors?: string[];
		}) {
			const persistence = new MemoryPersistence({
				version: 1,
				networkHighWaterMark: options?.highWaterMark ?? 10,
				lastConnectedTimestamp: Date.now() - 2_300,
				consecutiveIsolatedSessions: 0
			});
			const peer = options?.connectedPeer;
			const state: MutableNetworkState = {
				connections: peer ? [connTo(peer)] : [],
				neighbors: options?.neighbors
					?? (peer ? [selfPeerId.toString(), peer.toString()] : [selfPeerId.toString()])
			};
			// findCoordinator consults FRET exactly once per retry attempt, so this counts
			// attempts — a clock-free stand-in for "did the lookup enter the retry loop".
			let attempts = 0;
			const fret = {
				getNeighbors: () => {
					attempts++;
					return state.neighbors;
				},
				getNetworkSizeEstimate: () => ({ size_estimate: 10, confidence: 0.5 }),
				detectPartition: () => options?.partitioned ?? false,
				exportTable: () => undefined,
				assembleCohort: () => []
			};
			const dialQueue: PendingDial[] = options?.dialInFlight ? [pendingDial('active')] : [];
			const libp2p = {
				peerId: selfPeerId,
				getConnections: () => state.connections,
				getDialQueue: () => dialQueue,
				getMultiaddrs: () => [],
				addEventListener: () => {},
				removeEventListener: () => {},
				services: { fret }
			} as unknown as Libp2p;
			const network = new Libp2pKeyPeerNetwork(
				libp2p, 16, undefined, options?.networkMode ?? 'forming', persistence
			);
			await network.initFromPersistedState();
			return { network, state, attemptCount: () => attempts };
		}

		const KEY = new TextEncoder().encode('isolated-node-key');

		it('serves a READ from its own replica immediately, without paying the retry loop', async () => {
			const { network, attemptCount } = await justDisconnectedNode();
			const result = await network.findCoordinator(KEY, { intent: 'read' });
			expect(result.toString()).to.equal(selfPeerId.toString());
			// The FRET tier admits self on a deferrable denial for an isolated read, so the
			// lookup resolves on the first attempt and never enters a 500ms inter-attempt sleep.
			expect(attemptCount(), 'an isolated read resolves without a second attempt').to.equal(1);
		});

		it('completes a WRITE from its own replica without paying a futile retry window', async () => {
			// A write keeps dropping self at the FRET tier, so it reaches the inter-attempt
			// sleep — but this node knows of no peer other than itself and is dialling nobody,
			// so no connection can land during that sleep. The window is skipped and the
			// last-resort tier degrades to self on the FIRST attempt, rather than failing (and
			// rather than burning ~1s per block first).
			const { network, attemptCount } = await justDisconnectedNode();
			const result = await network.findCoordinator(KEY); // default intent: 'write'
			expect(result.toString()).to.equal(selfPeerId.toString());
			expect(attemptCount(), 'a futile write window is not paid').to.equal(1);
		});

		it('a WRITE still spends the full retry window while a dial is in flight', async () => {
			// The other half of the same rule: with a connection attempt actually running, a
			// peer CAN land during the sleep, so the window is worth paying and all 3 attempts
			// run before degrading to self. This is what preserves "a peer that lands during
			// the write retry window still wins the key over self".
			const { network, attemptCount } = await justDisconnectedNode({ dialInFlight: true });
			const result = await network.findCoordinator(KEY);
			expect(result.toString()).to.equal(selfPeerId.toString());
			expect(attemptCount(), 'a dial in flight keeps the retry window').to.equal(3);
		});

		it('a solo node that never had company also skips the window (joining mode, HWM 1)', async () => {
			// The reported case: a node configured with a bootstrap address it has never
			// reached. `networkMode` is fixed at construction ('joining' the moment any
			// bootstrap address is configured) and used to force the window open forever;
			// nothing about it says a peer can arrive in the next 500ms. FRET is empty here —
			// not even self — so no tier can pick anything before the last-resort self degrade.
			const { network, attemptCount } = await justDisconnectedNode({
				networkMode: 'joining',
				highWaterMark: 1,
				neighbors: []
			});
			const result = await network.findCoordinator(KEY);
			expect(result.toString()).to.equal(selfPeerId.toString());
			expect(attemptCount(), 'configuration alone is not something to wait for').to.equal(1);
		});

		it('a peer that lands during the write retry window still wins the key over self', async () => {
			// Guards against the FRET-tier read admission leaking into the write path: while the
			// retry loop is sleeping, self must stay dropped so a real peer takes the key.
			//
			// The arrival must land in an INTER-ATTEMPT SLEEP, not mid-attempt: an attempt
			// snapshots the connection list up front but consults the self-coordination guard
			// lazily afterwards, so a connection appearing between those two reads is visible to
			// the guard (which then allows self) while still invisible to the candidate filter.
			// 50ms puts it deep inside attempt 0's 500ms sleep — attempt 0's body runs in ~1ms —
			// rather than the 400ms of slack a late-window timer would leave. `attemptCount`
			// pins WHICH attempt made the pick, so a machine stalled enough to break that
			// assumption fails loudly here instead of passing for the wrong reason.
			//
			// `dialInFlight` is what buys the sleep in the first place — and it is also the
			// realistic reason a peer shows up 50ms later, so the scenario reads truer than the
			// dial-less version it replaced.
			const peerA = await makePeerId();
			const { network, state, attemptCount } = await justDisconnectedNode({ dialInFlight: true });
			const arrival = setTimeout(() => {
				state.connections = [connTo(peerA)];
				state.neighbors = [peerA.toString(), selfPeerId.toString()];
			}, 50);
			try {
				const result = await network.findCoordinator(KEY);
				expect(result.toString(), 'the arriving peer wins over degraded self').to.equal(peerA.toString());
				expect(attemptCount(), 'the peer is picked on the attempt right after it arrives').to.equal(2);
			} finally {
				clearTimeout(arrival);
			}
		});

		it('a detected partition still blocks a WRITE but never a READ', async () => {
			// Skipping a futile window skips only the WAITING, never a decision: the break falls
			// through to the same last-resort tier, which asks the same guard. The denial
			// survives verbatim — it just arrives ~1s sooner, on the first attempt.
			const { network: writeNet, attemptCount: writeAttempts } = await justDisconnectedNode({ partitioned: true });
			let caught: unknown;
			try {
				await writeNet.findCoordinator(KEY);
				expect.fail('Expected a partitioned write to throw SELF_COORDINATION_BLOCKED');
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.instanceOf(FindCoordinatorError);
			expect((caught as FindCoordinatorError).code).to.equal(
				FIND_COORDINATOR_ERROR_CODES.SELF_COORDINATION_BLOCKED
			);
			expect(writeAttempts(), 'the denial does not need the retry window to be paid first').to.equal(1);

			// A partition is no argument against answering a read from our own replica — the
			// layers below already report how good that answer is.
			const { network: readNet, attemptCount: readAttempts } = await justDisconnectedNode({ partitioned: true });
			const result = await readNet.findCoordinator(KEY, { intent: 'read' });
			expect(result.toString()).to.equal(selfPeerId.toString());
			expect(readAttempts(), 'a partitioned read still resolves on the first attempt').to.equal(1);
		});

		it('a futile lookup with self excluded still reports SELF_COORDINATION_EXHAUSTED, in one attempt', async () => {
			// Self excluded empties the futility input (self was the only FRET neighbour), so
			// the window is skipped — and the same solo/bootstrap error still surfaces, with
			// its message about the original first-attempt cause intact.
			const { network, attemptCount } = await justDisconnectedNode({ highWaterMark: 1 });
			let caught: unknown;
			try {
				await network.findCoordinator(KEY, { excludedPeers: [selfPeerId] });
				expect.fail('Expected findCoordinator to throw SELF_COORDINATION_EXHAUSTED');
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.instanceOf(FindCoordinatorError);
			expect((caught as FindCoordinatorError).code).to.equal(
				FIND_COORDINATOR_ERROR_CODES.SELF_COORDINATION_EXHAUSTED
			);
			expect(attemptCount(), 'nothing to wait for, so no window').to.equal(1);
		});

		it('a futile lookup with self excluded and HWM>1 still reports NO_COORDINATOR_AVAILABLE, in one attempt', async () => {
			const { network, attemptCount } = await justDisconnectedNode(); // HWM 10
			let caught: unknown;
			try {
				await network.findCoordinator(KEY, { excludedPeers: [selfPeerId] });
				expect.fail('Expected findCoordinator to throw NO_COORDINATOR_AVAILABLE');
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.instanceOf(FindCoordinatorError);
			expect((caught as FindCoordinatorError).code).to.equal(
				FIND_COORDINATOR_ERROR_CODES.NO_COORDINATOR_AVAILABLE
			);
			expect(attemptCount(), 'nothing to wait for, so no window').to.equal(1);
		});

		it('an excluded non-self FRET neighbour is not something to wait for', async () => {
			// The futility input is exclusion- and ban-filtered: a neighbour we may never pick
			// cannot improve a later attempt, so its presence must NOT buy the window. Both the
			// FRET tier and the connected fallback would reject it too.
			const peerA = await makePeerId();
			const { network, attemptCount } = await justDisconnectedNode({
				neighbors: [selfPeerId.toString(), peerA.toString()]
			});
			const result = await network.findCoordinator(KEY, { excludedPeers: [peerA] });
			expect(result.toString()).to.equal(selfPeerId.toString());
			expect(attemptCount(), 'an excluded neighbour does not keep the window open').to.equal(1);
		});

		it('a READ still prefers a reachable peer over degraded self while any connection is live', async () => {
			// The read admission at the FRET tier is a fallback for an ISOLATED node, not a
			// standing preference. Self is FIRST in the FRET neighbour list here and has no
			// reputation record (score 0, the minimum), so admitting it would take the key —
			// a partitioned node with a live connection must still route the read to that
			// neighbour rather than to the node its own guard just flagged. Costs nothing:
			// the retry sleep only runs at zero connections.
			const peerA = await makePeerId();
			const { network } = await justDisconnectedNode({ partitioned: true, connectedPeer: peerA });
			const result = await network.findCoordinator(KEY, { intent: 'read' });
			expect(result.toString(), 'a reachable FRET neighbour beats degraded self').to.equal(peerA.toString());
		});

		it('allowSelfCoordination: false still blocks BOTH a read and a write', async () => {
			// The one denial that is an explicit operator switch rather than an inference, so it
			// holds regardless of intent or connection state.
			for (const intent of ['read', 'write'] as const) {
				const { libp2p } = (() => {
					const fret = {
						getNeighbors: () => [selfPeerId.toString()],
						getNetworkSizeEstimate: () => ({ size_estimate: 1, confidence: 0.5 }),
						detectPartition: () => false,
						exportTable: () => undefined,
						assembleCohort: () => []
					};
					return {
						libp2p: {
							peerId: selfPeerId,
							getConnections: () => [],
							getMultiaddrs: () => [],
							addEventListener: () => {},
							removeEventListener: () => {},
							services: { fret }
						} as unknown as Libp2p
					};
				})();
				const network = new Libp2pKeyPeerNetwork(libp2p, 16, { allowSelfCoordination: false }, 'forming');
				let caught: unknown;
				try {
					await network.findCoordinator(KEY, { intent });
					expect.fail(`Expected findCoordinator to throw for intent=${intent} when self-coordination is disabled`);
				} catch (err) {
					caught = err;
				}
				expect(caught, `intent=${intent}`).to.be.instanceOf(FindCoordinatorError);
				expect((caught as FindCoordinatorError).code, `intent=${intent}`).to.equal(
					FIND_COORDINATOR_ERROR_CODES.SELF_COORDINATION_BLOCKED
				);
			}
		});
	});

	describe('networkMode defaults', () => {
		it('defaults to forming when not specified', () => {
			const libp2p = createMockLibp2p(selfPeerId);
			// clusterSize is stated (it has no default any more); this case is about networkMode.
			const network = new Libp2pKeyPeerNetwork(libp2p, 16);
			expect((network as any).networkMode).to.equal('forming');
		});

		it('accepts joining mode', () => {
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'joining');
			expect((network as any).networkMode).to.equal('joining');
		});
	});

	describe('connect()', () => {
		const PROTOCOL = '/test/1.0.0';
		const FAKE_STREAM = { id: 'fake-stream' } as unknown;

		function createLibp2pWithConnect(options: {
			connections?: Connection[];
			dialProtocol?: (peerId: PeerId, protocols: string[], opts?: any) => Promise<unknown>;
		}): Libp2p {
			return {
				peerId: selfPeerId,
				getConnections: (_peerId: PeerId) => options.connections ?? [],
				getMultiaddrs: () => [],
				addEventListener: () => {},
				removeEventListener: () => {},
				dialProtocol: options.dialProtocol ?? (() => Promise.reject(new Error('dialProtocol unexpectedly called'))),
				services: {}
			} as unknown as Libp2p;
		}

		it('passes runOnLimitedConnection: true on warm-connection reuse (limited-connection path)', async () => {
			let observedOpts: any = undefined;
			const mockConn = {
				status: 'open',
				newStream: (_protocols: string[], opts?: any) => {
					observedOpts = opts;
					// Mirror real libp2p: reject unless runOnLimitedConnection is true,
					// emulating a circuit-relay (limited) connection.
					if (!opts?.runOnLimitedConnection) {
						return Promise.reject(new Error('limited connection requires runOnLimitedConnection'));
					}
					return Promise.resolve(FAKE_STREAM);
				}
			} as unknown as Connection;

			const libp2p = createLibp2pWithConnect({ connections: [mockConn] });
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			const otherPeerId = await makePeerId();

			const stream = await network.connect(otherPeerId, PROTOCOL);
			expect(stream).to.equal(FAKE_STREAM);
			expect(observedOpts).to.not.be.undefined;
			expect(observedOpts.runOnLimitedConnection).to.equal(true);
			expect(observedOpts.negotiateFully).to.equal(false);
		});

		it('skips non-open connections and falls back to dialProtocol', async () => {
			const newStreamCalled = { called: false };
			const closingConn = {
				status: 'closing',
				newStream: () => {
					newStreamCalled.called = true;
					return Promise.reject(new Error('should not be called'));
				}
			} as unknown as Connection;

			let dialOpts: any = undefined;
			const libp2p = createLibp2pWithConnect({
				connections: [closingConn],
				dialProtocol: (_peerId, _protocols, opts) => {
					dialOpts = opts;
					return Promise.resolve(FAKE_STREAM);
				}
			});
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			const otherPeerId = await makePeerId();

			const stream = await network.connect(otherPeerId, PROTOCOL);
			expect(stream).to.equal(FAKE_STREAM);
			expect(newStreamCalled.called).to.be.false;
			expect(dialOpts).to.not.be.undefined;
			expect(dialOpts.runOnLimitedConnection).to.equal(true);
			expect(dialOpts.negotiateFully).to.equal(false);
		});

		it('falls back to dialProtocol when no connections exist', async () => {
			let dialOpts: any = undefined;
			const libp2p = createLibp2pWithConnect({
				connections: [],
				dialProtocol: (_peerId, _protocols, opts) => {
					dialOpts = opts;
					return Promise.resolve(FAKE_STREAM);
				}
			});
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			const otherPeerId = await makePeerId();

			const stream = await network.connect(otherPeerId, PROTOCOL);
			expect(stream).to.equal(FAKE_STREAM);
			expect(dialOpts).to.not.be.undefined;
			expect(dialOpts.runOnLimitedConnection).to.equal(true);
		});

		it('prefers a DIRECT connection over a limited (circuit-relay) one', async () => {
			const calls: string[] = [];
			// Listed first so a naive `find(open)` would pick the relayed connection.
			const limitedConn = {
				status: 'open',
				limits: { bytes: 128n * 1024n },
				remoteAddr: { toString: () => '/ip4/1.2.3.4/tcp/4001/p2p/QmRelay/p2p-circuit' },
				newStream: (_protocols: string[], _opts?: any) => {
					calls.push('limited');
					return Promise.resolve({ id: 'limited-stream' } as unknown);
				}
			} as unknown as Connection;
			const directConn = {
				status: 'open',
				remoteAddr: { toString: () => '/ip4/5.6.7.8/tcp/4002' },
				newStream: (_protocols: string[], _opts?: any) => {
					calls.push('direct');
					return Promise.resolve(FAKE_STREAM);
				}
			} as unknown as Connection;

			const libp2p = createLibp2pWithConnect({ connections: [limitedConn, directConn] });
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			const otherPeerId = await makePeerId();

			const stream = await network.connect(otherPeerId, PROTOCOL);
			expect(stream).to.equal(FAKE_STREAM);
			expect(calls).to.deep.equal(['direct']);
		});

		it('detects a limited connection by /p2p-circuit addr even without a `limits` field', async () => {
			const calls: string[] = [];
			const circuitConn = {
				status: 'open',
				remoteAddr: { toString: () => '/ip4/1.2.3.4/tcp/4001/p2p/QmRelay/p2p-circuit/p2p/QmTarget' },
				newStream: (_protocols: string[], _opts?: any) => {
					calls.push('circuit');
					return Promise.resolve({ id: 'circuit-stream' } as unknown);
				}
			} as unknown as Connection;
			const directConn = {
				status: 'open',
				remoteAddr: { toString: () => '/ip4/5.6.7.8/tcp/4002/p2p/QmTarget' },
				newStream: (_protocols: string[], _opts?: any) => {
					calls.push('direct');
					return Promise.resolve(FAKE_STREAM);
				}
			} as unknown as Connection;

			const libp2p = createLibp2pWithConnect({ connections: [circuitConn, directConn] });
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			const otherPeerId = await makePeerId();

			const stream = await network.connect(otherPeerId, PROTOCOL);
			expect(stream).to.equal(FAKE_STREAM);
			expect(calls).to.deep.equal(['direct']);
		});

		it('falls back to the limited connection when it is the only open path', async () => {
			let observedOpts: any = undefined;
			const limitedOnly = {
				status: 'open',
				limits: { bytes: 128n * 1024n },
				remoteAddr: { toString: () => '/ip4/1.2.3.4/tcp/4001/p2p/QmRelay/p2p-circuit' },
				newStream: (_protocols: string[], opts?: any) => {
					observedOpts = opts;
					return Promise.resolve(FAKE_STREAM);
				}
			} as unknown as Connection;

			const libp2p = createLibp2pWithConnect({ connections: [limitedOnly] });
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			const otherPeerId = await makePeerId();

			const stream = await network.connect(otherPeerId, PROTOCOL);
			expect(stream).to.equal(FAKE_STREAM);
			expect(observedOpts?.runOnLimitedConnection).to.equal(true);
		});

		it('forwards the caller AbortSignal on the reuse path', async () => {
			let observedSignal: AbortSignal | undefined;
			const mockConn = {
				status: 'open',
				newStream: (_protocols: string[], opts?: any) => {
					observedSignal = opts?.signal;
					return Promise.resolve(FAKE_STREAM);
				}
			} as unknown as Connection;

			const libp2p = createLibp2pWithConnect({ connections: [mockConn] });
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			const otherPeerId = await makePeerId();
			const controller = new AbortController();

			await network.connect(otherPeerId, PROTOCOL, { signal: controller.signal });
			expect(observedSignal).to.equal(controller.signal);
		});
	});

	describe('findCluster() — peerStore backfill', () => {
		it('backfills cohort multiaddrs from peerStore when not currently connected', async () => {
			const svcA = await makePeerId();
			const svcB = await makePeerId();
			const knownButDisconnected = await makePeerId();
			const disconnectedMa = multiaddr(`/ip4/10.0.0.7/tcp/4001/ws/p2p/${knownButDisconnected.toString()}`);

			const fret = {
				// FRET returns a member we have no live connection to but the
				// peerStore knows about — we should still include them with their
				// peerStore-resolved address.
				assembleCohort: () => [svcA.toString(), svcB.toString(), knownButDisconnected.toString()],
				getNetworkSizeEstimate: () => ({ size_estimate: 5, confidence: 0.5 }),
				detectPartition: () => false,
				exportTable: () => undefined,
				getNeighbors: () => []
			};

			const remoteConnA = {
				remotePeer: svcA,
				remoteAddr: { toString: () => `/ip4/10.0.0.1/tcp/4001/ws/p2p/${svcA.toString()}` }
			} as unknown as Connection;
			const remoteConnB = {
				remotePeer: svcB,
				remoteAddr: { toString: () => `/ip4/10.0.0.2/tcp/4001/ws/p2p/${svcB.toString()}` }
			} as unknown as Connection;

			const libp2p = {
				peerId: selfPeerId,
				getConnections: () => [remoteConnA, remoteConnB],
				getMultiaddrs: () => [multiaddr(`/ip4/10.0.0.99/tcp/4001/ws/p2p/${selfPeerId.toString()}`)],
				addEventListener: () => { },
				removeEventListener: () => { },
				peerStore: {
					all: async () => [],
					get: async (pid: { toString(): string }) => {
						if (pid.toString() === knownButDisconnected.toString()) {
							return { addresses: [{ multiaddr: disconnectedMa }] };
						}
						return { addresses: [] };
					}
				},
				services: { fret }
			} as unknown as Libp2p;

			const network = new Libp2pKeyPeerNetwork(libp2p, 4, undefined, 'joining');
			const key = new TextEncoder().encode('some-key');
			const cluster = await network.findCluster(key);
			expect(cluster[svcA.toString()]).to.exist;
			expect(cluster[svcB.toString()]).to.exist;
			expect(cluster[knownButDisconnected.toString()]).to.exist;
			expect(cluster[knownButDisconnected.toString()]!.multiaddrs).to.deep.equal([
				disconnectedMa.toString()
			]);
		});
	});

	// --- Cross-network coordinator/cohort scoping ---------------------------------
	// When two networks share physical nodes/bootstraps, a network-B peer can land in
	// network-A's peerStore but its network-namespaced identify never completes, so its
	// protocol list stays empty ('unknown') forever — whereas a same-network peer's list
	// contains `${prefix}/cluster|repo/1.0.0` ('serves'). Selection must keep only 'serves'
	// peers (self always 'serves') and never pick 'foreign' OR 'unknown'. Neither
	// `findCoordinator` nor `findCluster` gambles on an 'unknown' (possibly cross-network)
	// peer: a genuine same-network peer becomes selectable only once it flips to 'serves'
	// within the retry window; otherwise selection falls to self-coordination, and
	// `findCoordinator` surfaces NO_NETWORK_COORDINATOR when self is excluded (see tests).
	describe('network-membership scoping (protocolPrefix)', () => {
		const PREFIX = '/optimystic/netA';
		const servesProto = (prefix: string): string[] => [`${prefix}/cluster/1.0.0`, `${prefix}/repo/1.0.0`];

		function connTo(peerId: PeerId): Connection {
			return {
				remotePeer: peerId,
				status: 'open',
				remoteAddr: { toString: () => `/ip4/10.0.0.1/tcp/4001/p2p/${peerId.toString()}` }
			} as unknown as Connection;
		}

		function peerStoreOf(entries: Record<string, { protocols?: string[]; addresses?: string[] }>): any {
			return {
				all: async () => [],
				get: async (pid: { toString(): string }) => {
					const e = entries[pid.toString()];
					return {
						protocols: e?.protocols ?? [],
						addresses: (e?.addresses ?? []).map(a => ({ multiaddr: multiaddr(a) }))
					};
				}
			};
		}

		const baseFret = (extra: Record<string, unknown>): any => ({
			getNetworkSizeEstimate: () => ({ size_estimate: 5, confidence: 0.5 }),
			detectPartition: () => false,
			exportTable: () => undefined,
			getNeighbors: () => [],
			assembleCohort: () => [],
			...extra
		});

		it('findCoordinator never returns a cross-network peer when a same-network peer is available', async () => {
			const sameNet = await makePeerId();
			const crossNet = await makePeerId();
			// cross-network listed FIRST so a naive pick would choose it
			const fret = baseFret({ getNeighbors: () => [crossNet.toString(), sameNet.toString()] });
			const peerStore = peerStoreOf({
				[sameNet.toString()]: { protocols: servesProto(PREFIX) },
				[crossNet.toString()]: { protocols: [] } // identify never completed across networks
			});
			const libp2p = createMockLibp2p(selfPeerId, { connections: [connTo(crossNet), connTo(sameNet)], fret, peerStore });
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', undefined, undefined, PREFIX);
			const result = await network.findCoordinator(new TextEncoder().encode('block-near-crossnet'));
			expect(result.toString()).to.equal(sameNet.toString());
		});

		it('findCoordinator prefers self (serves) over a not-yet-identified cross-network peer', async () => {
			const crossNet = await makePeerId();
			const fret = baseFret({ getNeighbors: () => [crossNet.toString(), selfPeerId.toString()] });
			const peerStore = peerStoreOf({ [crossNet.toString()]: { protocols: [] } });
			const libp2p = createMockLibp2p(selfPeerId, { connections: [connTo(crossNet)], fret, peerStore });
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', undefined, undefined, PREFIX);
			const result = await network.findCoordinator(new TextEncoder().encode('block-near-crossnet'));
			expect(result.toString()).to.equal(selfPeerId.toString());
		});

		it('findCoordinator throws NO_NETWORK_COORDINATOR when the only candidate serves a different network and self is excluded', async () => {
			const foreign = await makePeerId();
			// HWM>1 so this is NOT the solo-bootstrap exhausted case
			const persistence = new MemoryPersistence({
				version: 1,
				networkHighWaterMark: 5,
				lastConnectedTimestamp: Date.now(),
				consecutiveIsolatedSessions: 0
			});
			const fret = baseFret({ getNeighbors: () => [foreign.toString()] });
			const peerStore = peerStoreOf({ [foreign.toString()]: { protocols: ['/optimystic/netB/cluster/1.0.0'] } });
			const libp2p = createMockLibp2p(selfPeerId, { connections: [connTo(foreign)], fret, peerStore });
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence, undefined, PREFIX);
			await network.initFromPersistedState();

			let caught: unknown;
			try {
				await network.findCoordinator(new TextEncoder().encode('block-near-foreign'), { excludedPeers: [selfPeerId] });
				expect.fail('Expected findCoordinator to throw NO_NETWORK_COORDINATOR');
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.instanceOf(FindCoordinatorError);
			expect((caught as FindCoordinatorError).code).to.equal(FIND_COORDINATOR_ERROR_CODES.NO_NETWORK_COORDINATOR);
		});

		it('findCoordinator falls back to self-coordination when self is not near the key and only a connected cross-network peer remains', async () => {
			// Self is NOT a FRET neighbor of the key (getNeighbors omits self), so it is not in
			// the FRET-path candidate set; the only connected peer is a permanently cross-network
			// 'unknown' (empty peerStore protocol list). Selection must NOT gamble on that peer —
			// it falls through to last-resort self-coordination (a correct single-coordinator
			// write under downsize), never returning the cross-network 'unknown'.
			const crossNet = await makePeerId();
			const fret = baseFret({ getNeighbors: () => [crossNet.toString()] });
			const peerStore = peerStoreOf({ [crossNet.toString()]: { protocols: [] } });
			const libp2p = createMockLibp2p(selfPeerId, { connections: [connTo(crossNet)], fret, peerStore });
			// 'forming' + default HWM<=1 → self-coordination allowed (bootstrap-node); self NOT excluded.
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', undefined, undefined, PREFIX);
			const result = await network.findCoordinator(new TextEncoder().encode('block-near-crossnet'));
			expect(result.toString(), 'self-coordinates rather than picking the cross-network peer').to.equal(selfPeerId.toString());
		});

		it('findCoordinator throws NO_NETWORK_COORDINATOR when the only candidate is a not-yet-confirmed cross-network peer and self is excluded', async () => {
			// Companion to the foreign-peer case above: a cross-network peer is 'unknown' (empty
			// protocol list), not 'foreign', yet selection must still fail fast with the accurate
			// NO_NETWORK_COORDINATOR code rather than a generic no-coordinator/super-majority error.
			const crossNet = await makePeerId();
			// HWM>1 so this is NOT the solo-bootstrap exhausted case
			const persistence = new MemoryPersistence({
				version: 1,
				networkHighWaterMark: 5,
				lastConnectedTimestamp: Date.now(),
				consecutiveIsolatedSessions: 0
			});
			const fret = baseFret({ getNeighbors: () => [crossNet.toString()] });
			const peerStore = peerStoreOf({ [crossNet.toString()]: { protocols: [] } }); // identify never completed across networks
			const libp2p = createMockLibp2p(selfPeerId, { connections: [connTo(crossNet)], fret, peerStore });
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence, undefined, PREFIX);
			await network.initFromPersistedState();

			let caught: unknown;
			try {
				await network.findCoordinator(new TextEncoder().encode('block-near-crossnet'), { excludedPeers: [selfPeerId] });
				expect.fail('Expected findCoordinator to throw NO_NETWORK_COORDINATOR');
			} catch (err) {
				caught = err;
			}
			expect(caught).to.be.instanceOf(FindCoordinatorError);
			expect((caught as FindCoordinatorError).code).to.equal(FIND_COORDINATOR_ERROR_CODES.NO_NETWORK_COORDINATOR);
		});

		it('findCoordinator selects a peer once it flips from unknown to serves within the retry window', async () => {
			// The load-bearing claim of this design: an 'unknown' peer is NOT gambled on, but it
			// is NOT permanently barred either — filterByMembership re-reads the peerStore on every
			// retry attempt, so a genuine same-network peer that completes `identify` mid-loop flips
			// to 'serves' and is selected on that attempt. Self is EXCLUDED here so the only way to
			// return a non-error result is to select the flipped peer (proving the flip path, not
			// self-coordination). The peerStore reports empty protocols on the first attempt's reads
			// and the serving protocols thereafter; each attempt issues 2 reads (FRET path + connected
			// fallback), so the >2 threshold lands the flip on attempt 1's first read.
			const flipPeer = await makePeerId();
			let getCount = 0;
			const fret = baseFret({ getNeighbors: () => [flipPeer.toString()] });
			const peerStore: any = {
				all: async () => [],
				get: async (pid: { toString(): string }) => {
					if (pid.toString() === flipPeer.toString()) {
						getCount++;
						return { protocols: getCount > 2 ? servesProto(PREFIX) : [], addresses: [] };
					}
					return { protocols: [], addresses: [] };
				}
			};
			// HWM>1 so this is not the solo-bootstrap path; self excluded so it can't mask the flip.
			const persistence = new MemoryPersistence({
				version: 1,
				networkHighWaterMark: 5,
				lastConnectedTimestamp: Date.now(),
				consecutiveIsolatedSessions: 0
			});
			const libp2p = createMockLibp2p(selfPeerId, { connections: [connTo(flipPeer)], fret, peerStore });
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence, undefined, PREFIX);
			await network.initFromPersistedState();
			const result = await network.findCoordinator(new TextEncoder().encode('block-flip'), { excludedPeers: [selfPeerId] });
			expect(result.toString(), 'selects the same-network peer once it flips to serves').to.equal(flipPeer.toString());
		});

		it('findCluster excludes a cross-network cohort member when a serving cohort already exists', async () => {
			const sameNet = await makePeerId();
			const crossNet = await makePeerId();
			const fret = baseFret({ assembleCohort: () => [sameNet.toString(), crossNet.toString()] });
			const peerStore = peerStoreOf({
				[sameNet.toString()]: { protocols: servesProto(PREFIX), addresses: [`/ip4/10.0.0.2/tcp/4001/p2p/${sameNet.toString()}`] },
				[crossNet.toString()]: { protocols: [], addresses: [`/ip4/10.0.0.3/tcp/4001/p2p/${crossNet.toString()}`] }
			});
			const libp2p = createMockLibp2p(selfPeerId, { fret, peerStore });
			// clusterSize 2 → self + nearest serving peer (sameNet) fills the cohort; crossNet ('unknown') is never admitted.
			const network = new Libp2pKeyPeerNetwork(libp2p, 2, undefined, 'joining', undefined, undefined, PREFIX);
			const cluster = await network.findCluster(new TextEncoder().encode('some-key'));
			expect(cluster[selfPeerId.toString()], 'self is always kept').to.exist;
			expect(cluster[sameNet.toString()], 'serving peer kept').to.exist;
			expect(cluster[crossNet.toString()], 'cross-network peer excluded').to.not.exist;
		});

		it('findCluster sizes the cohort to clusterSize (self counts toward it) when more serving peers are available', async () => {
			// Regression for the cohort off-by-one: self is ALWAYS added, so the cohort must
			// reserve a slot for it and keep only (clusterSize - 1) serving non-self peers —
			// otherwise a populated network produces clusterSize+1-member cohorts, which raises
			// the super-majority promise count (ceil((clusterSize+1)*threshold)) above what the
			// configured clusterSize intends and hurts write availability.
			const s1 = await makePeerId();
			const s2 = await makePeerId();
			const s3 = await makePeerId();
			// All three serve netA and sit nearer the key than clusterSize=2 would admit.
			const fret = baseFret({ assembleCohort: () => [s1.toString(), s2.toString(), s3.toString()] });
			const peerStore = peerStoreOf({
				[s1.toString()]: { protocols: servesProto(PREFIX), addresses: [`/ip4/10.0.0.11/tcp/4001/p2p/${s1.toString()}`] },
				[s2.toString()]: { protocols: servesProto(PREFIX), addresses: [`/ip4/10.0.0.12/tcp/4001/p2p/${s2.toString()}`] },
				[s3.toString()]: { protocols: servesProto(PREFIX), addresses: [`/ip4/10.0.0.13/tcp/4001/p2p/${s3.toString()}`] }
			});
			const libp2p = createMockLibp2p(selfPeerId, { fret, peerStore });
			const network = new Libp2pKeyPeerNetwork(libp2p, 2, undefined, 'joining', undefined, undefined, PREFIX);
			const cluster = await network.findCluster(new TextEncoder().encode('populated-key'));
			expect(Object.keys(cluster).length, 'cohort is exactly clusterSize (self + clusterSize-1 serving peers)').to.equal(2);
			expect(cluster[selfPeerId.toString()], 'self is always kept').to.exist;
			expect(cluster[s1.toString()], 'nearest serving peer kept').to.exist;
		});

		it('findCluster always drops a foreign cohort member (self-only cohort)', async () => {
			const foreign = await makePeerId();
			const fret = baseFret({ assembleCohort: () => [foreign.toString()] });
			const peerStore = peerStoreOf({
				[foreign.toString()]: { protocols: ['/optimystic/netB/cluster/1.0.0'], addresses: [`/ip4/10.0.0.9/tcp/4001/p2p/${foreign.toString()}`] }
			});
			const libp2p = createMockLibp2p(selfPeerId, { fret, peerStore });
			const network = new Libp2pKeyPeerNetwork(libp2p, 2, undefined, 'joining', undefined, undefined, PREFIX);
			const cluster = await network.findCluster(new TextEncoder().encode('k'));
			expect(Object.keys(cluster)).to.deep.equal([selfPeerId.toString()]);
		});

		it('findCluster does NOT backfill not-yet-identified members (self-only cohort)', async () => {
			// An 'unknown' peer (empty peerStore protocol list) is indistinguishable between a
			// permanently cross-network contaminant and a fresh same-network peer mid-identify.
			// findCluster therefore never admits one on a viability floor: the cohort is self-only.
			// A genuine fresh mesh is not starved — the write completes self-only under
			// allowClusterDownsize (the default) and the peer is re-included as 'serves' on the
			// caller's retry once identify completes.
			const freshA = await makePeerId();
			const freshB = await makePeerId();
			const fret = baseFret({ assembleCohort: () => [freshA.toString(), freshB.toString()] });
			const peerStore = peerStoreOf({
				[freshA.toString()]: { protocols: [], addresses: [`/ip4/10.0.0.4/tcp/4001/p2p/${freshA.toString()}`] },
				[freshB.toString()]: { protocols: [], addresses: [`/ip4/10.0.0.5/tcp/4001/p2p/${freshB.toString()}`] }
			});
			const libp2p = createMockLibp2p(selfPeerId, { fret, peerStore });
			// clusterSize 3, no serving peers → cohort is self-only; both 'unknown' members excluded.
			const network = new Libp2pKeyPeerNetwork(libp2p, 3, undefined, 'joining', undefined, undefined, PREFIX);
			const cluster = await network.findCluster(new TextEncoder().encode('k'));
			expect(Object.keys(cluster)).to.deep.equal([selfPeerId.toString()]);
			expect(cluster[freshA.toString()], 'not-yet-identified peer excluded').to.not.exist;
			expect(cluster[freshB.toString()], 'not-yet-identified peer excluded').to.not.exist;
		});

		it('findCluster keeps a self-only cohort when self is the sole serving peer and a cross-network peer sits nearer the key', async () => {
			// Core regression: the writer is the only serving member present, and a permanently
			// cross-network peer ('unknown', empty protocol list) sits nearer the key. The old
			// viability-floor backfill admitted that peer, and the coordinator's repo dial then
			// failed with `could not negotiate /optimystic/<other-network>/repo/1.0.0`, sinking
			// the whole write. The cohort must now be self-only — the cross-network peer is never
			// placed in it, so that negotiation is never even attempted.
			const crossNet = await makePeerId();
			const fret = baseFret({ assembleCohort: () => [crossNet.toString()] });
			const peerStore = peerStoreOf({
				[crossNet.toString()]: { protocols: [], addresses: [`/ip4/10.0.0.7/tcp/4001/p2p/${crossNet.toString()}`] }
			});
			const libp2p = createMockLibp2p(selfPeerId, { fret, peerStore });
			const network = new Libp2pKeyPeerNetwork(libp2p, 2, undefined, 'joining', undefined, undefined, PREFIX);
			const cluster = await network.findCluster(new TextEncoder().encode('k'));
			expect(Object.keys(cluster)).to.deep.equal([selfPeerId.toString()]);
			expect(cluster[crossNet.toString()], 'cross-network peer excluded').to.not.exist;
		});

		it('findCluster with clusterSize 1 yields a self-only cohort even when serving peers are nearer the key', async () => {
			// nonSelfTarget = max(0, clusterSize - 1) = 0, so no non-self member is admitted —
			// not even a positively-serving one. The cohort is exactly self.
			const sameNet = await makePeerId();
			const fret = baseFret({ assembleCohort: () => [sameNet.toString()] });
			const peerStore = peerStoreOf({
				[sameNet.toString()]: { protocols: servesProto(PREFIX), addresses: [`/ip4/10.0.0.8/tcp/4001/p2p/${sameNet.toString()}`] }
			});
			const libp2p = createMockLibp2p(selfPeerId, { fret, peerStore });
			const network = new Libp2pKeyPeerNetwork(libp2p, 1, undefined, 'joining', undefined, undefined, PREFIX);
			const cluster = await network.findCluster(new TextEncoder().encode('k'));
			expect(Object.keys(cluster)).to.deep.equal([selfPeerId.toString()]);
			expect(cluster[sameNet.toString()], 'no slot for non-self members at clusterSize 1').to.not.exist;
		});

		it('with protocolPrefix ABSENT, findCluster retains a cross-network member (filter disabled — regression guard)', async () => {
			const crossNet = await makePeerId();
			const fret = baseFret({ assembleCohort: () => [crossNet.toString()] });
			const peerStore = peerStoreOf({
				[crossNet.toString()]: { protocols: [], addresses: [`/ip4/10.0.0.6/tcp/4001/p2p/${crossNet.toString()}`] }
			});
			const libp2p = createMockLibp2p(selfPeerId, { fret, peerStore });
			// No protocolPrefix → membership filter is a no-op → member retained as before.
			const network = new Libp2pKeyPeerNetwork(libp2p, 2, undefined, 'joining');
			const cluster = await network.findCluster(new TextEncoder().encode('k'));
			expect(cluster[crossNet.toString()]).to.exist;
		});

		it('with protocolPrefix ABSENT, findCoordinator still returns a connected FRET neighbor (filter disabled — regression guard)', async () => {
			const peerA = await makePeerId();
			const fret = baseFret({ getNeighbors: () => [peerA.toString()] });
			const peerStore = peerStoreOf({ [peerA.toString()]: { protocols: [] } });
			const libp2p = createMockLibp2p(selfPeerId, { connections: [connTo(peerA)], fret, peerStore });
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			const result = await network.findCoordinator(new TextEncoder().encode('k'));
			expect(result.toString()).to.equal(peerA.toString());
		});
	});
});
