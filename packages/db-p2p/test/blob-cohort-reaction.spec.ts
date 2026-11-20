/**
 * Ticket: feat-the-blob-cohort-reaction.
 *
 * `BlobCohortReaction` is the decision half of docs/blobs.md §Placement, copying and durability,
 * *When the cohort changes*: it turns one `RebalanceEvent` over the blobs this node holds for the
 * network into "announce to these peers", "this hold can go", "this hold must stay".
 *
 * These two specs pin the branching that decides those answers — the release count over one `stat`
 * snapshot, and the announce-answer-to-`GrowthOutcome` mapping — over a real `LocalBlobService` (so
 * the `responsible` hold really is a record) with `stat` and `announce` doubles. The copying they
 * trigger is pinned end to end by `blob-copy.spec.ts`, and the monitor's own check-and-report
 * behaviour (including the `retainLost` re-report these results drive) by `rebalance-monitor.spec.ts`.
 */

import { expect } from 'chai';
import type { BlobRef, BlobScope } from '@optimystic/db-core';
import type { BlobAcceptance } from '../src/blob/accepts-blobs.js';
import { BlobCohortReaction, type BlobCohortReactionDeps } from '../src/blob/cohort-reaction.js';
import type { BlobAnnounceAnswer, BlobLocalHolding } from '../src/blob/blob-protocol.js';
import { LocalBlobService } from '../src/blob/local-blob-service.js';
import { MemoryPieceStore } from '../src/blob/memory-piece-store.js';
import { OwedBlobLedger } from '../src/blob/owed-blob-ledger.js';
import type { RebalanceEvent } from '../src/cluster/rebalance-monitor.js';
import { MemoryKVStore } from '../src/storage/memory-kv-store.js';
import { streamOf } from './support/blob-mesh.js';

const SELF = 'self-node';
const SCOPE: BlobScope = 'app/photos/blobrefs';

/** Deterministic bytes, so a blob in this spec is the same every run. */
function bytesOf(length: number, seed: number): Uint8Array {
	const bytes = new Uint8Array(length);
	let state = seed * 2654435761 >>> 0;
	for (let index = 0; index < length; index++) {
		state = (state * 1103515245 + 12345) >>> 0;
		bytes[index] = state >>> 24;
	}
	return bytes;
}

/** What each peer answers a `stat`, and every request made. */
class StatDouble {
	readonly calls: Array<{ peerId: string; refs: readonly BlobRef[] }> = [];
	private readonly holdings = new Map<string, BlobLocalHolding>();
	answer(peerId: string, holding: BlobLocalHolding): void {
		this.holdings.set(peerId, holding);
	}
	readonly stat = async (peerId: string, refs: readonly BlobRef[]): Promise<readonly BlobLocalHolding[]> => {
		this.calls.push({ peerId, refs: [...refs] });
		return refs.map(() => this.holdings.get(peerId) ?? 'none');
	};
}

/** What each peer answers an `announce`, and every announcement made. */
class AnnouncerDouble {
	readonly calls: Array<{ peerId: string; ref: BlobRef; scope: BlobScope }> = [];
	private readonly answers = new Map<string, BlobAnnounceAnswer>();
	answer(peerId: string, answer: BlobAnnounceAnswer): void {
		this.answers.set(peerId, answer);
	}
	readonly announce = async (peerId: string, ref: BlobRef, scope: BlobScope): Promise<BlobAnnounceAnswer> => {
		this.calls.push({ peerId, ref, scope });
		return this.answers.get(peerId) ?? 'fetching';
	};
	peersTold(): string[] {
		return this.calls.map(call => call.peerId);
	}
}

/** The drain's per-peer `declined` memory, as the reaction uses it. */
class DecliningDouble {
	readonly declined = new Set<string>();
	isDeclining(peerId: string): boolean {
		return this.declined.has(peerId);
	}
	noteDeclined(peerId: string): void {
		this.declined.add(peerId);
	}
}

function eventOf(event: Partial<RebalanceEvent>): RebalanceEvent {
	return {
		gained: [],
		lost: [],
		newOwners: new Map(),
		grown: new Map(),
		floor: 2,
		triggeredAt: Date.now(),
		...event,
	};
}

describe('BlobCohortReaction', () => {
	let blobs: LocalBlobService;
	let owed: OwedBlobLedger;
	let stat: StatDouble;
	let announcer: AnnouncerDouble;
	let declining: DecliningDouble;
	let deps: BlobCohortReactionDeps;

	beforeEach(() => {
		const kv = new MemoryKVStore();
		blobs = new LocalBlobService({ pieces: new MemoryPieceStore(), kv, setTimer: () => () => undefined });
		owed = new OwedBlobLedger(kv);
		stat = new StatDouble();
		announcer = new AnnouncerDouble();
		declining = new DecliningDouble();
		deps = {
			selfId: SELF,
			partitionDetector: { detectPartition: () => false },
			records: blobs,
			owed,
			acceptance: async (peerIds): Promise<Record<string, BlobAcceptance>> =>
				Object.fromEntries(peerIds.map(peerId => [peerId, 'accepts' as BlobAcceptance])),
			declining,
			announce: announcer.announce,
			stat: stat.stat,
		};
	});

	/** A blob held here for the network, as a node that fetched it after an announcement holds it. */
	const heldBlob = async (seed: number): Promise<BlobRef> => {
		const { ref } = await blobs.put(streamOf(bytesOf(2048, seed)));
		await blobs.holdResponsible(ref, SCOPE);
		return ref;
	};

	it('releases a lost blob only once the floor of new owners answers `whole`', async () => {
		const ref = await heldBlob(1);
		const reaction = new BlobCohortReaction(deps);
		const event = eventOf({ lost: [ref], newOwners: new Map([[ref, ['owner-a', 'owner-b']]]), floor: 2 });

		stat.answer('owner-a', 'whole');
		stat.answer('owner-b', 'none');
		const first = await reaction.handle(event);

		expect(first.released).to.deep.equal([]);
		expect(first.retained).to.deep.equal([ref]);
		// The owner that does not hold it is announced to, so it starts pulling now; the one that does is not.
		expect(announcer.peersTold()).to.deep.equal(['owner-b']);
		expect(await blobs.responsibleScope(ref)).to.equal(SCOPE);

		stat.answer('owner-b', 'whole');
		const second = await reaction.handle(event);

		expect(second.released).to.deep.equal([ref]);
		expect(second.retained).to.deep.equal([]);

		// Standing in for the caller's handler, which releases what the reaction reports released.
		await blobs.releaseResponsible(ref);
		expect(await blobs.responsibleScope(ref)).to.equal(undefined);
	});

	it('reports a grown blob complete only when every new peer is satisfied', async () => {
		const ref = await heldBlob(2);
		const reaction = new BlobCohortReaction(deps);
		announcer.answer('peer-whole', 'whole');
		announcer.answer('peer-fetching', 'fetching');
		announcer.answer('peer-declined', 'declined');
		announcer.answer('peer-unreferenced', 'unreferenced');

		const result = await reaction.handle(eventOf({
			grown: new Map([[ref, ['peer-whole', 'peer-fetching', 'peer-declined', 'peer-unreferenced']]]),
		}));

		expect(result.growth.get(ref)).to.deep.equal({
			satisfiedPeers: ['peer-whole', 'peer-fetching', 'peer-declined'],
			complete: false,
		});
		expect([...declining.declined]).to.deep.equal(['peer-declined']);
	});
});
