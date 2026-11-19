/**
 * `BlobAnnounceReceiver.decide` (docs/blobs.md §Who may fetch and who may store): the answers it
 * reaches before it would pull anything, and the per-peer allowance that bounds how much reading of
 * committed state one peer can ask for. The two-node spec (`blob-announce.spec.ts`) pins the round
 * trip, the hold and the pull over real nodes.
 */
import { expect } from 'chai';
import { BlobReferenceTree, BlobScopeRegistry, buildBlob, type BlobRef, type BlobScope, type ClusterPeers } from '@optimystic/db-core';
import { TestTransactor } from '@optimystic/db-core/test';
import { AnnounceLimiter } from '../src/blob/announce-limiter.js';
import { BlobAnnounceReceiver, type BlobHoldPolicy } from '../src/blob/announce-receiver.js';
import { LocalBlobService } from '../src/blob/local-blob-service.js';
import { MemoryPieceStore } from '../src/blob/memory-piece-store.js';
import { BlobReferenceCheck } from '../src/blob/reference-check.js';
import { MemoryKVStore } from '../src/storage/memory-kv-store.js';
import { streamOf } from './support/blob-mesh.js';

const SELF = 'self-peer';
const ANNOUNCER = 'announcing-peer';
const REGISTERED: BlobScope = 'app/photos/blobrefs';
const UNREGISTERED: BlobScope = 'app/drafts/blobrefs';

/** The receiver under test, with the reference listed in {@link REGISTERED} in committed state. */
async function receiverOver(hold: BlobHoldPolicy, cohort: readonly string[]): Promise<{ receiver: BlobAnnounceReceiver; local: LocalBlobService; ref: BlobRef }> {
	const net = new TestTransactor();
	const { ref } = await buildBlob(streamOf(new Uint8Array([7, 7, 7])), { put: async () => undefined });
	await BlobScopeRegistry.register(net, REGISTERED);
	const references = await BlobReferenceTree.createOrOpen(net, REGISTERED);
	await references.stageAdd(ref, 'row-1');
	await references.tree.sync();
	const local = new LocalBlobService({ pieces: new MemoryPieceStore(), kv: new MemoryKVStore(), setTimer: () => () => undefined });
	const receiver = new BlobAnnounceReceiver({
		selfId: SELF,
		hold,
		keyNetwork: {
			findCluster: async (): Promise<ClusterPeers> => Object.fromEntries(cohort.map(peer => [peer, { multiaddrs: [], publicKey: '' }])),
		},
		limiter: new AnnounceLimiter(),
		references: new BlobReferenceCheck({ transactor: net }),
		local,
		fetcher: { start: () => { throw new Error('no answer in this spec starts a pull'); } },
		client: { held: () => Promise.reject(new Error('no answer in this spec sends held')) },
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
			const { receiver, local, ref } = await receiverOver(hold, cohort);
			expect(await receiver.decide(ANNOUNCER, ref, scope), what).to.equal(answer);
			expect(await local.responsibleScope(ref), `${what}: no responsible hold`).to.equal(undefined);
		}
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
});
