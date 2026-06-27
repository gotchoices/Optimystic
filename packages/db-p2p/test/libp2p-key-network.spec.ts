import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { multiaddr } from '@multiformats/multiaddr';
import type { PeerId, Libp2p, Connection } from '@libp2p/interface';
import type { SerializedTable } from 'p2p-fret';
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

/** Minimal mock Libp2p that satisfies Libp2pKeyPeerNetwork's usage */
function createMockLibp2p(peerId: PeerId, options?: {
	connections?: Connection[];
	fret?: any;
	peerStore?: any;
}): Libp2p {
	const listeners: Map<string, Set<Function>> = new Map();
	return {
		peerId,
		getConnections: () => options?.connections ?? [],
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

	describe('canRetryImprove()', () => {
		it('returns false for forming + HWM<=1 + self-only FRET', () => {
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			// Access private method via cast
			const result = (network as any).canRetryImprove([selfPeerId.toString()]);
			expect(result).to.be.false;
		});

		it('returns false for forming + HWM<=1 + empty FRET', () => {
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			const result = (network as any).canRetryImprove([]);
			expect(result).to.be.false;
		});

		it('returns true for joining mode regardless of other conditions', () => {
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'joining');
			const result = (network as any).canRetryImprove([selfPeerId.toString()]);
			expect(result).to.be.true;
		});

		it('returns true for forming + HWM>1 (persisted history)', async () => {
			const persistence = new MemoryPersistence({
				version: 1,
				networkHighWaterMark: 10,
				lastConnectedTimestamp: Date.now() - 60000,
				consecutiveIsolatedSessions: 0
			});
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming', persistence);
			await network.initFromPersistedState();
			const result = (network as any).canRetryImprove([selfPeerId.toString()]);
			expect(result).to.be.true;
		});

		it('returns true when FRET has other peers', () => {
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p, 16, undefined, 'forming');
			const result = (network as any).canRetryImprove([selfPeerId.toString(), 'other-peer-id']);
			expect(result).to.be.true;
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

			// Wait a tick for the fire-and-forget save
			await new Promise(resolve => setTimeout(resolve, 10));

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
			await new Promise(resolve => setTimeout(resolve, 10));

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

	describe('networkMode defaults', () => {
		it('defaults to forming when not specified', () => {
			const libp2p = createMockLibp2p(selfPeerId);
			const network = new Libp2pKeyPeerNetwork(libp2p);
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
	// contains `${prefix}/cluster|repo/1.0.0` ('serves'). Selection must prefer 'serves',
	// never pick 'foreign', and only fall back to 'unknown' when nothing serving exists.
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

		it('findCluster excludes a cross-network cohort member when a serving cohort already exists', async () => {
			const sameNet = await makePeerId();
			const crossNet = await makePeerId();
			const fret = baseFret({ assembleCohort: () => [sameNet.toString(), crossNet.toString()] });
			const peerStore = peerStoreOf({
				[sameNet.toString()]: { protocols: servesProto(PREFIX), addresses: [`/ip4/10.0.0.2/tcp/4001/p2p/${sameNet.toString()}`] },
				[crossNet.toString()]: { protocols: [], addresses: [`/ip4/10.0.0.3/tcp/4001/p2p/${crossNet.toString()}`] }
			});
			const libp2p = createMockLibp2p(selfPeerId, { fret, peerStore });
			// clusterSize 2 → floor min(2,2)=2; self+sameNet(serves)=2, so crossNet(unknown) is excluded.
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

		it('findCluster always drops a foreign cohort member, even below the viability floor', async () => {
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

		it('findCluster backfills not-yet-identified members when no serving peer exists (fresh mesh not starved)', async () => {
			const freshA = await makePeerId();
			const freshB = await makePeerId();
			const fret = baseFret({ assembleCohort: () => [freshA.toString(), freshB.toString()] });
			const peerStore = peerStoreOf({
				[freshA.toString()]: { protocols: [], addresses: [`/ip4/10.0.0.4/tcp/4001/p2p/${freshA.toString()}`] },
				[freshB.toString()]: { protocols: [], addresses: [`/ip4/10.0.0.5/tcp/4001/p2p/${freshB.toString()}`] }
			});
			const libp2p = createMockLibp2p(selfPeerId, { fret, peerStore });
			// clusterSize 3 → floor min(2,3)=2; self+serves(0)=1 < 2, so both 'unknown' members are kept.
			const network = new Libp2pKeyPeerNetwork(libp2p, 3, undefined, 'joining', undefined, undefined, PREFIX);
			const cluster = await network.findCluster(new TextEncoder().encode('k'));
			expect(cluster[selfPeerId.toString()]).to.exist;
			expect(cluster[freshA.toString()]).to.exist;
			expect(cluster[freshB.toString()]).to.exist;
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
