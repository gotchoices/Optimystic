/**
 * Ticket: feat-blob-owed-copies-are-drained.
 *
 * `BlobCopyDrain` is the sending half of `announce` (docs/blobs.md §Placement, copying and
 * durability, *Copying*): `NodeBlobService.announce` takes the `owed` hold and records the entry,
 * and this drain announces the blob to each cohort member that still owes a copy until every member
 * that accepts blobs holds it, reporting the blob's durability as that changes.
 *
 * These specs pin the drain's own rules over a real `OwedBlobLedger` and a real `LocalBlobService`
 * (both in memory), the shared fake libp2p, a key-network double with a fixed cohort and an
 * announcer double. The classification itself is a table in `blob-durability.spec.ts`; the
 * scheduling — when a pass runs, the eligibility filter, the per-pass budget and the give-up rule —
 * is `DrainScheduler`'s, pinned in `under-replication-drain.spec.ts`; and the round trip over real
 * nodes is `blob-copy.spec.ts`.
 */

import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import type { BlobDurabilityEvent, BlobRef, BlobScope, ClusterPeers, RoutingKey } from '@optimystic/db-core';
import type { BlobAcceptance } from '../src/blob/accepts-blobs.js';
import {
	BlobCopyDrain, type BlobCopyDrainConfig, type BlobCopyDrainDeps
} from '../src/blob/blob-copy-drain.js';
import { buildBlobProtocol, type BlobAnnounceAnswer } from '../src/blob/blob-protocol.js';
import { BlobRecordStore } from '../src/blob/blob-record-store.js';
import { DEFAULT_BLOB_OWNER } from '../src/blob/blob-record.js';
import { LocalBlobService } from '../src/blob/local-blob-service.js';
import { MemoryPieceStore } from '../src/blob/memory-piece-store.js';
import { OwedBlobLedger } from '../src/blob/owed-blob-ledger.js';
import type { DrainLibp2p } from '../src/repo/drain-scheduler.js';
import { MemoryKVStore } from '../src/storage/memory-kv-store.js';
import { streamOf } from './support/blob-mesh.js';
import { MockLibp2p } from './support/drain-libp2p.js';

const PREFIX = '/optimystic/blob-copy-drain-test';
const SCOPE: BlobScope = 'app/photos/blobrefs';

const makePeerId = async (): Promise<PeerId> => peerIdFromPrivateKey(await generateKeyPair('Ed25519'));

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

/**
 * One cohort for every key: each scenario below owes exactly one blob, so the routing key — a digest
 * the fake could not decode back to a reference anyway — carries no information it needs.
 */
class FakeKeyNetwork {
	private cohort: string[] = [];
	calls = 0;
	setCohort(peerIds: string[]): void {
		this.cohort = peerIds;
	}
	async findCluster(_key: RoutingKey): Promise<ClusterPeers> {
		this.calls++;
		return Object.fromEntries(this.cohort.map(id => [id, { multiaddrs: [], publicKey: '' }]));
	}
}

/** The announce double: what each peer answers, and every call made. */
class AnnouncerDouble {
	readonly calls: Array<{ peerId: string; ref: BlobRef; scope: BlobScope }> = [];
	private readonly answers = new Map<string, BlobAnnounceAnswer | 'unreachable'>();
	answer(peerId: PeerId, answer: BlobAnnounceAnswer | 'unreachable'): void {
		this.answers.set(peerId.toString(), answer);
	}
	readonly announce = async (peerId: string, ref: BlobRef, scope: BlobScope): Promise<BlobAnnounceAnswer> => {
		this.calls.push({ peerId, ref, scope });
		const answer = this.answers.get(peerId) ?? 'fetching';
		if (answer === 'unreachable') throw new Error('dial timeout');
		return answer;
	};
	callsTo(peerId: PeerId): number {
		return this.calls.filter(call => call.peerId === peerId.toString()).length;
	}
}

describe('BlobCopyDrain', () => {
	let self: PeerId;
	let peerX: PeerId;
	let peerY: PeerId;
	let libp2p: MockLibp2p;
	let keyNetwork: FakeKeyNetwork;
	let kv: MemoryKVStore;
	let blobs: LocalBlobService;
	let ledger: OwedBlobLedger;
	let announcer: AnnouncerDouble;
	let acceptance: Map<string, BlobAcceptance>;
	let events: BlobDurabilityEvent[];
	let confirmations: Array<{ ref: BlobRef; peerId: string }>;
	let deps: BlobCopyDrainDeps;
	const drains: BlobCopyDrain[] = [];

	/** A running drain whose start pass found nothing to do: every scenario connects its peers and
	 *  records its entry AFTER this, so `checkNow` is the first pass that sees them. (The start pass
	 *  snapshots the connections synchronously inside `start`, and with nobody connected it skips
	 *  before it reads the ledger.) */
	const startDrain = async (config: Partial<BlobCopyDrainConfig> = {}): Promise<BlobCopyDrain> => {
		const drain = new BlobCopyDrain(deps, { debounceMs: 60_000, minIntervalMs: 0, recheckIntervalMs: 0, ...config });
		drains.push(drain);
		await drain.start();
		return drain;
	};

	/** A blob stored and pinned here, with the `owed` hold `NodeBlobService.announce` takes first. */
	const owedBlob = async (seed: number): Promise<BlobRef> => {
		const { ref } = await blobs.put(streamOf(bytesOf(2048, seed)));
		await blobs.holdOwed(ref);
		return ref;
	};

	/** The classes and counts the listeners saw, in order — `local/1of3`, and so on. */
	const seen = (): string[] =>
		events.map(event => `${event.durability.quorum}/${event.durability.confirmed}of${event.durability.accepting}`);

	const holdKinds = async (ref: BlobRef): Promise<string[] | undefined> =>
		(await new BlobRecordStore(kv).get(ref))?.holds.map(hold => hold.kind);

	beforeEach(async () => {
		[self, peerX, peerY] = await Promise.all([makePeerId(), makePeerId(), makePeerId()]);
		libp2p = new MockLibp2p({ protocols: [buildBlobProtocol(PREFIX)] });
		libp2p.peerId = self;
		keyNetwork = new FakeKeyNetwork();
		kv = new MemoryKVStore();
		// Sweeps never fire on a timer, so no scenario's record is swept out from under it.
		blobs = new LocalBlobService({ pieces: new MemoryPieceStore(), kv, setTimer: () => () => undefined });
		ledger = new OwedBlobLedger(kv);
		announcer = new AnnouncerDouble();
		acceptance = new Map();
		events = [];
		confirmations = [];
		blobs.onDurability(event => { events.push(event); });
		deps = {
			libp2p: libp2p as unknown as DrainLibp2p,
			selfId: self.toString(),
			hold: 'eager',
			keyNetwork,
			partitionDetector: { detectPartition: () => false },
			blobProtocol: buildBlobProtocol(PREFIX),
			ledger,
			records: blobs,
			announce: announcer.announce,
			acceptance: async peerIds => Object.fromEntries(peerIds.map(id => [id, acceptance.get(id) ?? 'accepts'])),
			onHolderConfirmed: (ref, peerId) => { confirmations.push({ ref, peerId }); },
		};
	});

	afterEach(async () => {
		await Promise.all(drains.splice(0).map(drain => drain.stop()));
		await blobs.stop();
	});

	it('reports local, then majority, then full as the other members take the blob, and then stops owing it', async () => {
		const ref = await owedBlob(1);
		keyNetwork.setCohort([self.toString(), peerX.toString(), peerY.toString()]);
		const drain = await startDrain();
		libp2p.connect(peerX, { emit: false });
		libp2p.connect(peerY, { emit: false });

		await drain.owe(ref, SCOPE);

		expect(seen(), 'the first event fires from `owe`, before any pass').to.deep.equal(['local/1of3']);
		expect(await ledger.get(ref)).to.include({ ref, scope: SCOPE });

		announcer.answer(peerX, 'whole');
		announcer.answer(peerY, 'fetching');
		const pass = await drain.checkNow();

		expect(announcer.calls.map(call => call.peerId), 'one round trip to each owed member').to.have.members([peerX.toString(), peerY.toString()]);
		expect(pass.tallies).to.include({ announced: 1, full: 0 });
		expect(seen(), 'the member that answered whole is counted at once').to.deep.equal(['local/1of3', 'majority/2of3']);
		expect((await ledger.get(ref))?.holders, 'a `fetching` records nothing — its `held` will come').to.deep.equal([peerX.toString()]);

		await drain.noteHeld(peerY.toString(), ref);

		expect(seen()).to.deep.equal(['local/1of3', 'majority/2of3', 'full/3of3']);
		expect(confirmations, 'both the `whole` answer and the `held` frame confirm a holder').to.deep.equal([
			{ ref, peerId: peerX.toString() }, { ref, peerId: peerY.toString() }
		]);
		expect(await ledger.get(ref), 'the entry is gone').to.equal(undefined);
		expect(await holdKinds(ref), 'the `owed` hold is released; this blob is still pinned here').to.deep.equal(['pin']);
		expect(await blobs.durabilityOf(ref), 'the record keeps the full class it reached').to.include({ quorum: 'full' });
	});

	it('neither announces to nor counts a member that declined or that refuses the protocol, and keeps owing the blob', async () => {
		const ref = await owedBlob(2);
		// peerY's record says it does not run the blob protocol; peerX will decline for itself.
		acceptance.set(peerY.toString(), 'refuses');
		keyNetwork.setCohort([self.toString(), peerX.toString(), peerY.toString()]);
		announcer.answer(peerX, 'declined');
		const drain = await startDrain();
		libp2p.connect(peerX, { emit: false });
		libp2p.connect(peerY, { emit: false });

		await drain.owe(ref, SCOPE);
		expect(seen(), 'a member that refuses the protocol is not among the accepting').to.deep.equal(['local/1of2']);

		await drain.checkNow();

		expect(announcer.calls.map(call => call.peerId), 'only the member that might take it was asked').to.deep.equal([peerX.toString()]);
		expect(drain.isDeclining(peerX.toString()), 'its answer is remembered').to.equal(true);

		const second = await drain.checkNow();

		expect(announcer.callsTo(peerX), 'a declining peer is not asked again').to.equal(1);
		expect(second.tallies).to.include({ solo: 1, announced: 0 });
		expect(seen().at(-1), 'nobody else accepts blobs, so the blob stays local').to.equal('local/1of1');
		expect(await ledger.get(ref), 'the entry and the `owed` hold are kept').to.not.equal(undefined);
		expect(await holdKinds(ref)).to.have.members(['pin', 'owed']);

		// Only a reconnection clears the memory: the answer was about the peer's own policy, which
		// nothing short of it restarting can change.
		libp2p.connect(peerX);
		expect(drain.isDeclining(peerX.toString())).to.equal(false);
		await drain.checkNow();

		expect(announcer.callsTo(peerX), 'asked once more now its connection has reopened').to.equal(2);
	});

	it('counts a not-responsible answer against the give-up rule, and asks again only once the peer reconnects', async () => {
		const ref = await owedBlob(3);
		keyNetwork.setCohort([self.toString(), peerX.toString()]);
		announcer.answer(peerX, 'not-responsible');
		const drain = await startDrain({ maxAttempts: 2 });
		libp2p.connect(peerX, { emit: false });
		await drain.owe(ref, SCOPE);

		const first = await drain.checkNow();

		expect(first.abandoned, 'one round short of the bound').to.equal(0);
		expect(drain.isDeclining(peerX.toString()), 'a differing view of the cohort is not a refusal of blobs').to.equal(false);

		const second = await drain.checkNow();

		expect(second).to.include({ abandoned: 1 });
		expect(announcer.callsTo(peerX)).to.equal(2);

		const third = await drain.checkNow();

		expect(announcer.callsTo(peerX), 'given up on for this blob').to.equal(2);
		expect(third.tallies).to.include({ waiting: 1, announced: 0 });
		expect(drain.getDiagnostics()).to.include({ abandonedPairs: 1 });

		libp2p.connect(peerX);
		await drain.checkNow();

		expect(announcer.callsTo(peerX), 'a peer that comes back is retried from scratch').to.equal(3);
		expect(await ledger.get(ref), 'nothing was given up on but the peer: the blob is still owed').to.not.equal(undefined);
	});
});
