/**
 * `BlobAnnounceReceiver.decide` (docs/blobs.md §Who may fetch and who may store): the answers it
 * reaches before it would pull anything, who is told once the pull it started finishes, and the two
 * allowances that bound how much work announcements can ask of a node. The two-node spec
 * (`blob-announce.spec.ts`) pins the round trip, the hold and the pull over real nodes.
 */
import { expect } from 'chai';
import { BlobReferenceTree, BlobScopeRegistry, buildBlob, type BlobRef, type BlobScope, type ClusterPeers } from '@optimystic/db-core';
import { TestTransactor } from '@optimystic/db-core/test';
import { AnnounceLimiter, READ_ABANDONED } from '../src/blob/announce-limiter.js';
import { BlobAnnounceReceiver, type BlobAnnounceReceiverDeps, type BlobHoldPolicy } from '../src/blob/announce-receiver.js';
import { LocalBlobService } from '../src/blob/local-blob-service.js';
import { MemoryPieceStore } from '../src/blob/memory-piece-store.js';
import { BlobReferenceCheck } from '../src/blob/reference-check.js';
import { MemoryKVStore } from '../src/storage/memory-kv-store.js';
import { streamOf } from './support/blob-mesh.js';

const SELF = 'self-peer';
const ANNOUNCER = 'announcing-peer';
/** Two announcers that `peerIdFromString` accepts, which `held` is addressed by. */
const FIRST_ANNOUNCER = '12D3KooWMA6D9eu8eHzJh51wVsUZNwMvFz6qJYMGNiFvNZQ2nVu7';
const SECOND_ANNOUNCER = '12D3KooWCSmJ3QFX5SdBVYoygj9WoEsS828rickkyuitL6gcCrSg';
const REGISTERED: BlobScope = 'app/photos/blobrefs';
const UNREGISTERED: BlobScope = 'app/drafts/blobrefs';

interface ReceiverOver {
	hold: BlobHoldPolicy;
	cohort: readonly string[];
	fetcher?: BlobAnnounceReceiverDeps['fetcher'];
	client?: BlobAnnounceReceiverDeps['client'];
	/** Default: no reading at all, which is what a node that cannot measure its storage behaves as. */
	storagePressure?: BlobAnnounceReceiverDeps['storagePressure'];
}

/** Lets the pending microtasks of a call under test run before the next assertion. */
function tick(): Promise<void> {
	return new Promise<void>(resolve => { setTimeout(resolve, 0); });
}

/** The receiver under test, with the reference listed in {@link REGISTERED} in committed state. */
async function receiverOver(over: ReceiverOver): Promise<{ receiver: BlobAnnounceReceiver; local: LocalBlobService; ref: BlobRef }> {
	const net = new TestTransactor();
	const { ref } = await buildBlob(streamOf(new Uint8Array([7, 7, 7])), { put: async () => undefined });
	await BlobScopeRegistry.register(net, REGISTERED);
	const references = await BlobReferenceTree.createOrOpen(net, REGISTERED);
	await references.stageAdd(ref, 'row-1');
	await references.tree.sync();
	const local = new LocalBlobService({ pieces: new MemoryPieceStore(), kv: new MemoryKVStore(), setTimer: () => () => undefined });
	const receiver = new BlobAnnounceReceiver({
		selfId: SELF,
		hold: over.hold,
		keyNetwork: {
			findCluster: async (): Promise<ClusterPeers> => Object.fromEntries(over.cohort.map(peer => [peer, { multiaddrs: [], publicKey: '' }])),
		},
		limiter: new AnnounceLimiter(),
		references: new BlobReferenceCheck({ transactor: net }),
		local,
		fetcher: over.fetcher ?? { start: () => { throw new Error('no answer in this spec starts a pull'); } },
		client: over.client ?? { held: () => Promise.reject(new Error('no answer in this spec sends held')) },
		...(over.storagePressure ? { storagePressure: over.storagePressure } : {}),
		answerWithinMs: 1_000,
		// No answer here waits on the budget, so a timer that never fires keeps the spec off the clock.
		setTimer: () => () => undefined,
	});
	return { receiver, local, ref };
}

describe('blob announce receiver', () => {
	it('answers without pulling, and takes no responsible hold, where the decision is already made', async () => {
		const cases: readonly { what: string; hold: BlobHoldPolicy; cohort: readonly string[]; scope: BlobScope; answer: string }[] = [
			{ what: 'an on-demand node declines before any lookup', hold: 'on-demand', cohort: [SELF], scope: REGISTERED, answer: 'declined' },
			{ what: 'a node outside its own view of the cohort is not responsible', hold: 'eager', cohort: [ANNOUNCER], scope: REGISTERED, answer: 'not-responsible' },
			{ what: 'a scope the registry does not list is unreferenced', hold: 'eager', cohort: [SELF], scope: UNREGISTERED, answer: 'unreferenced' },
		];
		for (const { what, hold, cohort, scope, answer } of cases) {
			const { receiver, local, ref } = await receiverOver({ hold, cohort });
			expect(await receiver.decide(ANNOUNCER, ref, scope), what).to.equal(answer);
			expect(await local.responsibleScope(ref), `${what}: no responsible hold`).to.equal(undefined);
		}
	});

	it('takes no responsible hold on a blob its own read brought here when it has no room', async () => {
		// The reader repair is the one path that would make a full node fuller WITHOUT writing a byte: the
		// blob is already here under the fetch's `cached` hold, and the `responsible` hold would move it
		// out of the reach of the cache enforcement the same `refusing` sample triggers. So it reads the
		// same answer the announcement door reads, and the two cannot disagree about taking a hold.
		//
		// The node WITH room is the control: it proves the repair really ran to its write in this harness,
		// so the refusing case is the guard's doing and not a repair that never got that far.
		const cases: readonly { what: string; refusing: boolean; scope: BlobScope | undefined }[] = [
			{ what: 'a node with room keeps what it read', refusing: false, scope: REGISTERED },
			{ what: 'a node with no room takes no hold', refusing: true, scope: undefined },
		];
		for (const { what, refusing, scope } of cases) {
			const { receiver, local, ref } = await receiverOver({
				hold: 'eager',
				cohort: [SELF],
				storagePressure: { refusingNewData: () => refusing },
			});

			receiver.keepAfterRead(ref);
			await tick();

			expect(await local.responsibleScope(ref), what).to.equal(scope);
		}
	});

	it('runs one pull for a reference two peers announce, and tells both of them once it has it', async () => {
		let starts = 0;
		let finishPull!: () => void;
		const pulled = new Promise<void>(resolve => { finishPull = resolve; });
		const told: string[] = [];
		const { receiver, ref } = await receiverOver({
			hold: 'eager',
			cohort: [SELF],
			fetcher: {
				start: () => {
					starts++;
					return { done: pulled, stored: () => Promise.reject(new Error('this spec consumes no pieces')) };
				},
			},
			client: { held: async peer => { told.push(peer.toString()); } },
		});

		expect(await receiver.decide(FIRST_ANNOUNCER, ref, REGISTERED), 'the first announcer').to.equal('fetching');
		expect(await receiver.decide(SECOND_ANNOUNCER, ref, REGISTERED), 'the second announcer joins the pull').to.equal('fetching');
		expect(starts, 'one pull however many peers announced it').to.equal(1);
		expect(told, 'nobody is told while the pull is running').to.deep.equal([]);

		finishPull();
		await tick();
		expect([...told].sort(), 'both announcers told, once each').to.deep.equal([FIRST_ANNOUNCER, SECOND_ANNOUNCER].sort());
	});
});

describe('blob announce limiter', () => {
	it('admits one peer its allowance a minute, then again in the next window, without touching another peer', () => {
		let now = 1_000;
		const limiter = new AnnounceLimiter({ perPeerPerMinute: 600, now: () => now });

		for (let sent = 0; sent < 600; sent++) {
			expect(limiter.admit(ANNOUNCER), `announcement ${sent + 1}`).to.equal(true);
		}
		expect(limiter.admit(ANNOUNCER), 'the 601st in the window').to.equal(false);
		expect(limiter.admit('another-peer'), 'a second peer has its own window').to.equal(true);

		now += 60_000;
		expect(limiter.admit(ANNOUNCER), 'the first of the next window').to.equal(true);
	});

	it('drops a queued read whose caller gave up, and passes the slot to the one behind it', async () => {
		const limiter = new AnnounceLimiter({ readsInFlight: 1 });
		const ran: string[] = [];
		let releaseRunning!: () => void;
		const running = limiter.readSlot(() => {
			ran.push('running');
			return new Promise<string>(resolve => { releaseRunning = () => resolve('running'); });
		});
		const gaveUp = new AbortController();
		const abandoned = limiter.readSlot(() => { ran.push('abandoned'); return Promise.resolve('abandoned'); }, gaveUp.signal);
		const behind = limiter.readSlot(() => { ran.push('behind'); return Promise.resolve('behind'); });
		await tick();
		expect(ran, 'the one slot is taken, so the other two wait').to.deep.equal(['running']);

		gaveUp.abort();
		// Raced, so a read left in the queue is a failed assertion rather than a hung spec.
		expect(await Promise.race([abandoned, tick().then(() => 'still queued')]),
			'the read its caller gave up on is answered at once, unrun').to.equal(READ_ABANDONED);

		releaseRunning();
		expect(await running).to.equal('running');
		expect(await behind).to.equal('behind');
		expect(ran, 'the freed slot skipped the abandoned read').to.deep.equal(['running', 'behind']);
	});
});
