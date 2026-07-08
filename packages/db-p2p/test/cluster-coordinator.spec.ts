import { expect } from 'chai';
import { ClusterCoordinator, type TimerCancel } from '../src/repo/cluster-coordinator.js';
import type { ITransactionStateStore, PersistedCoordinatorState, PersistedParticipantState } from '../src/cluster/i-transaction-state-store.js';
import type { ClusterRecord, ClusterPeers, IKeyNetwork, RepoMessage, ClusterConsensusConfig, BlockId, Signature } from '@optimystic/db-core';
import type { PeerId } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { toString as u8ToString } from 'uint8arrays';

const makePeerId = async (): Promise<PeerId> => {
	const pk = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(pk);
};

/**
 * A deterministic clock + timer queue for the coordinator's scheduled commit retries. `now` advances
 * only via {@link advance}; due timers fire in ascending `fireAt` order and a cancel handle removes a
 * not-yet-fired timer. Mirrors the reactivity `FakeScheduler`
 * (test/reactivity/rotation-rereg-scheduler.spec.ts) so the two timer seams are tested the same way.
 *
 * Unlike the reactivity scheduler, the coordinator's retry callback (`retryCommits`) is **async**: a
 * fired timer only *starts* the retry, and the next retry is armed after the retry's promises settle.
 * So the migration pairs every {@link advance} with an `await flush()` — advancing fires the due timer
 * synchronously, then `flush()` drains the microtasks the async retry runs on (state mutation + arming
 * the next backoff timer). Without the flush the assertions read pre-retry state (a vacuous pass).
 */
class FakeScheduler {
	now = 0;
	private nextId = 1;
	private readonly timers = new Map<number, { fireAt: number; fn: () => void }>();

	readonly setTimer = (fn: () => void, delayMs: number): TimerCancel => {
		const id = this.nextId++;
		this.timers.set(id, { fireAt: this.now + delayMs, fn });
		return (): void => {
			this.timers.delete(id);
		};
	};

	readonly clock = (): number => this.now;

	get pending(): number {
		return this.timers.size;
	}

	/** Advance the clock by `ms`, firing every timer due at or before the new time (ascending `fireAt`). */
	advance(ms: number): void {
		const target = this.now + ms;
		for (;;) {
			let nextId: number | undefined;
			let next: { fireAt: number; fn: () => void } | undefined;
			for (const [id, t] of this.timers) {
				if (t.fireAt <= target && (next === undefined || t.fireAt < next.fireAt)) {
					nextId = id;
					next = t;
				}
			}
			if (nextId === undefined || next === undefined) {
				break;
			}
			this.timers.delete(nextId);
			this.now = next.fireAt;
			next.fn();
		}
		this.now = target;
	}
}

/**
 * Drain the microtask queue (plus one macrotask boundary) so an async `retryCommits` — which awaits
 * `Promise.all(peer updates)` — fully settles before the assertion. The mock `update` resolves on the
 * microtask queue, so one `setImmediate` boundary is sufficient to run the retry's continuation
 * (commit merge + arming the next backoff timer).
 */
const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/** The 8th `ClusterCoordinator` constructor argument: the injected clock/timer seam. */
const clockOpts = (clock: FakeScheduler): { now: () => number; setTimer: FakeScheduler['setTimer'] } => ({
	now: clock.clock,
	setTimer: clock.setTimer
});

/**
 * Mock cluster client for testing ClusterCoordinator retry behavior.
 * Determines phase by checking whether our promise is already in the record:
 * - Not present → promise phase (add our promise)
 * - Present → commit phase (add our commit, or fail if configured)
 */
class MockClusterClient {
	updateCalls = 0;
	commitPhaseCalls = 0;
	failCommit = false;
	/** Throw on the Nth commit-phase call (1-indexed). null = never fail this way. */
	failOnCommitCall: number | null = null;
	peerIdStr: string;

	constructor(peerIdStr: string) {
		this.peerIdStr = peerIdStr;
	}

	async update(record: ClusterRecord): Promise<ClusterRecord> {
		this.updateCalls++;

		// Promise phase: our promise is not yet in the record
		if (!(this.peerIdStr in record.promises)) {
			return {
				...record,
				promises: {
					...record.promises,
					[this.peerIdStr]: { type: 'approve', signature: `psig-${this.peerIdStr.substring(0, 8)}` } as Signature
				}
			};
		}

		// Commit phase (initial commit, post-majority broadcast, or scheduled retry)
		this.commitPhaseCalls++;
		const failByCounter = this.failOnCommitCall !== null && this.commitPhaseCalls === this.failOnCommitCall;
		if (this.failCommit || failByCounter) {
			throw new Error(`Peer ${this.peerIdStr.substring(0, 8)} unreachable`);
		}

		return {
			...record,
			commits: {
				...record.commits,
				[this.peerIdStr]: { type: 'approve', signature: `csig-${this.peerIdStr.substring(0, 8)}` } as Signature
			}
		};
	}
}

describe('ClusterCoordinator retry logic (TEST-5.2.1)', function () {
	// Retry scenarios below run entirely on a fake clock (FakeScheduler) — the coordinator's scheduled
	// commit-retry timers are driven by clock.advance(), so no real wall-clock time elapses and the
	// default mocha timeout is ample. (Previously this block waited on real timers totaling ~4.5s/case.)

	let peerIds: PeerId[];
	let mockClusters: Map<string, MockClusterClient>;
	let coordinator: ClusterCoordinator;
	let clock: FakeScheduler;

	const cfg: ClusterConsensusConfig & { clusterSize: number } = {
		clusterSize: 3,
		superMajorityThreshold: 0.75,
		simpleMajorityThreshold: 0.51,
		minAbsoluteClusterSize: 2,
		allowClusterDownsize: true,
		clusterSizeTolerance: 0.5,
		partitionDetectionWindow: 60000
	};

	// Expiration is stamped against the SAME fake clock the coordinator reads, so it is not instantly
	// expired against a fake `now` that starts at 0.
	const makeMessage = (): RepoMessage => ({
		operations: [{ get: { blockIds: ['block-1'] } }],
		expiration: clock.now + 30000
	});

	beforeEach(async () => {
		clock = new FakeScheduler();
		peerIds = await Promise.all([makePeerId(), makePeerId(), makePeerId()]);

		const clusterPeers: ClusterPeers = {};
		mockClusters = new Map();
		for (const pid of peerIds) {
			const idStr = pid.toString();
			clusterPeers[idStr] = {
				multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
				publicKey: u8ToString(pid.publicKey!.raw, 'base64url')
			};
			mockClusters.set(idStr, new MockClusterClient(idStr));
		}

		const mockKeyNetwork: IKeyNetwork = {
			async findCoordinator() { return peerIds[0]!; },
			async findCluster() { return { ...clusterPeers }; }
		};

		const createClient = (peerId: PeerId) => {
			const mock = mockClusters.get(peerId.toString());
			if (!mock) throw new Error(`No mock for ${peerId.toString()}`);
			return mock;
		};

		coordinator = new ClusterCoordinator(
			mockKeyNetwork,
			createClient as any,
			cfg,
			undefined, // localCluster
			undefined, // fretService
			undefined, // reputation
			undefined, // stateStore
			clockOpts(clock)
		);
	});

	it('completes without retry when all peers commit', async () => {
		const result = await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());

		// All 3 commits present
		expect(Object.keys(result.record.commits)).to.have.length(3);

		// Each mock called exactly three times (promise + commit + consensus broadcast)
		for (const [_, mock] of mockClusters) {
			expect(mock.updateCalls).to.equal(3);
		}

		// No retry scheduled — advancing the fake clock fires only the deferred cleanup timer, never
		// another update.
		clock.advance(300);
		await flush();
		for (const [_, mock] of mockClusters) {
			expect(mock.updateCalls).to.equal(3);
		}
	});

	it('returns success with simple-majority commits despite one failure', async () => {
		const failingId = peerIds[2]!.toString();
		mockClusters.get(failingId)!.failCommit = true;

		const result = await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());

		// 2/3 commits = simple majority (floor(3*0.51)+1 = 2)
		expect(Object.keys(result.record.commits)).to.have.length(2);
		expect(result.record.commits[failingId]).to.equal(undefined);
	});

	it('retries failed commit peer in the background', async () => {
		const failingId = peerIds[2]!.toString();
		const failingMock = mockClusters.get(failingId)!;
		failingMock.failCommit = true;

		await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());

		// Initially: 1 promise call + 1 failed commit + 2 broadcast attempts
		// (initial + 1 immediate in-line retry, both fail) = 4
		expect(failingMock.updateCalls).to.equal(4);

		// The first scheduled retry fires at EXACTLY the 250ms initial interval — one tick short and
		// nothing fires; at the interval, exactly one retry attempt runs.
		clock.advance(249);
		await flush();
		expect(failingMock.updateCalls, 'no retry one tick before the initial interval').to.equal(4);

		clock.advance(1);
		await flush();
		expect(failingMock.updateCalls, 'exactly one scheduled retry attempt fired at 250ms').to.equal(5);
	});

	it('retry succeeds when peer recovers', async () => {
		const failingId = peerIds[2]!.toString();
		const failingMock = mockClusters.get(failingId)!;
		failingMock.failCommit = true;

		await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());
		expect(failingMock.updateCalls).to.equal(4);

		// Fix the peer before the retry fires
		failingMock.failCommit = false;

		// First scheduled retry (250ms) fires and succeeds → pending peer clears → no further retries.
		clock.advance(250);
		await flush();
		expect(failingMock.updateCalls, 'the single scheduled retry ran and succeeded').to.equal(5);

		// Advance well past several backoff intervals to confirm no further retries after success.
		const callsAfterRecovery = failingMock.updateCalls;
		clock.advance(5000);
		await flush();
		expect(failingMock.updateCalls, 'no further retries after the peer recovered').to.equal(callsAfterRecovery);
	});

	it('continues retrying with exponential backoff on persistent failure', async () => {
		const failingId = peerIds[2]!.toString();
		const failingMock = mockClusters.get(failingId)!;
		failingMock.failCommit = true;

		const result = await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());
		expect(failingMock.updateCalls).to.equal(4);

		const hash = result.record.messageHash;
		const retryState = (): { attempt: number; intervalMs: number } | undefined =>
			(coordinator as any).transactions.get(hash)?.retry;

		// Attempt 1 is armed at the 250ms initial interval.
		expect(retryState()?.intervalMs, 'attempt 1 interval').to.equal(250);

		// Fire attempt 1 → it fails again and arms attempt 2 at 250 * 2 = 500ms (backoff factor 2).
		clock.advance(250);
		await flush();
		expect(failingMock.updateCalls, 'attempt 1 ran').to.equal(5);
		expect(retryState()?.intervalMs, 'attempt 2 interval doubles to 500').to.equal(500);

		// Virtual time is exact: one tick short of 500 fires nothing; at 500 attempt 2 runs and arms
		// attempt 3 at 500 * 2 = 1000ms.
		clock.advance(499);
		await flush();
		expect(failingMock.updateCalls, 'no fire one tick short of the 500ms backoff').to.equal(5);

		clock.advance(1);
		await flush();
		expect(failingMock.updateCalls, 'attempt 2 ran at exactly 500ms').to.equal(6);
		expect(retryState()?.intervalMs, 'attempt 3 interval doubles to 1000').to.equal(1000);

		// Fire attempt 3 → arms attempt 4 at 1000 * 2 = 2000ms.
		clock.advance(1000);
		await flush();
		expect(failingMock.updateCalls, 'attempt 3 ran at exactly 1000ms').to.equal(7);
		expect(retryState()?.intervalMs, 'attempt 4 interval doubles to 2000').to.equal(2000);
	});
});

describe('ClusterCoordinator broadcast in-line retry', function () {
	let peerIds: PeerId[];
	let mockClusters: Map<string, MockClusterClient>;

	const baseCfg: ClusterConsensusConfig & { clusterSize: number } = {
		clusterSize: 3,
		superMajorityThreshold: 0.75,
		simpleMajorityThreshold: 0.51,
		minAbsoluteClusterSize: 2,
		allowClusterDownsize: true,
		clusterSizeTolerance: 0.5,
		partitionDetectionWindow: 60000
	};

	const makeMessage = (clock: FakeScheduler): RepoMessage => ({
		operations: [{ get: { blockIds: ['block-1'] } }],
		expiration: clock.now + 30000
	});

	const setupCluster = async (cfg: ClusterConsensusConfig & { clusterSize: number }, clock: FakeScheduler) => {
		peerIds = await Promise.all([makePeerId(), makePeerId(), makePeerId()]);
		const clusterPeers: ClusterPeers = {};
		mockClusters = new Map();
		for (const pid of peerIds) {
			const idStr = pid.toString();
			clusterPeers[idStr] = {
				multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
				publicKey: u8ToString(pid.publicKey!.raw, 'base64url')
			};
			mockClusters.set(idStr, new MockClusterClient(idStr));
		}
		const mockKeyNetwork: IKeyNetwork = {
			async findCoordinator() { return peerIds[0]!; },
			async findCluster() { return { ...clusterPeers }; }
		};
		const createClient = (peerId: PeerId) => {
			const mock = mockClusters.get(peerId.toString());
			if (!mock) throw new Error(`No mock for ${peerId.toString()}`);
			return mock;
		};
		return new ClusterCoordinator(
			mockKeyNetwork,
			createClient as any,
			cfg,
			undefined, // localCluster
			undefined, // fretService
			undefined, // reputation
			undefined, // stateStore
			clockOpts(clock)
		);
	};

	it('recovers when first broadcast attempt fails but in-line retry succeeds', async () => {
		const clock = new FakeScheduler();
		const coordinator = await setupCluster(baseCfg, clock);
		const failingId = peerIds[2]!.toString();
		const failingMock = mockClusters.get(failingId)!;
		// commit phase = call 1 (succeeds), broadcast attempt 1 = call 2 (fails),
		// broadcast in-line retry = call 3 (succeeds)
		failingMock.failOnCommitCall = 2;

		const result = await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage(clock));

		expect(Object.keys(result.record.commits)).to.have.length(3);
		expect(failingMock.commitPhaseCalls).to.equal(3);
		// Inspect internal state: no scheduled retry timer was created for that peer
		const txState = (coordinator as any).transactions.get(result.record.messageHash);
		expect(txState?.retry, 'expected no scheduled retry after successful in-line retry').to.equal(undefined);

		// Advance past the default 250ms initial timer; no extra calls should fire (only cleanup runs).
		const callsAfterBroadcast = failingMock.updateCalls;
		clock.advance(400);
		await flush();
		expect(failingMock.updateCalls).to.equal(callsAfterBroadcast);
	});

	it('schedules a 250ms retry when both broadcast attempts fail', async () => {
		const clock = new FakeScheduler();
		const coordinator = await setupCluster(baseCfg, clock);
		const failingId = peerIds[2]!.toString();
		const failingMock = mockClusters.get(failingId)!;
		failingMock.failCommit = true;

		const result = await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage(clock));

		// 1 promise + 1 commit-fail + 2 broadcast attempts (both fail) = 4
		expect(failingMock.updateCalls).to.equal(4);

		const txState = (coordinator as any).transactions.get(result.record.messageHash);
		expect(txState?.retry, 'expected a scheduled retry').to.not.equal(undefined);
		expect(txState.retry.intervalMs).to.equal(250);
		expect(Array.from(txState.retry.pendingPeers)).to.deep.equal([failingId]);
	});

	it('honors custom commitBroadcastImmediateRetries and commitBroadcastRetryInitialMs', async () => {
		const clock = new FakeScheduler();
		const customCfg = {
			...baseCfg,
			commitBroadcastRetryInitialMs: 100,
			commitBroadcastImmediateRetries: 2
		};
		const coordinator = await setupCluster(customCfg, clock);
		const failingId = peerIds[2]!.toString();
		const failingMock = mockClusters.get(failingId)!;
		failingMock.failCommit = true;

		const result = await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage(clock));

		// 1 promise + 1 commit-fail + 3 broadcast attempts (initial + 2 immediate retries) = 5
		expect(failingMock.updateCalls).to.equal(5);

		const txState = (coordinator as any).transactions.get(result.record.messageHash);
		expect(txState?.retry?.intervalMs).to.equal(100);
	});
});

describe('ClusterCoordinator undersized-cluster gate (validateSmallCluster)', function () {
	const baseCfg: ClusterConsensusConfig & { clusterSize: number } = {
		clusterSize: 1,
		superMajorityThreshold: 0.75,
		simpleMajorityThreshold: 0.51,
		minAbsoluteClusterSize: 2,
		allowClusterDownsize: true,
		clusterSizeTolerance: 0.5,
		partitionDetectionWindow: 60000
	};

	const makeMessage = (clock: FakeScheduler): RepoMessage => ({
		operations: [{ get: { blockIds: ['block-1'] } }],
		expiration: clock.now + 30000
	});

	// Single-peer cluster (peerCount 1 < minAbsoluteClusterSize 2) with NO FRET service,
	// so validateSmallCluster always falls through to the no-confident-estimate branch.
	const setupSinglePeer = async (cfg: ClusterConsensusConfig & { clusterSize: number }, clock: FakeScheduler) => {
		const pid = await makePeerId();
		const idStr = pid.toString();
		const clusterPeers: ClusterPeers = {
			[idStr]: {
				multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
				publicKey: u8ToString(pid.publicKey!.raw, 'base64url')
			}
		};
		const mock = new MockClusterClient(idStr);
		const mockKeyNetwork: IKeyNetwork = {
			async findCoordinator() { return pid; },
			async findCluster() { return { ...clusterPeers }; }
		};
		const createClient = (_peerId: PeerId) => mock;
		const coordinator = new ClusterCoordinator(
			mockKeyNetwork,
			createClient as any,
			cfg,
			undefined, // localCluster
			undefined, // fretService
			undefined, // reputation
			undefined, // stateStore
			clockOpts(clock)
		);
		return { coordinator, mock };
	};

	it('rejects an undersized cluster with no confident estimate when the flag is off (default)', async () => {
		const clock = new FakeScheduler();
		const { coordinator } = await setupSinglePeer(baseCfg, clock);
		let err: Error | undefined;
		try {
			await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage(clock));
		} catch (e) {
			err = e as Error;
		}
		expect(err, 'expected undersized cluster to be rejected when fail-closed').to.not.equal(undefined);
		expect(err!.message).to.contain('below minimum 2 and not validated');
	});

	it('admits an undersized cluster when allowUnvalidatedSmallCluster is on', async () => {
		const clock = new FakeScheduler();
		const { coordinator } = await setupSinglePeer({ ...baseCfg, allowUnvalidatedSmallCluster: true }, clock);
		const result = await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage(clock));
		expect(Object.keys(result.record.commits)).to.have.length(1);
	});
});

/**
 * A minimal in-memory {@link ITransactionStateStore} — only the coordinator-state map is exercised by
 * `recoverTransactions`; participant/executed methods are inert stubs to satisfy the interface.
 */
class InMemoryStateStore implements ITransactionStateStore {
	readonly coordinator = new Map<string, PersistedCoordinatorState>();
	async saveCoordinatorState(messageHash: string, state: PersistedCoordinatorState): Promise<void> { this.coordinator.set(messageHash, state); }
	async getCoordinatorState(messageHash: string): Promise<PersistedCoordinatorState | undefined> { return this.coordinator.get(messageHash); }
	async deleteCoordinatorState(messageHash: string): Promise<void> { this.coordinator.delete(messageHash); }
	async getAllCoordinatorStates(): Promise<PersistedCoordinatorState[]> { return Array.from(this.coordinator.values()); }
	async saveParticipantState(_h: string, _s: PersistedParticipantState): Promise<void> { }
	async getParticipantState(_h: string): Promise<PersistedParticipantState | undefined> { return undefined; }
	async deleteParticipantState(_h: string): Promise<void> { }
	async getAllParticipantStates(): Promise<PersistedParticipantState[]> { return []; }
	async markExecuted(_h: string, _t: number): Promise<void> { }
	async wasExecuted(_h: string): Promise<boolean> { return false; }
	async pruneExecuted(_o: number): Promise<void> { }
}

/**
 * Recovery reads the clock ONCE — the expiration cutoff `record.message.expiration < now()`. This exercises
 * the fourth `this.now()` swap (the only one the retry-path specs above never touch): the seam is proven by
 * choosing an expiration that is LIVE against the fake clock (now = 0) but would read as EXPIRED against a
 * real wall clock (~1.7e12 ms). If recovery used `Date.now()` instead of the injected clock, the live state
 * would be wrongly deleted; asserting it is recovered proves the fake clock drives the decision.
 */
describe('ClusterCoordinator recovery clock seam', function () {
	const cfg: ClusterConsensusConfig & { clusterSize: number } = {
		clusterSize: 3,
		superMajorityThreshold: 0.75,
		simpleMajorityThreshold: 0.51,
		minAbsoluteClusterSize: 2,
		allowClusterDownsize: true,
		clusterSizeTolerance: 0.5,
		partitionDetectionWindow: 60000
	};

	const makeRecord = (messageHash: string, expiration: number): ClusterRecord => ({
		messageHash,
		peers: {},
		message: { operations: [{ get: { blockIds: ['block-1'] } }], expiration },
		promises: {},
		commits: {}
	});

	it('uses the injected clock for the expiration cutoff and re-arms recovered retries on the injected timer', async () => {
		const clock = new FakeScheduler(); // now = 0

		const store = new InMemoryStateStore();
		// Live against the fake clock (0 < 50_000) but EXPIRED against a real wall clock — isolates this.now().
		store.coordinator.set('live-hash', {
			messageHash: 'live-hash',
			record: makeRecord('live-hash', 50_000),
			lastUpdate: 0,
			phase: 'broadcasting',
			retryState: { pendingPeers: ['peer-x'], attempt: 1, intervalMs: 250 }
		});
		// Expired against the fake clock (-1 < 0) — the delete branch.
		store.coordinator.set('expired-hash', {
			messageHash: 'expired-hash',
			record: makeRecord('expired-hash', -1),
			lastUpdate: 0,
			phase: 'broadcasting',
			retryState: { pendingPeers: ['peer-y'], attempt: 1, intervalMs: 250 }
		});

		const mockKeyNetwork: IKeyNetwork = {
			async findCoordinator() { return await makePeerId(); },
			async findCluster() { return {}; }
		};
		// Recovery only schedules a timer; the retry callback (which would dial) is never fired in this test.
		const createClient = (_peerId: PeerId) => { throw new Error('retry timer must not fire in this test'); };

		const coordinator = new ClusterCoordinator(
			mockKeyNetwork,
			createClient as any,
			cfg,
			undefined, // localCluster
			undefined, // fretService
			undefined, // reputation
			store,
			clockOpts(clock)
		);

		await coordinator.recoverTransactions();

		const transactions: Map<string, unknown> = (coordinator as any).transactions;
		expect(transactions.has('live-hash'), 'live state recovered (fake clock, not Date.now)').to.equal(true);
		expect(transactions.has('expired-hash'), 'expired state not recovered').to.equal(false);
		expect(await store.getCoordinatorState('expired-hash'), 'expired state deleted from the store').to.equal(undefined);
		expect(clock.pending, 'the recovered broadcast re-armed its retry on the injected timer seam').to.be.greaterThan(0);
	});
});
