import { expect } from 'chai';
import { BlocksHeldError, ClusterCoordinator, ConflictRaceLostError, ValidatorRejectionError } from '../src/repo/cluster-coordinator.js';
import type { ClusterRecord, ClusterPeers, IKeyNetwork, RepoMessage, ClusterConsensusConfig, BlockId, Signature } from '@optimystic/db-core';
import type { PeerId } from '@libp2p/interface';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { toString as u8ToString } from 'uint8arrays';
import { waitFor } from '@optimystic/db-core/test';
import { captureLog, hasTag } from './support/capture-log.js';

/**
 * Locks the super-majority threshold rounding behaviour so the next regression
 * is obvious. `executeTransaction` computes `Math.ceil(peerCount * threshold)`
 * — with a 3-peer cluster and the default 0.75 that rounds to 3, which leaves
 * zero slack and demands unanimity. The web-e2e fixture drops to 0.51 so
 * `ceil(3 * 0.51) = 2` and one missing promise no longer sinks consensus.
 *
 * The mock client either approves or rejects when asked to add its promise;
 * once present, the commit phase always succeeds so the test isolates the
 * promise-phase threshold check.
 */

const makePeerId = async (): Promise<PeerId> => {
	const pk = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(pk);
};

/**
 * `approve`  — promise phase adds the peer's approve signature.
 * `silent`   — promise phase returns the record unchanged (no signature).
 *               Mirrors the real bug: a peer whose `getTransactionPhase`
 *               lands in `Promising` (not `OurPromiseNeeded`) so it never
 *               adds its own signature even though the call returns
 *               successfully. This is the failure mode the threshold knob
 *               protects against — counting `rejection` would short-circuit
 *               on a different code path (`rejected by validators`).
 */
type Verdict = 'approve' | 'silent';

class MockClusterClient {
	constructor(
		private readonly peerIdStr: string,
		public verdict: Verdict
	) { }

	async update(record: ClusterRecord): Promise<ClusterRecord> {
		if (!(this.peerIdStr in record.promises)) {
			if (this.verdict === 'silent') {
				return record;
			}
			return {
				...record,
				promises: {
					...record.promises,
					[this.peerIdStr]: { type: 'approve', signature: `psig-${this.peerIdStr.substring(0, 8)}` } as Signature
				}
			};
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

const baseCfg: Omit<ClusterConsensusConfig & { clusterSize: number }, 'superMajorityThreshold'> = {
	clusterSize: 3,
	simpleMajorityThreshold: 0.51,
	minAbsoluteClusterSize: 2,
	allowClusterDownsize: true,
	clusterSizeTolerance: 0.5,
	partitionDetectionWindow: 60000
};

const makeMessage = (): RepoMessage => ({
	operations: [{ get: { blockIds: ['block-1'] } }],
	expiration: Date.now() + 30000
});

interface ScenarioOutcome {
	kind: 'commit' | 'supermajority-failed';
}

interface Scenario {
	threshold: number;
	approvals: number;
	expected: ScenarioOutcome;
}

const scenarios: Scenario[] = [
	{ threshold: 0.67, approvals: 3, expected: { kind: 'commit' } },
	{ threshold: 0.67, approvals: 2, expected: { kind: 'supermajority-failed' } },
	{ threshold: 0.51, approvals: 2, expected: { kind: 'commit' } }
];

describe('ClusterCoordinator super-majority threshold math (web-e2e-tier2-cluster-supermajority)', function () {
	this.timeout(10000);

	let peerIds: PeerId[];
	let clusterPeers: ClusterPeers;

	beforeEach(async () => {
		peerIds = await Promise.all([makePeerId(), makePeerId(), makePeerId()]);
		clusterPeers = {};
		for (const pid of peerIds) {
			const idStr = pid.toString();
			clusterPeers[idStr] = {
				multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
				publicKey: u8ToString(pid.publicKey!.raw, 'base64url')
			};
		}
	});

	for (const scenario of scenarios) {
		const label = `threshold=${scenario.threshold} approvals=${scenario.approvals}/3 → ${scenario.expected.kind}`;
		it(label, async () => {
			const verdicts: Verdict[] = peerIds.map((_, idx) =>
				idx < scenario.approvals ? 'approve' : 'silent'
			);
			const mocks = new Map<string, MockClusterClient>();
			peerIds.forEach((pid, idx) => {
				mocks.set(pid.toString(), new MockClusterClient(pid.toString(), verdicts[idx]!));
			});

			const mockKeyNetwork: IKeyNetwork = {
				async findCoordinator() { return peerIds[0]!; },
				async findCluster() { return { ...clusterPeers }; }
			};

			const createClient = (peerId: PeerId) => {
				const mock = mocks.get(peerId.toString());
				if (!mock) throw new Error(`No mock for ${peerId.toString()}`);
				return mock;
			};

			const coordinator = new ClusterCoordinator(
				mockKeyNetwork,
				createClient as any,
				{ ...baseCfg, superMajorityThreshold: scenario.threshold }
			);

			if (scenario.expected.kind === 'commit') {
				const result = await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());
				const approvals = Object.values(result.record.promises).filter(s => s.type === 'approve').length;
				expect(approvals).to.equal(scenario.approvals);
				expect(Object.keys(result.record.commits).length).to.be.greaterThan(0);
			} else {
				let caught: Error | null = null;
				try {
					await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());
				} catch (err) {
					caught = err as Error;
				}
				expect(caught, 'expected supermajority-failed rejection').to.be.instanceOf(Error);
				expect(caught!.message).to.match(/super-majority/i);
			}
		});
	}
});

/**
 * A member that voted keeps the transaction in its own reservation table until something
 * advances it — so a coordinator that abandons a transaction and merely throws leaves every
 * member holding the touched blocks for the full staleness window, and each blocked retry
 * plants a fresh reservation. At the `rejected-by-validators` site the coordinator holds a
 * merged record carrying enough signed rejections to *prove* the transaction is dead, so it
 * broadcasts that record: every member recomputes `Rejected` and clears immediately.
 *
 * (The `supermajority-failed` site carries no such proof and is deliberately not broadcast —
 * see the NOTE at that site in cluster-coordinator.ts.)
 */
class RecordingClusterClient {
	readonly received: ClusterRecord[] = [];

	constructor(
		private readonly peerIdStr: string,
		private readonly verdict: 'approve' | 'reject'
	) { }

	async update(record: ClusterRecord): Promise<ClusterRecord> {
		// Snapshot: collectPromises merges into the *same* record object it handed out, so keeping
		// the reference would make a first-delivery entry retroactively appear to carry the votes.
		this.received.push({ ...record, promises: { ...record.promises }, commits: { ...record.commits } });
		if (!(this.peerIdStr in record.promises)) {
			const sig: Signature = this.verdict === 'approve'
				? { type: 'approve', signature: `psig-${this.peerIdStr.substring(0, 8)}` }
				: { type: 'reject', signature: `psig-${this.peerIdStr.substring(0, 8)}`, rejectReason: 'validation failed' };
			return { ...record, promises: { ...record.promises, [this.peerIdStr]: sig } };
		}
		return record;
	}
}

/** What one mock member answers a promise request with. */
type Answer = 'approve' | 'reject' | 'conflict' | 'held' | 'silent';

/** The rival action id every `held` mock names, mirroring storage's pending list. */
const HELD_BY_MOCK = 'a-rival-mock';

/**
 * Behaviour split for a promise-phase shortfall (2-member-must-answer-a-lost-conflict-race, then
 * a-contended-pend-refusal-is-permanent-on-a-small-cohort):
 *
 * - `conflict` votes present → `ConflictRaceLostError` (a retryable optimistic-concurrency loss,
 *   never `ValidatorRejectionError`), with the conflicting peers and winning hashes as data;
 * - `held` votes present → `BlocksHeldError`, the other retryable refusal, with the holding action
 *   ids as data — also never `ValidatorRejectionError`;
 * - no votes at all (genuinely-silent cohort) → the legacy shortfall error whose message must stay
 *   BYTE-IDENTICAL: the consuming repo (sereus cadre-core control-write-retry) matches that exact
 *   text to retry, and neither retryable refusal may inflate its `rejections` number.
 */
class ConflictAnsweringClient {
	readonly received: ClusterRecord[] = [];

	constructor(
		private readonly peerIdStr: string,
		private readonly verdict: Answer,
		private readonly winnerHash = 'winner-hash-mock'
	) { }

	async update(record: ClusterRecord): Promise<ClusterRecord> {
		this.received.push({ ...record, promises: { ...record.promises }, commits: { ...record.commits } });
		if (!(this.peerIdStr in record.promises)) {
			if (this.verdict === 'silent') return record;
			const signature = `psig-${this.peerIdStr.substring(0, 8)}`;
			const sig: Signature = this.verdict === 'conflict'
				? { type: 'conflict', signature, conflictWith: this.winnerHash }
				: this.verdict === 'held'
					? { type: 'held', signature, heldBy: HELD_BY_MOCK }
					: this.verdict === 'reject'
						? { type: 'reject', signature, rejectReason: 'invalid transform' }
						: { type: 'approve', signature };
			return { ...record, promises: { ...record.promises, [this.peerIdStr]: sig } };
		}
		// Commit phase: every member that already voted signs the commit the cohort decided on —
		// including one that conflict-voted, which is what the real member does (the commit rule reads
		// the cohort's approval count, not this member's own vote).
		return {
			...record,
			commits: { ...record.commits, [this.peerIdStr]: { type: 'approve', signature: `csig-${this.peerIdStr.substring(0, 8)}` } }
		};
	}
}

describe('ClusterCoordinator lost conflict race (2-member-must-answer-a-lost-conflict-race)', function () {
	this.timeout(10000);

	let peerIds: PeerId[];
	let clusterPeers: ClusterPeers;

	beforeEach(async () => {
		peerIds = await Promise.all([makePeerId(), makePeerId(), makePeerId()]);
		clusterPeers = {};
		for (const pid of peerIds) {
			clusterPeers[pid.toString()] = {
				multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
				publicKey: u8ToString(pid.publicKey!.raw, 'base64url')
			};
		}
	});

	const makeCoordinator = (
		verdicts: Answer[],
		superMajorityThreshold = 0.75
	): { coordinator: ClusterCoordinator; mocks: ConflictAnsweringClient[] } => {
		const mocks = peerIds.map((pid, idx) => new ConflictAnsweringClient(pid.toString(), verdicts[idx]!));
		const byId = new Map(peerIds.map((pid, idx) => [pid.toString(), mocks[idx]!]));
		const mockKeyNetwork: IKeyNetwork = {
			async findCoordinator() { return peerIds[0]!; },
			async findCluster() { return { ...clusterPeers }; }
		};
		const createClient = (peerId: PeerId) => {
			const mock = byId.get(peerId.toString());
			if (!mock) throw new Error(`No mock for ${peerId.toString()}`);
			return mock;
		};
		// Default threshold 0.75 over 3 peers ⇒ superMajority 3, maxAllowedRejections 0.
		const coordinator = new ClusterCoordinator(mockKeyNetwork, createClient as any, { ...baseCfg, superMajorityThreshold });
		return { coordinator, mocks };
	};

	it('raises ConflictRaceLostError (not a validator rejection) when a member answers with a conflict vote', async () => {
		const { coordinator } = makeCoordinator(['approve', 'approve', 'conflict']);

		let caught: unknown;
		try {
			await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());
		} catch (err) {
			caught = err;
		}
		expect(caught, 'a lost race must be its own outcome').to.be.instanceOf(ConflictRaceLostError);
		expect((caught as ConflictRaceLostError).name).to.equal('ConflictRaceLostError');
		// The winning hash rides as structured data from the signed vote, never parsed from prose.
		expect(Object.values((caught as ConflictRaceLostError).conflicts)).to.deep.equal(['winner-hash-mock']);
		expect(Object.keys((caught as ConflictRaceLostError).conflicts)).to.deep.equal([peerIds[2]!.toString()]);
	});

	it('broadcasts the proof-carrying record so members free the loser\'s blocks immediately', async () => {
		const { coordinator, mocks } = makeCoordinator(['approve', 'approve', 'conflict']);

		let caught: unknown;
		try {
			await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());
		} catch (err) {
			caught = err;
		}
		expect(caught).to.be.instanceOf(ConflictRaceLostError);

		// One conflict vote at maxAllowedRejections 0 proves super-majority unreachable, so the
		// abandonment broadcast fires (fire-and-forget — poll for arrival).
		const sawConflict = (mock: ConflictAnsweringClient) =>
			mock.received.some(r => Object.values(r.promises ?? {}).some(s => s.type === 'conflict'));
		await waitFor(() => mocks.every(sawConflict), {
			description: 'every member receives the conflict-carrying record'
		});
	});

	it('keeps the genuinely-silent shortfall message byte-identical, uninflated by conflict votes', async () => {
		const { coordinator } = makeCoordinator(['approve', 'approve', 'silent']);

		let caught: unknown;
		try {
			await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());
		} catch (err) {
			caught = err;
		}
		expect(caught).to.be.instanceOf(Error);
		expect(caught).to.not.be.instanceOf(ConflictRaceLostError);
		// Load-bearing wire text — the consuming repo retries on exactly this shape. See the NOTE at
		// the throw site in cluster-coordinator.ts before changing a byte of it.
		expect((caught as Error).message).to.equal('Failed to get super-majority: 2/3 approvals (needed 3, 0 rejections)');
	});

	it('lets a genuine validator rejection outrank a conflict vote', async () => {
		// A member calling the transaction INVALID is a permanent verdict; a member that merely holds
		// the race winner is not. When both answer, the caller must hear the permanent one — otherwise
		// it retries forever against a transaction no cohort will ever accept.
		const { coordinator } = makeCoordinator(['approve', 'reject', 'conflict']);

		let caught: unknown;
		try {
			await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());
		} catch (err) {
			caught = err;
		}
		expect(caught).to.be.instanceOf(ValidatorRejectionError);
		expect((caught as ValidatorRejectionError).rejectReasons[peerIds[1]!.toString()]).to.equal('invalid transform');
	});

	it('commits a transaction that reached super-majority despite a conflict vote', async () => {
		// threshold 0.51 over 3 peers ⇒ super-majority 2, so two approvals carry the transaction even
		// though a third member holds a rival. A conflict vote refuses; it does not veto.
		const { coordinator } = makeCoordinator(['approve', 'approve', 'conflict'], 0.51);

		const { record } = await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());
		expect(Object.values(record.promises).filter(s => s.type === 'conflict').length).to.equal(1);
		expect(Object.keys(record.commits).length, 'the cohort committed').to.be.greaterThan(1);
	});
});

describe('ClusterCoordinator blocks held by a rival action (a-contended-pend-refusal-is-permanent-on-a-small-cohort)', function () {
	this.timeout(10000);

	/**
	 * A TWO-member cohort at 0.67 is the shape the defect was measured on: superMajority is
	 * `ceil(2 * 0.67) = 2`, so `maxAllowedRejections` is ZERO and a single member's refusal settles the
	 * transaction. When that refusal was a `reject` vote, "someone else is holding these blocks right
	 * now" — a condition that clears the moment the holder commits or cancels — reached the writer as
	 * `ValidatorRejectionError`, the answer reserved for a write that is invalid on every retry.
	 */
	const TwoMemberThreshold = 0.67;

	let peerIds: PeerId[];
	let clusterPeers: ClusterPeers;

	const setUpPeers = async (count: number): Promise<void> => {
		peerIds = await Promise.all(Array.from({ length: count }, makePeerId));
		clusterPeers = {};
		for (const pid of peerIds) {
			clusterPeers[pid.toString()] = {
				multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
				publicKey: u8ToString(pid.publicKey!.raw, 'base64url')
			};
		}
	};

	const makeCoordinator = (
		verdicts: Answer[],
		superMajorityThreshold: number
	): { coordinator: ClusterCoordinator; mocks: ConflictAnsweringClient[] } => {
		const mocks = peerIds.map((pid, idx) => new ConflictAnsweringClient(pid.toString(), verdicts[idx]!));
		const byId = new Map(peerIds.map((pid, idx) => [pid.toString(), mocks[idx]!]));
		const mockKeyNetwork: IKeyNetwork = {
			async findCoordinator() { return peerIds[0]!; },
			async findCluster() { return { ...clusterPeers }; }
		};
		const createClient = (peerId: PeerId) => {
			const mock = byId.get(peerId.toString());
			if (!mock) throw new Error(`No mock for ${peerId.toString()}`);
			return mock;
		};
		const coordinator = new ClusterCoordinator(mockKeyNetwork, createClient as any, { ...baseCfg, superMajorityThreshold });
		return { coordinator, mocks };
	};

	const runAndCatch = async (coordinator: ClusterCoordinator): Promise<unknown> => {
		try {
			await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());
			return undefined;
		} catch (err) {
			return err;
		}
	};

	it('answers one held vote on a two-member cohort with a retryable error, never a validator rejection', async () => {
		await setUpPeers(2);
		const { coordinator } = makeCoordinator(['approve', 'held'], TwoMemberThreshold);

		const caught = await runAndCatch(coordinator);

		expect(caught, 'a held pend must be its own outcome').to.be.instanceOf(BlocksHeldError);
		expect(caught, 'and must never be the permanent verdict').to.not.be.instanceOf(ValidatorRejectionError);
		// The holding action rides as structured data from the signed vote, never parsed from prose.
		expect(Object.values((caught as BlocksHeldError).heldBy)).to.deep.equal([HELD_BY_MOCK]);
		expect(Object.keys((caught as BlocksHeldError).heldBy)).to.deep.equal([peerIds[1]!.toString()]);
	});

	it('broadcasts the proof-carrying record so members free the blocks immediately', async () => {
		await setUpPeers(2);
		const { coordinator, mocks } = makeCoordinator(['approve', 'held'], TwoMemberThreshold);

		expect(await runAndCatch(coordinator)).to.be.instanceOf(BlocksHeldError);

		// One held vote at maxAllowedRejections 0 proves super-majority unreachable, so the abandonment
		// broadcast fires (fire-and-forget — poll for arrival).
		const sawHeld = (mock: ConflictAnsweringClient) =>
			mock.received.some(r => Object.values(r.promises ?? {}).some(s => s.type === 'held'));
		await waitFor(() => mocks.every(sawHeld), {
			description: 'every member receives the held-carrying record'
		});
	});

	it('stays silent when the held votes do not prove super-majority unreachable', async () => {
		// Five peers at 0.75 ⇒ super-majority 4, so `maxAllowedRejections` is 1. One held vote and one
		// member that never answers leave approvals at 3: the pend is refused, but the merged record
		// does NOT prove the transaction dead — a member re-deriving `ConflictSuperseded` from these
		// same votes needs rejections + retryable refusals ABOVE 1, and it has exactly 1. Below that
		// bar an abandonment broadcast is the unauthenticated "forget this" every branch refuses to
		// send, so `refusalsProveUnreachable` must gate the held branch as it gates the conflict one.
		await setUpPeers(5);
		const { coordinator } = makeCoordinator(['approve', 'approve', 'approve', 'held', 'silent'], 0.75);

		let caught: unknown;
		// Asserted off the coordinator's own log rather than off the mocks' inboxes: the broadcast is
		// fire-and-forget, so "no record arrived" can only ever be a timing claim, while the
		// `cluster-tx:abandon-broadcast` line is emitted synchronously at the decision itself.
		const captured = await captureLog('cluster', async () => { caught = await runAndCatch(coordinator); });

		expect(caught, 'still the retryable held answer').to.be.instanceOf(BlocksHeldError);
		expect(hasTag(captured, 'cluster-tx:pend-blocks-held'), 'the held branch is the one that ran').to.equal(true);
		expect(hasTag(captured, 'cluster-tx:abandon-broadcast'), 'nothing here proves the record dead').to.equal(false);
	});

	it('lets a genuine validator rejection outrank a held vote', async () => {
		// Same precedence as a conflict vote: a member calling the transaction INVALID is permanent, and
		// the caller must hear that rather than retry forever against a write no cohort will accept.
		await setUpPeers(3);
		const { coordinator } = makeCoordinator(['approve', 'reject', 'held'], 0.75);

		const caught = await runAndCatch(coordinator);

		expect(caught).to.be.instanceOf(ValidatorRejectionError);
		expect((caught as ValidatorRejectionError).rejectReasons[peerIds[1]!.toString()]).to.equal('invalid transform');
	});

	it('lets a lost conflict race outrank a held vote', async () => {
		// Both are retryable, so the choice is about which names the more useful thing: a conflict vote
		// carries the winning transaction's messageHash, a held vote only an action id.
		await setUpPeers(3);
		const { coordinator } = makeCoordinator(['approve', 'conflict', 'held'], 0.75);

		expect(await runAndCatch(coordinator)).to.be.instanceOf(ConflictRaceLostError);
	});

	it('never inflates the genuinely-silent shortfall message with held votes', async () => {
		// The load-bearing wire text is reached only with no retryable refusal in the record; a held vote
		// is peeled off above it, exactly as a conflict vote is, and never counted as a rejection.
		await setUpPeers(3);
		const { coordinator } = makeCoordinator(['approve', 'approve', 'silent'], 0.75);

		const caught = await runAndCatch(coordinator);

		expect(caught).to.be.instanceOf(Error);
		expect(caught).to.not.be.instanceOf(BlocksHeldError);
		expect((caught as Error).message).to.equal('Failed to get super-majority: 2/3 approvals (needed 3, 0 rejections)');
	});

	it('commits a transaction that reached super-majority despite a held vote', async () => {
		// threshold 0.51 over 3 peers ⇒ super-majority 2, so two approvals carry the transaction even
		// though a third member's storage holds a rival. A held vote refuses; it does not veto.
		await setUpPeers(3);
		const { coordinator } = makeCoordinator(['approve', 'approve', 'held'], 0.51);

		const { record } = await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());

		expect(Object.values(record.promises).filter(s => s.type === 'held').length).to.equal(1);
		expect(Object.keys(record.commits).length, 'the cohort committed').to.be.greaterThan(1);
	});
});

describe('ClusterCoordinator abandonment broadcast (1-abandoned-pend-holds-the-block)', function () {
	this.timeout(10000);

	it('tells the cohort when it abandons a transaction the validators rejected', async () => {
		const peerIds = await Promise.all([makePeerId(), makePeerId(), makePeerId()]);
		const clusterPeers: ClusterPeers = {};
		for (const pid of peerIds) {
			clusterPeers[pid.toString()] = {
				multiaddrs: ['/ip4/127.0.0.1/tcp/8000'],
				publicKey: u8ToString(pid.publicKey!.raw, 'base64url')
			};
		}

		// threshold 0.75 over 3 peers ⇒ superMajority 3 ⇒ maxAllowedRejections 0, so one reject
		// is already terminal and the coordinator takes the `rejected-by-validators` path.
		const mocks = peerIds.map((pid, idx) =>
			new RecordingClusterClient(pid.toString(), idx === 2 ? 'reject' : 'approve'));
		const byId = new Map(peerIds.map((pid, idx) => [pid.toString(), mocks[idx]!]));

		const mockKeyNetwork: IKeyNetwork = {
			async findCoordinator() { return peerIds[0]!; },
			async findCluster() { return { ...clusterPeers }; }
		};
		const createClient = (peerId: PeerId) => {
			const mock = byId.get(peerId.toString());
			if (!mock) throw new Error(`No mock for ${peerId.toString()}`);
			return mock;
		};

		const coordinator = new ClusterCoordinator(
			mockKeyNetwork,
			createClient as any,
			{ ...baseCfg, superMajorityThreshold: 0.75 }
		);

		let caught: Error | null = null;
		try {
			await coordinator.executeClusterTransaction('block-1' as BlockId, makeMessage());
		} catch (err) {
			caught = err as Error;
		}
		expect(caught, 'expected a validator rejection').to.be.instanceOf(Error);

		// The broadcast is fire-and-forget so the throw does not wait on it — poll for arrival.
		const sawRejection = (mock: RecordingClusterClient) =>
			mock.received.some(r => Object.values(r.promises ?? {}).some(s => s.type === 'reject'));
		await waitFor(() => mocks.every(sawRejection), {
			description: 'every member receives the rejection-carrying record'
		});
	});
});
