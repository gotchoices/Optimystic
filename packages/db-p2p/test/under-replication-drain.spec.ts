/**
 * Ticket: under-replication-drain-and-full-replication-event.
 *
 * The drain is the sending half of the under-replication ledger: `CoordinatorRepo.commit` records
 * which cohort members still miss a block it acknowledged below full replication, and this service
 * pushes those copies as the members become reachable, clearing the entry as each confirms and
 * firing ONE full-replication event when the last one does. These specs pin the drain's own rules
 * over a real ledger (in memory), a fake key network, a fake libp2p and a push double; the wire
 * itself is `pushBlockToPeers`, pinned in `block-transfer.spec.ts`, and the whole thing over real
 * sockets is phase 5 and phase 7 of `small-deployment-lifecycle.integration.spec.ts`.
 */

import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import type { BlockDurabilityReachedEvent, BlockId, ClusterPeers, RoutingKey } from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import {
	UnderReplicationDrain, type BoundBlockPusher, type DrainLibp2p, type UnderReplicationDrainConfig, type UnderReplicationDrainDeps
} from '../src/repo/under-replication-drain.js';
import type { UnderReplicatedEntry } from '../src/repo/i-under-replication-ledger.js';
import { KvUnderReplicationLedger } from '../src/repo/kv-under-replication-ledger.js';
import { MemoryKVStore } from '../src/storage/memory-kv-store.js';
import { StorageRepo } from '../src/storage/storage-repo.js';
import { BlockStorage } from '../src/storage/block-storage.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { buildBlockTransferProtocol, type PushBlockOutcome } from '../src/cluster/block-transfer-service.js';
import { captureLog, hasLine, hasTag } from './support/capture-log.js';

const PREFIX = '/optimystic/drain-test';
const BLOCK_A = 'drain-block-a' as BlockId;
const BLOCK_B = 'drain-block-b' as BlockId;
const BLOCK_C = 'drain-block-c' as BlockId;
const COLLECTION = 'drain-collection' as BlockId;

const makePeerId = async (): Promise<PeerId> => peerIdFromPrivateKey(await generateKeyPair('Ed25519'));

type EventHandler = (event: unknown) => void;

/** The slice of libp2p the drain reads: identity, the two events, who is connected, who is identified. */
class MockLibp2p {
	peerId!: PeerId;
	private readonly listeners = new Map<string, EventHandler[]>();
	private readonly connected = new Map<string, PeerId>();
	private readonly identified = new Set<string>();
	readonly peerStore = {
		get: async (peerId: PeerId): Promise<{ protocols: string[] }> => {
			if (!this.identified.has(peerId.toString())) throw new Error('not found');
			return { protocols: [buildBlockTransferProtocol(PREFIX)] };
		}
	};

	addEventListener(event: string, handler: EventHandler): void {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
	}
	removeEventListener(event: string, handler: EventHandler): void {
		this.listeners.set(event, (this.listeners.get(event) ?? []).filter(h => h !== handler));
	}
	listenerCount(event: string): number {
		return (this.listeners.get(event) ?? []).length;
	}
	getConnections(peerId?: PeerId): Array<{ remotePeer: PeerId }> {
		const all = [...this.connected.values()].map(remotePeer => ({ remotePeer }));
		return peerId === undefined ? all : all.filter(c => c.remotePeer.equals(peerId));
	}

	/** A peer arrives: connected, identified (unless told otherwise), and `connection:open` fires. */
	connect(peerId: PeerId, options: { identified?: boolean; emit?: boolean } = {}): void {
		this.connected.set(peerId.toString(), peerId);
		if (options.identified ?? true) this.identified.add(peerId.toString());
		if (options.emit ?? true) this.emit('connection:open', { remotePeer: peerId });
	}
	disconnect(peerId: PeerId): void {
		this.connected.delete(peerId.toString());
		this.identified.delete(peerId.toString());
	}
	emit(event: string, detail?: unknown): void {
		for (const handler of this.listeners.get(event) ?? []) handler({ detail });
	}
}

/** `findCluster` by block id: the routing key is the id's utf8, so the fake decodes it back. */
class FakeKeyNetwork {
	private readonly cohorts = new Map<string, string[]>();
	calls: string[] = [];
	throwing = false;
	setCohort(blockId: BlockId, peerIds: string[]): void {
		this.cohorts.set(blockId, peerIds);
	}
	async findCluster(key: RoutingKey): Promise<ClusterPeers> {
		const blockId = new TextDecoder().decode(key);
		this.calls.push(blockId);
		if (this.throwing) throw new Error('fret unavailable');
		const cohort = this.cohorts.get(blockId) ?? [];
		return Object.fromEntries(cohort.map(id => [id, { multiaddrs: [], publicKey: '' }]));
	}
}

type Answer = 'confirm' | 'reject' | 'unreachable';

/** The push double: what each peer answers, per block, plus every call made. */
class PushDouble {
	readonly calls: Array<{ blockId: BlockId; peerIds: string[] }> = [];
	private readonly answers = new Map<string, Answer>();
	/** Blocks the double reports as gone from local storage. */
	readonly missingLocally = new Set<BlockId>();
	certified = true;
	latestRev: number | undefined;
	/** Runs before an answer is produced — a hook to interleave a ledger write mid-push. */
	beforeAnswer: (() => Promise<void>) | undefined;

	answer(peerId: string, answer: Answer, blockId?: BlockId): void {
		this.answers.set(blockId === undefined ? peerId : `${blockId}|${peerId}`, answer);
	}
	private answerFor(blockId: BlockId, peerId: string): Answer {
		return this.answers.get(`${blockId}|${peerId}`) ?? this.answers.get(peerId) ?? 'confirm';
	}
	readonly push: BoundBlockPusher = async (blockId, peerIds) => {
		this.calls.push({ blockId, peerIds: [...peerIds] });
		if (this.beforeAnswer) await this.beforeAnswer();
		if (this.missingLocally.has(blockId)) return { status: 'no-local-data' };
		const outcome: PushBlockOutcome = {
			status: 'pushed', certified: this.certified, collectionId: COLLECTION, confirmed: [], refusals: [], skipped: [],
			...(this.latestRev === undefined ? {} : { latest: { rev: this.latestRev, actionId: 'latest' } })
		};
		for (const peerId of peerIds) {
			const answer = this.answerFor(blockId, peerId);
			if (answer === 'confirm') outcome.confirmed.push(peerId);
			else if (answer === 'reject') outcome.refusals.push({ peerId, reason: 'rejected' });
			else outcome.refusals.push({ peerId, reason: 'unreachable', error: 'dial timeout' });
		}
		return outcome;
	};
	callsFor(blockId: BlockId): Array<{ blockId: BlockId; peerIds: string[] }> {
		return this.calls.filter(call => call.blockId === blockId);
	}
}

const entryFor = (blockId: BlockId, overrides: Partial<UnderReplicatedEntry> = {}): UnderReplicatedEntry => ({
	blockId,
	rev: 5,
	actionId: `action-${blockId}`,
	quorum: 'majority',
	missingPeerIds: [],
	recordedAt: 1_000,
	attempts: 0,
	...overrides
});

describe('UnderReplicationDrain', () => {
	let self: PeerId;
	let peerX: PeerId;
	let peerY: PeerId;
	let libp2p: MockLibp2p;
	let keyNetwork: FakeKeyNetwork;
	let ledger: KvUnderReplicationLedger;
	let pusher: PushDouble;
	let events: BlockDurabilityReachedEvent[];
	let deps: UnderReplicationDrainDeps;
	const drains: UnderReplicationDrain[] = [];

	/** A running drain whose start pass found nothing to do: every scenario below seeds the ledger and
	 *  connects its peers AFTER this, so `checkNow` is the first pass that sees them and its counts
	 *  are the scenario's. (The start pass with nobody connected skips before it scans.) */
	const startDrain = async (config: Partial<UnderReplicationDrainConfig> = {}): Promise<UnderReplicationDrain> => {
		const drain = new UnderReplicationDrain(deps, { debounceMs: 60_000, minIntervalMs: 0, recheckIntervalMs: 0, ...config });
		drains.push(drain);
		await drain.start();
		return drain;
	};

	beforeEach(async () => {
		[self, peerX, peerY] = await Promise.all([makePeerId(), makePeerId(), makePeerId()]);
		libp2p = new MockLibp2p();
		libp2p.peerId = self;
		keyNetwork = new FakeKeyNetwork();
		ledger = new KvUnderReplicationLedger(new MemoryKVStore());
		pusher = new PushDouble();
		events = [];
		deps = {
			libp2p: libp2p as unknown as DrainLibp2p,
			ledger,
			keyNetwork,
			partitionDetector: { detectPartition: () => false },
			pushBlock: pusher.push,
			emit: (event) => { events.push(event); },
			protocolPrefix: PREFIX
		};
	});

	afterEach(async () => {
		await Promise.all(drains.splice(0).map(drain => drain.stop()));
	});

	describe('a named missing peer', () => {
		it('pushes once to a connected peer, deletes the entry when it confirms, and fires one event naming the block', async () => {
			const drain = await startDrain();
			await ledger.record(entryFor(BLOCK_A, { missingPeerIds: [peerX.toString()] }));
			libp2p.connect(peerX, { emit: false });

			const pass = await drain.checkNow();

			expect(pusher.calls, 'one push, to the one owed peer').to.deep.equal([{ blockId: BLOCK_A, peerIds: [peerX.toString()] }]);
			expect(pass).to.include({ examined: 1, pushed: 1, cleared: 1 });
			expect(await ledger.get(BLOCK_A), 'the entry is gone').to.equal(undefined);
			expect(events).to.deep.equal([{ blockIds: [BLOCK_A], rev: 5, actionId: `action-${BLOCK_A}`, collectionId: COLLECTION }]);
		});

		it('pushes nothing and leaves the entry untouched while the peer is not connected', async () => {
			const drain = await startDrain();
			const entry = entryFor(BLOCK_A, { missingPeerIds: [peerX.toString()] });
			await ledger.record(entry);
			libp2p.connect(peerY, { emit: false }); // somebody is connected, just not the owed peer

			const pass = await drain.checkNow();

			expect(pusher.calls).to.deep.equal([]);
			expect(pass).to.include({ examined: 1, waiting: 1, pushed: 0 });
			expect(await ledger.get(BLOCK_A)).to.deep.equal(entry);
			expect(events).to.deep.equal([]);
		});

		it('does not push to a peer that is connected but not yet identified as serving this network', async () => {
			const drain = await startDrain();
			await ledger.record(entryFor(BLOCK_A, { missingPeerIds: [peerX.toString()] }));
			libp2p.connect(peerX, { identified: false, emit: false });

			const pass = await drain.checkNow();

			expect(pusher.calls).to.deep.equal([]);
			expect(pass.skipped, 'nobody pushable: the pass does not even scan').to.equal('no-pushable-peer');
		});

		it('never re-resolves the cohort for a named peer', async () => {
			const drain = await startDrain();
			await ledger.record(entryFor(BLOCK_A, { missingPeerIds: [peerX.toString()] }));
			keyNetwork.setCohort(BLOCK_A, [self.toString(), peerY.toString()]); // the cohort moved on
			libp2p.connect(peerX, { emit: false });
			libp2p.connect(peerY, { emit: false });

			await drain.checkNow();

			expect(keyNetwork.calls, 'findCluster was not consulted').to.deep.equal([]);
			expect(pusher.calls).to.deep.equal([{ blockId: BLOCK_A, peerIds: [peerX.toString()] }]);
		});
	});

	describe('an entry that could not name its missing members', () => {
		it('leaves an entry alone, counting no attempt, while the cohort resolves to this node alone', async () => {
			const drain = await startDrain();
			const entry = entryFor(BLOCK_A, { quorum: 'local' });
			await ledger.record(entry);
			keyNetwork.setCohort(BLOCK_A, [self.toString()]);
			libp2p.connect(peerY, { emit: false }); // a connected peer that is not in the cohort

			const pass = await drain.checkNow();

			expect(pusher.calls).to.deep.equal([]);
			expect(pass).to.include({ examined: 1, solo: 1, pushed: 0 });
			expect(await ledger.get(BLOCK_A), 'untouched, attempts still 0').to.deep.equal(entry);
			expect(events).to.deep.equal([]);
		});

		it('re-resolves the cohort, pushes to both members, and clears the entry only once both confirm', async () => {
			const drain = await startDrain();
			await ledger.record(entryFor(BLOCK_A, { quorum: 'local' }));
			keyNetwork.setCohort(BLOCK_A, [self.toString(), peerX.toString(), peerY.toString()]);
			libp2p.connect(peerX, { emit: false });
			libp2p.connect(peerY, { emit: false });
			pusher.answer(peerY.toString(), 'unreachable');

			const first = await drain.checkNow();

			expect(pusher.calls[0]!.peerIds, 'both members pushed to').to.have.members([peerX.toString(), peerY.toString()]);
			expect(first).to.include({ pushed: 1, cleared: 0 });
			const remaining = await ledger.get(BLOCK_A);
			expect(remaining?.missingPeerIds, 'the entry now names the one member still missing').to.deep.equal([peerY.toString()]);
			expect(remaining?.quorum, 'the class it was acknowledged at is kept').to.equal('local');
			expect(remaining?.attempts, 'an unconfirmed reachable peer counts a round').to.equal(1);
			expect(events).to.deep.equal([]);

			pusher.answer(peerY.toString(), 'confirm');
			const second = await drain.checkNow();

			expect(pusher.calls[1], 'only the still-missing member is pushed to').to.deep.equal({ blockId: BLOCK_A, peerIds: [peerY.toString()] });
			expect(second).to.include({ pushed: 1, cleared: 1 });
			expect(await ledger.get(BLOCK_A)).to.equal(undefined);
			expect(events.map(e => e.blockIds)).to.deep.equal([[BLOCK_A]]);
		});

		it('leaves the entry unnamed when nobody confirmed, so the next pass resolves the cohort afresh', async () => {
			const drain = await startDrain();
			await ledger.record(entryFor(BLOCK_A, { quorum: 'unrouted' }));
			keyNetwork.setCohort(BLOCK_A, [self.toString(), peerX.toString()]);
			libp2p.connect(peerX, { emit: false });
			pusher.answer(peerX.toString(), 'unreachable');

			await drain.checkNow();

			const entry = await ledger.get(BLOCK_A);
			expect(entry?.missingPeerIds).to.deep.equal([]);
			expect(entry?.attempts).to.equal(1);
		});

		it('waits, counting nothing, when the cohort cannot be resolved', async () => {
			const drain = await startDrain();
			const entry = entryFor(BLOCK_A, { quorum: 'local' });
			await ledger.record(entry);
			keyNetwork.throwing = true;
			libp2p.connect(peerX, { emit: false });

			const pass = await drain.checkNow();

			expect(pass).to.include({ waiting: 1, pushed: 0 });
			expect(await ledger.get(BLOCK_A)).to.deep.equal(entry);
		});
	});

	describe('giving up on a peer', () => {
		it('abandons a peer after maxAttempts consecutive unconfirmed rounds, and reconnecting retries it from scratch', async () => {
			const drain = await startDrain({ maxAttempts: 2 });
			await ledger.record(entryFor(BLOCK_A, { missingPeerIds: [peerX.toString()] }));
			libp2p.connect(peerX, { emit: false });
			pusher.answer(peerX.toString(), 'reject');

			await drain.checkNow();
			const second = await drain.checkNow();
			expect(second.abandoned, 'the second failed round abandons the peer').to.equal(1);
			expect(drain.getDiagnostics().abandonedPairs).to.equal(1);

			const third = await drain.checkNow();
			expect(pusher.callsFor(BLOCK_A).length, 'no push to an abandoned peer').to.equal(2);
			expect(third).to.include({ waiting: 1, pushed: 0 });
			const entry = await ledger.get(BLOCK_A);
			expect(entry, 'the entry stays in the ledger, visible').to.not.equal(undefined);
			expect(entry?.attempts).to.equal(2);

			// The peer leaves and comes back: a fresh connection clears its abandonment.
			libp2p.disconnect(peerX);
			libp2p.connect(peerX);
			expect(drain.getDiagnostics().abandonedPairs).to.equal(0);
			pusher.answer(peerX.toString(), 'confirm');
			const fourth = await drain.checkNow();
			expect(fourth).to.include({ pushed: 1, cleared: 1 });
			expect(pusher.callsFor(BLOCK_A).length).to.equal(3);
		});

		it('counts an unreachable peer and a rejecting peer alike, and logs them apart', async () => {
			const drain = await startDrain();
			await ledger.record(entryFor(BLOCK_A, { missingPeerIds: [peerX.toString(), peerY.toString()] }));
			libp2p.connect(peerX, { emit: false });
			libp2p.connect(peerY, { emit: false });
			pusher.answer(peerX.toString(), 'unreachable');
			pusher.answer(peerY.toString(), 'reject');
			pusher.certified = false;

			const captured = await captureLog('under-replication-drain', async () => { await drain.checkNow(); });

			expect(hasTag(captured, 'push:unreachable'), 'cannot reach').to.equal(true);
			expect(hasTag(captured, 'push:rejected'), 'cannot place').to.equal(true);
			expect(hasLine(captured, 'no retained proof'), 'an uncertified rejection says why').to.equal(true);
			expect((await ledger.get(BLOCK_A))?.attempts, 'one round counted, not one per peer').to.equal(1);
		});

		it('a round where every reachable peer confirmed counts no attempt', async () => {
			const drain = await startDrain();
			await ledger.record(entryFor(BLOCK_A, { missingPeerIds: [peerX.toString(), peerY.toString()] }));
			libp2p.connect(peerX, { emit: false }); // peerY stays away

			await drain.checkNow();

			const entry = await ledger.get(BLOCK_A);
			expect(entry?.missingPeerIds).to.deep.equal([peerY.toString()]);
			expect(entry?.attempts).to.equal(0);
		});
	});

	describe('a block this node no longer holds', () => {
		it('deletes the entry and pushes nothing', async () => {
			const drain = await startDrain();
			await ledger.record(entryFor(BLOCK_A, { missingPeerIds: [peerX.toString()] }));
			libp2p.connect(peerX, { emit: false });
			pusher.missingLocally.add(BLOCK_A);

			const pass = await drain.checkNow();

			expect(pass).to.include({ dropped: 1, cleared: 0 });
			expect(await ledger.get(BLOCK_A)).to.equal(undefined);
			expect(events, 'gone is not fully replicated').to.deep.equal([]);
		});
	});

	describe('the full-replication event', () => {
		it('reaches every listener even when one throws, and the drain carries on', async () => {
			const drain = await startDrain();
			const storageRepo = new StorageRepo((blockId) => new BlockStorage(blockId, new MemoryRawStorage(), async () => undefined));
			deps.emit = (event) => storageRepo.emitBlockDurabilityReached(event);
			const seen: BlockDurabilityReachedEvent[] = [];
			storageRepo.onBlockDurabilityReached(() => { throw new Error('listener bug'); });
			const off = storageRepo.onBlockDurabilityReached((event) => { seen.push(event); });
			await ledger.record(entryFor(BLOCK_A, { missingPeerIds: [peerX.toString()] }));
			await ledger.record(entryFor(BLOCK_B, { missingPeerIds: [peerX.toString()], recordedAt: 2_000 }));
			libp2p.connect(peerX, { emit: false });

			const pass = await drain.checkNow();

			expect(pass).to.include({ cleared: 2 });
			expect(seen.map(e => e.blockIds[0])).to.deep.equal([BLOCK_A, BLOCK_B]);
			off();
			off(); // idempotent
			await ledger.record(entryFor(BLOCK_C, { missingPeerIds: [peerX.toString()] }));
			await drain.checkNow();
			expect(seen.length, 'an unsubscribed listener hears nothing more').to.equal(2);
		});

		it('fires after the ledger entry is gone', async () => {
			const drain = await startDrain();
			let entryAtEmit: UnderReplicatedEntry | undefined | 'unread' = 'unread';
			deps.emit = () => { void ledger.get(BLOCK_A).then(entry => { entryAtEmit = entry; }); };
			await ledger.record(entryFor(BLOCK_A, { missingPeerIds: [peerX.toString()] }));
			libp2p.connect(peerX, { emit: false });

			await drain.checkNow();
			await waitFor(() => entryAtEmit !== 'unread', { timeoutMs: 1_000, intervalMs: 5, description: 'listener read the ledger' });

			expect(entryAtEmit).to.equal(undefined);
		});
	});

	describe('a newer shortfall recorded while the push was in flight', () => {
		it('is left alone: the older copy does not satisfy it, and no event fires', async () => {
			const drain = await startDrain();
			await ledger.record(entryFor(BLOCK_A, { rev: 5, missingPeerIds: [peerX.toString()] }));
			libp2p.connect(peerX, { emit: false });
			pusher.beforeAnswer = async () => {
				await ledger.record(entryFor(BLOCK_A, { rev: 6, actionId: 'action-6', missingPeerIds: [peerX.toString()] }));
			};
			pusher.latestRev = 5;

			const pass = await drain.checkNow();

			expect(pass).to.include({ pushed: 1, cleared: 0 });
			expect((await ledger.get(BLOCK_A))?.rev).to.equal(6);
			expect(events).to.deep.equal([]);
		});

		it('a copy of a NEWER revision than the entry records satisfies it', async () => {
			const drain = await startDrain();
			await ledger.record(entryFor(BLOCK_A, { rev: 5, missingPeerIds: [peerX.toString()] }));
			libp2p.connect(peerX, { emit: false });
			pusher.latestRev = 7; // this node's latest moved on (a member apply); the push carried rev 7

			const pass = await drain.checkNow();

			expect(pass).to.include({ cleared: 1 });
			expect(events[0]).to.include({ rev: 5 });
		});
	});

	describe('bounds', () => {
		it('examines at most blockBudget entries per pass and rotates so every entry gets a turn', async () => {
			const drain = await startDrain({ blockBudget: 2 });
			for (const [i, blockId] of [BLOCK_A, BLOCK_B, BLOCK_C].entries()) {
				await ledger.record(entryFor(blockId, { missingPeerIds: [peerX.toString()], recordedAt: 1_000 + i }));
			}
			libp2p.connect(peerX, { emit: false });
			pusher.answer(peerX.toString(), 'unreachable');

			const first = await drain.checkNow();
			expect(first).to.include({ entries: 3, examined: 2, deferred: 1 });
			expect(pusher.calls.map(c => c.blockId)).to.deep.equal([BLOCK_A, BLOCK_B]);

			const second = await drain.checkNow();
			expect(second).to.include({ examined: 2, deferred: 1 });
			expect(pusher.calls.slice(2).map(c => c.blockId), 'the deferred entry goes first next time').to.deep.equal([BLOCK_C, BLOCK_A]);
		});

		it('skips a pass during a detected partition', async () => {
			const drain = await startDrain();
			await ledger.record(entryFor(BLOCK_A, { missingPeerIds: [peerX.toString()] }));
			libp2p.connect(peerX, { emit: false });
			deps.partitionDetector = { detectPartition: () => true };

			const pass = await drain.checkNow();

			expect(pass.skipped).to.equal('partition');
			expect(pusher.calls).to.deep.equal([]);
		});
	});

	describe('what wakes it', () => {
		it('drains what the ledger carried across a restart on start', async () => {
			await ledger.record(entryFor(BLOCK_A, { missingPeerIds: [peerX.toString()] }));
			libp2p.connect(peerX, { emit: false });

			await startDrain();

			await waitFor(async () => (await ledger.get(BLOCK_A)) === undefined,
				{ timeoutMs: 2_000, intervalMs: 10, description: 'the start pass drained the entry' });
			expect(events.length).to.equal(1);
		});

		it('runs a debounced pass when a peer connects, and when one is identified', async () => {
			const drain = await startDrain({ debounceMs: 20 });
			await ledger.record(entryFor(BLOCK_A, { missingPeerIds: [peerX.toString()] }));

			libp2p.connect(peerX); // emits connection:open
			await waitFor(async () => (await ledger.get(BLOCK_A)) === undefined,
				{ timeoutMs: 2_000, intervalMs: 10, description: 'the connection-triggered pass drained the entry' });

			await ledger.record(entryFor(BLOCK_B, { missingPeerIds: [peerX.toString()] }));
			libp2p.emit('peer:identify', { peerId: peerX });
			await waitFor(async () => (await ledger.get(BLOCK_B)) === undefined,
				{ timeoutMs: 2_000, intervalMs: 10, description: 'the identify-triggered pass drained the entry' });
			expect(drain.getDiagnostics().timerArmed, 'nothing outstanding, no re-check armed').to.equal(false);
		});

		it('defers a trigger inside the minimum interval instead of dropping it', async () => {
			const drain = await startDrain({ debounceMs: 5, minIntervalMs: 150 });
			libp2p.connect(peerX, { emit: false });
			await drain.checkNow(); // stamps lastPassAt
			await ledger.record(entryFor(BLOCK_A, { missingPeerIds: [peerX.toString()] }));

			libp2p.emit('connection:open', { remotePeer: peerX });
			await new Promise(resolve => setTimeout(resolve, 60));
			expect(await ledger.get(BLOCK_A), 'throttled: not yet').to.not.equal(undefined);
			expect(drain.getDiagnostics().timerArmed, 'but deferred, not dropped').to.equal(true);

			await waitFor(async () => (await ledger.get(BLOCK_A)) === undefined,
				{ timeoutMs: 2_000, intervalMs: 10, description: 'the deferred pass ran at the end of the interval' });
		});

		it('re-checks on its own while an entry is outstanding, and stops once none is', async () => {
			const drain = await startDrain({ recheckIntervalMs: 30 });
			await ledger.record(entryFor(BLOCK_A, { missingPeerIds: [peerX.toString()] }));
			libp2p.connect(peerX, { emit: false });
			pusher.answer(peerX.toString(), 'unreachable');

			await drain.checkNow();
			expect(drain.getDiagnostics().timerArmed).to.equal(true);
			await waitFor(() => pusher.calls.length >= 3, { timeoutMs: 2_000, intervalMs: 10, description: 'the timer re-checked' });

			pusher.answer(peerX.toString(), 'confirm');
			await waitFor(async () => (await ledger.get(BLOCK_A)) === undefined, { timeoutMs: 2_000, intervalMs: 10, description: 'drained' });
			await waitFor(() => !drain.getDiagnostics().timerArmed, { timeoutMs: 2_000, intervalMs: 10, description: 'timer lapsed' });
		});

		it('registers and removes its listeners on start and stop', async () => {
			const drain = new UnderReplicationDrain(deps, { debounceMs: 60_000 });
			await drain.start();
			expect(libp2p.listenerCount('connection:open')).to.equal(1);
			expect(libp2p.listenerCount('peer:identify')).to.equal(1);
			await drain.stop();
			await drain.stop(); // idempotent
			expect(libp2p.listenerCount('connection:open')).to.equal(0);
			expect(libp2p.listenerCount('peer:identify')).to.equal(0);
		});
	});
});
