import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { hashKey } from 'p2p-fret';
import type { FretService } from 'p2p-fret';
import { RingShiftCoordinator, type ReplicationConfirmer } from '../src/storage/ring-shift-coordinator.js';
import { RingSelector } from '../src/storage/ring-selector.js';
import { PartitionDetector } from '../src/cluster/partition-detector.js';
import { extractPrefix, isServingHolder, qualifiesForFloor, partitionCovers } from '../src/storage/arachnode-partition.js';
import type { ArachnodeFretAdapter, ArachnodeInfo } from '../src/storage/arachnode-fret-adapter.js';

/**
 * The **advertise → confirm-replication → release** ring-shift handoff
 * (`docs/arachnode-ring-handoff.md` § Part 2 & Part 3). These tests drive `RingShiftCoordinator`
 * through the three phases with a stub confirmer and assert the **replication-floor invariant**: at no
 * simulated instant during a move-out does the count of `active`-serving responsible holders for a
 * shed key fall below `N`. Real `hashKey`/`extractPrefix` derive the shed range (no faked coords), so
 * the responsibility math is the production math.
 */

const encoder = new TextEncoder();
const makePeerId = async (): Promise<string> => peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();

/** Minimal storage monitor (RingSelector.createArachnodeInfo only reads getCapacity). */
class MockStorageMonitor {
	async getCapacity() {
		const total = 1024 * 1024 * 1024;
		return { total, used: 0, available: total };
	}
}

/** In-memory Arachnode adapter: self info + a peer→info map. Only the methods the shift touches. */
class MockAdapter {
	private self: ArachnodeInfo | undefined;
	private readonly peers = new Map<string, ArachnodeInfo>();
	setSelf(info: ArachnodeInfo | undefined): void { this.self = info; }
	setPeer(id: string, info: ArachnodeInfo): void { this.peers.set(id, info); }
	getMyArachnodeInfo(): ArachnodeInfo | undefined { return this.self; }
	getArachnodeInfo(id: string): ArachnodeInfo | undefined { return this.peers.get(id); }
	setArachnodeInfo(info: ArachnodeInfo): void { this.self = info; }
	setStatus(status: ArachnodeInfo['status']): void { if (this.self) this.self = { ...this.self, status }; }
	getRingStats(): Array<{ ringDepth: number; peerCount: number; avgCapacity: number }> { return []; }
	/** Every advertised holder including self — the test's universe for counting serving holders. */
	allInfos(selfId: string): Array<{ id: string; info: ArachnodeInfo }> {
		const out: Array<{ id: string; info: ArachnodeInfo }> = [];
		if (this.self) out.push({ id: selfId, info: this.self });
		for (const [id, info] of this.peers) out.push({ id, info });
		return out;
	}
}

/** assembleCohort returns a fixed candidate set; that is all RingShiftCoordinator asks of FRET. */
class MockFret {
	private cohort: string[] = [];
	setCohort(peers: string[]): void { this.cohort = peers; }
	assembleCohort(_coord: Uint8Array, _wants: number): string[] { return [...this.cohort]; }
}

/** Confirms a block iff its owner set reaches the floor (models successful replication), unless forced to fail. */
class StubConfirmer implements ReplicationConfirmer {
	calls: Array<{ blockIds: string[]; owners: Map<string, string[]>; floor: number }> = [];
	behavior: 'byCount' | 'fail' = 'byCount';
	/** Runs at the instant Phase B is in flight (self is already `moving`) — used to snapshot the count. */
	onConfirm?: () => void;

	async confirmReplicated(blockIds: string[], owners: Map<string, string[]>, floor: number) {
		this.calls.push({ blockIds, owners, floor });
		this.onConfirm?.();
		const confirmed: string[] = [];
		const unconfirmed: string[] = [];
		for (const id of blockIds) {
			const o = owners.get(id) ?? [];
			if (this.behavior === 'byCount' && o.length >= floor) confirmed.push(id);
			else unconfirmed.push(id);
		}
		return { confirmed, unconfirmed };
	}
}

const active = (ringDepth: number, partition?: ArachnodeInfo['partition']): ArachnodeInfo => ({
	ringDepth, partition, capacity: { total: 0, used: 0, available: 0 }, status: 'active'
});

describe('RingShiftCoordinator — advertise→confirm→release handoff', () => {
	let selfId: string;
	let peerA: string;
	let peerB: string;
	let peerC: string;
	let adapter: MockAdapter;
	let fret: MockFret;
	let partitionDetector: PartitionDetector;
	let ringSelector: RingSelector;
	let confirmer: StubConfirmer;
	let released: string[];
	const FLOOR = 2;

	// Derived once from real crypto: self's ring-1 partition bit, a block the move SHEDS, one it KEEPS.
	let selfBit0: number;
	let shedBit0: number;
	let shedBlock: string;
	let keptBlock: string;
	let shedCoord: Uint8Array;

	const ringSelectorConfig = { minCapacity: 1024, thresholds: { moveOut: 0.85, moveIn: 0.4 } };

	before(async () => {
		selfId = await makePeerId();
		peerA = await makePeerId();
		peerB = await makePeerId();
		peerC = await makePeerId();

		// self's partition after a ring 0 → ring 1 move-out (real hashPeerId), and the shed half's bit.
		const sel = new RingSelector(new MockAdapter() as unknown as ArachnodeFretAdapter, new MockStorageMonitor() as any, ringSelectorConfig);
		const p = await sel.calculatePartition(1, selfId);
		selfBit0 = p!.prefixValue;
		shedBit0 = 1 - selfBit0;

		// Find one block the ring-1 partition sheds (coord bit0 == shedBit0) and one it keeps.
		for (let i = 0; shedBlock === undefined || keptBlock === undefined; i++) {
			const id = `blk-${i}`;
			const coord = await hashKey(encoder.encode(id));
			const bit0 = extractPrefix(coord, 1);
			if (bit0 === shedBit0 && shedBlock === undefined) { shedBlock = id; shedCoord = coord; }
			else if (bit0 === selfBit0 && keptBlock === undefined) { keptBlock = id; }
			if (i > 10_000) throw new Error('could not classify blocks'); // real hashes → both bits appear fast
		}
	});

	beforeEach(() => {
		adapter = new MockAdapter();
		fret = new MockFret();
		partitionDetector = new PartitionDetector();
		ringSelector = new RingSelector(adapter as unknown as ArachnodeFretAdapter, new MockStorageMonitor() as any, ringSelectorConfig);
		confirmer = new StubConfirmer();
		released = [];
	});

	function makeCoordinator(ownedBlocks: Set<string>): RingShiftCoordinator {
		return new RingShiftCoordinator({
			fretAdapter: adapter as unknown as ArachnodeFretAdapter,
			ringSelector,
			fret: fret as unknown as FretService,
			partitionDetector,
			confirmer,
			ownedBlocks,
			selfPeerId: selfId,
			getFloor: () => FLOOR,
			onRelease: (ids) => released.push(...ids)
		});
	}

	/** Count peers (incl. self) that are serving/responsible for `coord`, honoring fail-toward-old-holder. */
	function countServingHolders(coord: Uint8Array): number {
		return adapter.allInfos(selfId).filter(({ info }) => isServingHolder(info, coord)).length;
	}

	function partitionMany(): void {
		for (let i = 0; i < 10; i++) {
			partitionDetector.recordFailure(`peer-${i}`);
			partitionDetector.recordFailure(`peer-${i}`);
			partitionDetector.recordFailure(`peer-${i}`);
		}
	}

	describe('replication-floor invariant (the core test)', () => {
		it('holds at every phase transition of a move-out: mover counts until release, ≥N others after', async () => {
			// self at ring 0 (covers everything); two stable holders advertise the shed half's partition.
			adapter.setSelf(active(0, undefined));
			adapter.setPeer(peerA, active(1, { prefixBits: 1, prefixValue: shedBit0 }));
			adapter.setPeer(peerB, active(1, { prefixBits: 1, prefixValue: shedBit0 }));
			fret.setCohort([selfId, peerA, peerB]);

			// (a) BEFORE the shift: self + A + B all serve the shed key.
			expect(countServingHolders(shedCoord), 'holders before shift').to.be.at.least(FLOOR);

			// (b) DURING Phase B (self is already `moving`): the mover is still counted (fail-toward-old).
			let duringPhaseB = -1;
			confirmer.onConfirm = () => { duringPhaseB = countServingHolders(shedCoord); };

			const owned = new Set([shedBlock, keptBlock]);
			const outcome = await makeCoordinator(owned).executeShift({ direction: 'out', newRingDepth: 1 });

			expect(duringPhaseB, 'holders during Phase B (mover still serving old range)').to.be.at.least(FLOOR);

			// (c) AFTER Phase C release: the mover no longer covers the shed key, but ≥N others do.
			expect(outcome.status).to.equal('moved-out');
			expect(countServingHolders(shedCoord), 'holders after release (≥N others)').to.be.at.least(FLOOR);
			expect(adapter.getMyArachnodeInfo()!.status, 'self is active at the new ring').to.equal('active');
			expect(adapter.getMyArachnodeInfo()!.ringDepth).to.equal(1);
			expect(adapter.getMyArachnodeInfo()!.moveFrom, 'moveFrom cleared on release').to.equal(undefined);
		});

		it('releases only the shed range (keeps the half the new partition still covers)', async () => {
			adapter.setSelf(active(0, undefined));
			adapter.setPeer(peerA, active(1, { prefixBits: 1, prefixValue: shedBit0 }));
			adapter.setPeer(peerB, active(1, { prefixBits: 1, prefixValue: shedBit0 }));
			fret.setCohort([selfId, peerA, peerB]);

			const outcome = await makeCoordinator(new Set([shedBlock, keptBlock])).executeShift({ direction: 'out', newRingDepth: 1 });

			expect(outcome).to.deep.include({ status: 'moved-out' });
			expect(released, 'only the shed block is released').to.deep.equal([shedBlock]);
			expect(released, 'the kept block is NOT released').to.not.include(keptBlock);
		});
	});

	describe('concurrent adjacent moves (§ Part 3)', () => {
		it('excludes a same-range mover from the floor: too few qualifying holders → rollback, range retained', async () => {
			// self (mover A) at ring 0. peerB is ALSO moving and its TARGET partition sheds the SAME sub-range
			// (it advertises the kept half), so it must not count. Only peerC is a stable holder of the overlap
			// — one holder < floor 2 → cannot confirm → rollback.
			adapter.setSelf(active(0, undefined));
			adapter.setPeer(peerB, {
				ringDepth: 1, partition: { prefixBits: 1, prefixValue: selfBit0 }, // target does NOT cover the shed key
				capacity: { total: 0, used: 0, available: 0 }, status: 'moving',
				moveFrom: { ringDepth: 0, partition: undefined }
			});
			adapter.setPeer(peerC, active(1, { prefixBits: 1, prefixValue: shedBit0 })); // stable holder of the overlap
			fret.setCohort([selfId, peerB, peerC]);

			const outcome = await makeCoordinator(new Set([shedBlock])).executeShift({ direction: 'out', newRingDepth: 1 });

			expect(outcome.status, 'shift rolled back — could not find N qualifying holders').to.equal('rolled-back');
			expect(released, 'nothing released').to.deep.equal([]);
			// Rolled back to the old ring, still active-serving the overlap.
			expect(adapter.getMyArachnodeInfo()!.ringDepth, 'restored to old ring').to.equal(0);
			expect(adapter.getMyArachnodeInfo()!.status).to.equal('active');
			expect(adapter.getMyArachnodeInfo()!.moveFrom, 'moveFrom cleared on rollback').to.equal(undefined);
			// The one owner passed to the confirmer was peerC only (peerB excluded as a same-range mover).
			const ownersForShed = confirmer.calls[0]?.owners.get(shedBlock) ?? [];
			expect(ownersForShed, 'same-range mover peerB excluded; only stable peerC qualifies').to.deep.equal([peerC]);
		});
	});

	describe('partition during handoff', () => {
		it('Phase B aborts (rollback, range retained) when a partition is detected mid-confirm', async () => {
			adapter.setSelf(active(0, undefined));
			adapter.setPeer(peerA, active(1, { prefixBits: 1, prefixValue: shedBit0 }));
			adapter.setPeer(peerB, active(1, { prefixBits: 1, prefixValue: shedBit0 }));
			fret.setCohort([selfId, peerA, peerB]);
			partitionMany(); // partition present before Phase B runs

			const outcome = await makeCoordinator(new Set([shedBlock])).executeShift({ direction: 'out', newRingDepth: 1 });

			expect(outcome).to.deep.include({ status: 'rolled-back', reason: 'partition' });
			expect(released, 'range retained during partition').to.deep.equal([]);
			expect(adapter.getMyArachnodeInfo()!.ringDepth).to.equal(0);
			expect(adapter.getMyArachnodeInfo()!.status).to.equal('active');
			expect(confirmer.calls, 'confirmer never invoked once a partition is detected').to.have.length(0);
		});
	});

	describe('confirm floor unmet', () => {
		it('rolls back and releases nothing when the confirmer cannot reach the floor', async () => {
			adapter.setSelf(active(0, undefined));
			adapter.setPeer(peerA, active(1, { prefixBits: 1, prefixValue: shedBit0 }));
			adapter.setPeer(peerB, active(1, { prefixBits: 1, prefixValue: shedBit0 }));
			fret.setCohort([selfId, peerA, peerB]);
			confirmer.behavior = 'fail';

			const outcome = await makeCoordinator(new Set([shedBlock])).executeShift({ direction: 'out', newRingDepth: 1 });

			expect(outcome.status).to.equal('rolled-back');
			expect(released).to.deep.equal([]);
			expect(adapter.getMyArachnodeInfo()!.ringDepth).to.equal(0);
		});

		it('rolls back to a CLEAN active ring-0 advertisement when the node had no prior info', async () => {
			// A node with no advertised info triggers a move-out (shouldTransition tolerates this) and
			// Phase B fails. Rollback must restore active ring-0 (whole keyspace) — NOT leave the aborted
			// narrower target ring/partition + moveFrom advertised as active, which would drop coverage of
			// the shed range with nothing confirmed (the floor violation this handoff prevents).
			adapter.setSelf(undefined);
			adapter.setPeer(peerA, active(1, { prefixBits: 1, prefixValue: shedBit0 }));
			adapter.setPeer(peerB, active(1, { prefixBits: 1, prefixValue: shedBit0 }));
			fret.setCohort([selfId, peerA, peerB]);
			confirmer.behavior = 'fail';

			const outcome = await makeCoordinator(new Set([shedBlock])).executeShift({ direction: 'out', newRingDepth: 1 });

			expect(outcome.status).to.equal('rolled-back');
			expect(released, 'nothing released').to.deep.equal([]);
			const info = adapter.getMyArachnodeInfo()!;
			expect(info.status, 'restored to active').to.equal('active');
			expect(info.ringDepth, 'restored to the old (ring-0) range, not the aborted target').to.equal(0);
			expect(info.partition, 'ring-0 whole keyspace — no narrower target partition left advertised').to.equal(undefined);
			expect(info.moveFrom, 'no stray moveFrom on an active advertisement').to.equal(undefined);
			// The mover still physically holds the shed block, and now advertises it covers it (ring 0).
			expect(isServingHolder(info, shedCoord), 'still a serving holder of the shed key after rollback').to.equal(true);
		});
	});

	describe('move-in (advertise only, sheds nothing)', () => {
		it('advertises the inner ring at active without confirming or releasing', async () => {
			adapter.setSelf(active(1, { prefixBits: 1, prefixValue: selfBit0 }));

			const outcome = await makeCoordinator(new Set([shedBlock, keptBlock])).executeShift({ direction: 'in', newRingDepth: 0 });

			expect(outcome).to.deep.include({ status: 'moved-in', to: 0 });
			expect(adapter.getMyArachnodeInfo()!.ringDepth).to.equal(0);
			expect(adapter.getMyArachnodeInfo()!.status).to.equal('active');
			expect(confirmer.calls, 'move-in never confirms').to.have.length(0);
			expect(released, 'move-in never releases').to.deep.equal([]);
		});
	});

	describe('re-entrancy', () => {
		it('skips when the node is already moving', async () => {
			adapter.setSelf({ ...active(1, { prefixBits: 1, prefixValue: selfBit0 }), status: 'moving', moveFrom: { ringDepth: 0 } });
			const outcome = await makeCoordinator(new Set([shedBlock])).executeShift({ direction: 'out', newRingDepth: 2 });
			expect(outcome).to.deep.equal({ status: 'skipped', reason: 'already-moving' });
		});
	});

	describe('crash mid-handoff / reconcileOnStart (§ Part 3)', () => {
		it('resumes serving the old range and refreshes a stale `moving` advertisement to active', async () => {
			// Crash between Phase A (advertised ring-1 target, moving) and Phase C (never released).
			adapter.setSelf({
				ringDepth: 1, partition: { prefixBits: 1, prefixValue: selfBit0 },
				capacity: { total: 0, used: 0, available: 0 }, status: 'moving',
				moveFrom: { ringDepth: 0, partition: undefined }
			});

			const result = makeCoordinator(new Set([shedBlock])).reconcileOnStart();

			expect(result.reconciled).to.equal(true);
			const info = adapter.getMyArachnodeInfo()!;
			expect(info.status, 'refreshed to active').to.equal('active');
			expect(info.ringDepth, 're-derived to the OLD ring (still responsible for it)').to.equal(0);
			expect(info.partition, 'old partition restored (ring 0 = whole keyspace)').to.equal(undefined);
			expect(info.moveFrom, 'move state cleared').to.equal(undefined);
		});

		it('is a no-op for a node that is not moving', () => {
			adapter.setSelf(active(2, { prefixBits: 2, prefixValue: 1 }));
			const result = makeCoordinator(new Set()).reconcileOnStart();
			expect(result.reconciled).to.equal(false);
			expect(adapter.getMyArachnodeInfo()!.ringDepth).to.equal(2);
		});

		it('a `moving` peer is still counted as a holder for its OLD range (fail-toward-old-holder)', async () => {
			// A peer mid-move-out from ring 0: target ring-1 partition covers only the kept half, but moveFrom
			// (ring 0) covers the whole keyspace — so it still serves the shed key until it releases.
			const movingPeer: ArachnodeInfo = {
				ringDepth: 1, partition: { prefixBits: 1, prefixValue: selfBit0 },
				capacity: { total: 0, used: 0, available: 0 }, status: 'moving',
				moveFrom: { ringDepth: 0, partition: undefined }
			};
			expect(isServingHolder(movingPeer, shedCoord), 'moving peer still serves its old range').to.equal(true);
			// But it does NOT qualify toward another mover's floor for the shed key (it is shedding it).
			expect(qualifiesForFloor(movingPeer, shedCoord), 'moving peer excluded from the confirm floor').to.equal(false);
		});
	});

	describe('membership-agreement interaction (§ Part 3): superset cohort during A–B', () => {
		it('a one-step move keeps the affected key covered by old ∪ new holders (bounded ~one-member delta)', async () => {
			// During Phases A–B the shed key is covered by the mover (old range) PLUS the new holders — a
			// superset, not a disjoint swap. This is the property that keeps the per-block cohort delta a
			// bounded ~one member (well inside the admission gate's clusterSizeTolerance); the single-step
			// rule is what bounds it. Full admitMembership integration is NOT exercised here (see handoff).
			const mover: ArachnodeInfo = {
				ringDepth: 1, partition: { prefixBits: 1, prefixValue: selfBit0 },
				capacity: { total: 0, used: 0, available: 0 }, status: 'moving',
				moveFrom: { ringDepth: 0, partition: undefined }
			};
			const newHolder = active(1, { prefixBits: 1, prefixValue: shedBit0 });

			// Old cohort = {mover}; new cohort = {mover(kept), newHolder}. During A–B the SERVING set for the
			// shed key is the union {mover, newHolder} — the mover has not dropped out yet.
			const servingDuringShift = [mover, newHolder].filter(i => isServingHolder(i, shedCoord));
			expect(servingDuringShift, 'shed key covered by old holder ∪ new holder').to.have.length(2);
			// Sanity: the mover's TARGET partition alone would NOT cover the shed key — coverage comes from moveFrom.
			expect(partitionCovers(mover.partition, shedCoord)).to.equal(false);
		});
	});
});
