import { expect } from 'aegir/chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { PeerId, Libp2p, Connection } from '@libp2p/interface';
import type { SerializedTable } from 'p2p-fret';
import {
	Libp2pKeyPeerNetwork,
	type NetworkMode,
	type NetworkStatePersistence,
	type PersistedNetworkState,
	type SelfCoordinationConfig,
	type SelfCoordinationDecision
} from '../src/libp2p-key-network.js';

const makePeerId = async (): Promise<PeerId> => {
	const key = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(key);
};

/** Minimal mock Libp2p that satisfies Libp2pKeyPeerNetwork's usage */
function createMockLibp2p(peerId: PeerId, options?: {
	connections?: Connection[];
	fret?: any;
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
});
