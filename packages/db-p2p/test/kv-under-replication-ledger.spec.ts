/**
 * Ticket: under-replication-ledger-records-missing-holders.
 *
 * The ledger is the durable half of "who is still missing this block": `CoordinatorRepo.commit`
 * writes it at the moment it answers a writer below full replication, and a drain reads it later.
 * These specs pin the ledger's own rules over the in-memory key-value store. The coordinator's use of
 * it lives in `coordinator-repo-write-durability.spec.ts`, and restart survival over the filesystem
 * store lives in `db-p2p-storage-fs`, which owns `FileKVStore`.
 */

import { expect } from 'chai';
import type { BlockId } from '@optimystic/db-core';
import { KvUnderReplicationLedger, UNDER_REPLICATED_KEY_PREFIX } from '../src/repo/kv-under-replication-ledger.js';
import type { UnderReplicatedEntry } from '../src/repo/i-under-replication-ledger.js';
import { MemoryKVStore } from '../src/storage/memory-kv-store.js';
import type { IKVStore } from '../src/storage/i-kv-store.js';
import { captureLog, hasTag } from './support/capture-log.js';

const BLOCK_A = 'ledger-block-a' as BlockId;
const BLOCK_B = 'ledger-block-b' as BlockId;
const BLOCK_C = 'ledger-block-c' as BlockId;

const entry = (overrides: Partial<UnderReplicatedEntry> = {}): UnderReplicatedEntry => ({
	blockId: BLOCK_A,
	rev: 3,
	actionId: 'action-3',
	quorum: 'majority',
	missingPeerIds: ['peer-x', 'peer-y'],
	recordedAt: 1_000,
	attempts: 0,
	...overrides
});

/**
 * A key-value store whose first `get` of `slowKey` reads the value immediately but does not hand it
 * back until `release()` — a slow reader holding a stale view, which is what forces the interleaving.
 */
class GatedKVStore extends MemoryKVStore {
	private gate: Promise<void> | undefined;
	release: () => void = () => { };

	constructor(private readonly slowKey: string) {
		super();
		this.gate = new Promise(resolve => { this.release = resolve; });
	}

	override async get(key: string): Promise<string | undefined> {
		const value = await super.get(key);
		if (key === this.slowKey && this.gate !== undefined) {
			const gate = this.gate;
			this.gate = undefined;
			await gate;
		}
		return value;
	}
}

describe('KvUnderReplicationLedger', () => {
	let kv: MemoryKVStore;
	let ledger: KvUnderReplicationLedger;
	beforeEach(() => {
		kv = new MemoryKVStore();
		ledger = new KvUnderReplicationLedger(kv);
	});

	describe('recording and reading', () => {
		it('reads back what was recorded, under the fixed key prefix', async () => {
			await ledger.record(entry());

			expect(await ledger.get(BLOCK_A)).to.deep.equal(entry());
			expect(await kv.list(UNDER_REPLICATED_KEY_PREFIX)).to.deep.equal([`${UNDER_REPLICATED_KEY_PREFIX}${BLOCK_A}`]);
		});

		it('answers undefined for a block it never recorded', async () => {
			expect(await ledger.get(BLOCK_A)).to.equal(undefined);
		});

		it('lists every outstanding entry, oldest recordedAt first', async () => {
			await ledger.record(entry({ blockId: BLOCK_A, recordedAt: 3_000 }));
			await ledger.record(entry({ blockId: BLOCK_B, recordedAt: 1_000 }));
			await ledger.record(entry({ blockId: BLOCK_C, recordedAt: 2_000 }));

			expect((await ledger.list()).map(e => e.blockId)).to.deep.equal([BLOCK_B, BLOCK_C, BLOCK_A]);
		});

		it('keeps an unknown missing set (local / unrouted) as an empty array', async () => {
			await ledger.record(entry({ quorum: 'unrouted', missingPeerIds: [] }));

			expect((await ledger.get(BLOCK_A))?.missingPeerIds).to.deep.equal([]);
		});
	});

	describe('one entry per block, at the highest revision', () => {
		it('a higher revision replaces the entry, resetting attempts and recordedAt', async () => {
			await ledger.record(entry({ rev: 3, recordedAt: 1_000 }));
			await ledger.noteAttempt(BLOCK_A);
			await ledger.noteAttempt(BLOCK_A);

			await ledger.record(entry({ rev: 4, actionId: 'action-4', missingPeerIds: ['peer-z'], recordedAt: 5_000 }));

			expect(await ledger.get(BLOCK_A)).to.deep.equal(entry({ rev: 4, actionId: 'action-4', missingPeerIds: ['peer-z'], recordedAt: 5_000, attempts: 0 }));
		});

		it('a lower revision is skipped, so a slow older commit cannot clobber a newer one', async () => {
			await ledger.record(entry({ rev: 5, actionId: 'action-5' }));

			const captured = await captureLog('under-replication-ledger', async () => {
				await ledger.record(entry({ rev: 4, actionId: 'action-4', missingPeerIds: ['peer-z'] }));
			});

			expect((await ledger.get(BLOCK_A))?.rev).to.equal(5);
			expect(hasTag(captured, 'record:skip-lower-rev')).to.equal(true);
		});

		it('the same revision re-observed replaces who is missing but keeps attempts and recordedAt', async () => {
			await ledger.record(entry({ quorum: 'local', missingPeerIds: [], recordedAt: 1_000 }));
			await ledger.noteAttempt(BLOCK_A);

			await ledger.record(entry({ quorum: 'local', missingPeerIds: ['peer-x'], recordedAt: 9_000 }));

			expect(await ledger.get(BLOCK_A)).to.deep.equal(entry({ quorum: 'local', missingPeerIds: ['peer-x'], recordedAt: 1_000, attempts: 1 }));
		});

		it('concurrent records for one block are applied in call order, so the newer revision survives a slow older read', async () => {
			// The older commit's read of the entry is held open while the newer one records. Without
			// per-block ordering the older write would land last and lower the recorded revision.
			const gated = new GatedKVStore(`${UNDER_REPLICATED_KEY_PREFIX}${BLOCK_A}`);
			const racing = new KvUnderReplicationLedger(gated);

			const older = racing.record(entry({ rev: 4, actionId: 'action-4' }));
			const newer = racing.record(entry({ rev: 5, actionId: 'action-5' }));
			await new Promise(resolve => setTimeout(resolve, 10));
			gated.release();
			await Promise.all([older, newer]);

			expect((await racing.get(BLOCK_A))?.rev).to.equal(5);
		});
	});

	describe('settling on full replication', () => {
		it('deletes an entry at a lower revision', async () => {
			await ledger.record(entry({ rev: 3 }));

			await ledger.settle(BLOCK_A, 4);

			expect(await ledger.get(BLOCK_A)).to.equal(undefined);
		});

		it('deletes an entry at the same revision', async () => {
			await ledger.record(entry({ rev: 3 }));

			await ledger.settle(BLOCK_A, 3);

			expect(await ledger.get(BLOCK_A)).to.equal(undefined);
		});

		it('keeps an entry recording a higher revision — an older commit finishing settles nothing newer', async () => {
			await ledger.record(entry({ rev: 5 }));

			await ledger.settle(BLOCK_A, 4);

			expect((await ledger.get(BLOCK_A))?.rev).to.equal(5);
		});

		it('is a no-op for a block with no entry', async () => {
			await ledger.settle(BLOCK_A, 4);

			expect(await ledger.list()).to.deep.equal([]);
		});
	});

	describe('satisfy, noteAttempt and delete', () => {
		it('removing one of two missing peers leaves the entry naming the other', async () => {
			await ledger.record(entry());

			const remaining = await ledger.satisfy(BLOCK_A, ['peer-x']);

			expect(remaining?.missingPeerIds).to.deep.equal(['peer-y']);
			expect(await ledger.get(BLOCK_A)).to.deep.equal(remaining);
		});

		it('removing the last missing peer deletes the entry', async () => {
			await ledger.record(entry());
			await ledger.satisfy(BLOCK_A, ['peer-x']);

			const remaining = await ledger.satisfy(BLOCK_A, ['peer-y']);

			expect(remaining).to.equal(undefined);
			expect(await ledger.get(BLOCK_A)).to.equal(undefined);
			expect(await ledger.list()).to.deep.equal([]);
		});

		it('an entry whose missing set is unknown is not satisfied peer by peer', async () => {
			await ledger.record(entry({ quorum: 'local', missingPeerIds: [] }));

			const remaining = await ledger.satisfy(BLOCK_A, ['peer-x']);

			expect(remaining, 'unknown is not empty').to.deep.equal(entry({ quorum: 'local', missingPeerIds: [] }));
			expect(await ledger.get(BLOCK_A)).to.not.equal(undefined);
		});

		it('satisfying peers the entry never named changes nothing', async () => {
			await ledger.record(entry());

			expect(await ledger.satisfy(BLOCK_A, ['peer-q'])).to.deep.equal(entry());
		});

		it('noteAttempt increments the give-up counter, and is a no-op for an absent entry', async () => {
			await ledger.record(entry());

			await ledger.noteAttempt(BLOCK_A);
			await ledger.noteAttempt(BLOCK_A);
			await ledger.noteAttempt(BLOCK_B);

			expect((await ledger.get(BLOCK_A))?.attempts).to.equal(2);
			expect(await ledger.get(BLOCK_B)).to.equal(undefined);
		});

		it('delete removes the entry', async () => {
			await ledger.record(entry());

			await ledger.delete(BLOCK_A);

			expect(await ledger.get(BLOCK_A)).to.equal(undefined);
		});
	});

	describe('the maxEntries backstop', () => {
		it('evicts the oldest-recorded entry once the cap is exceeded, and logs it', async () => {
			const capped = new KvUnderReplicationLedger(kv, { maxEntries: 2 });
			await capped.record(entry({ blockId: BLOCK_A, recordedAt: 1 }));
			await capped.record(entry({ blockId: BLOCK_B, recordedAt: 2 }));

			const captured = await captureLog('under-replication-ledger', async () => {
				await capped.record(entry({ blockId: BLOCK_C, recordedAt: 3 }));
			});

			expect((await capped.list()).map(e => e.blockId)).to.deep.equal([BLOCK_B, BLOCK_C]);
			expect(hasTag(captured, 'evict:over-cap')).to.equal(true);
		});

		it('a block re-recorded at a higher revision becomes the newest, so the other entry is evicted', async () => {
			const capped = new KvUnderReplicationLedger(kv, { maxEntries: 2 });
			await capped.record(entry({ blockId: BLOCK_A, rev: 3, recordedAt: 1 }));
			await capped.record(entry({ blockId: BLOCK_B, rev: 3, recordedAt: 2 }));
			await capped.record(entry({ blockId: BLOCK_A, rev: 4, recordedAt: 3 }));

			await capped.record(entry({ blockId: BLOCK_C, rev: 3, recordedAt: 4 }));

			expect((await capped.list()).map(e => e.blockId)).to.deep.equal([BLOCK_A, BLOCK_C]);
		});

		it('an instance over a store that already holds entries evicts by their recordedAt', async () => {
			await ledger.record(entry({ blockId: BLOCK_B, recordedAt: 20 }));
			await ledger.record(entry({ blockId: BLOCK_A, recordedAt: 10 }));
			const reopened = new KvUnderReplicationLedger(kv, { maxEntries: 2 });

			await reopened.record(entry({ blockId: BLOCK_C, recordedAt: 30 }));

			expect((await reopened.list()).map(e => e.blockId)).to.deep.equal([BLOCK_B, BLOCK_C]);
		});

		it('concurrent new records at the cap evict only the overflow', async () => {
			const capped = new KvUnderReplicationLedger(kv, { maxEntries: 2 });
			await capped.record(entry({ blockId: BLOCK_A, recordedAt: 1 }));
			await capped.record(entry({ blockId: BLOCK_B, recordedAt: 2 }));
			const blockD = 'ledger-block-d' as BlockId;

			await Promise.all([
				capped.record(entry({ blockId: BLOCK_C, recordedAt: 3 })),
				capped.record(entry({ blockId: blockD, recordedAt: 4 }))
			]);

			expect((await capped.list()).map(e => e.blockId)).to.deep.equal([BLOCK_C, blockD]);
		});

		it('refuses a cap below one', () => {
			expect(() => new KvUnderReplicationLedger(kv, { maxEntries: 0 })).to.throw(/maxEntries/);
		});
	});

	describe('stored bytes it did not expect', () => {
		it('reads an unparseable entry as absent, logs it, and lets a new record overwrite it', async () => {
			await kv.set(`${UNDER_REPLICATED_KEY_PREFIX}${BLOCK_A}`, '{not json');

			const captured = await captureLog('under-replication-ledger', async () => {
				expect(await ledger.get(BLOCK_A)).to.equal(undefined);
				expect(await ledger.list()).to.deep.equal([]);
			});
			await ledger.record(entry());

			expect(hasTag(captured, 'read:unparseable')).to.equal(true);
			expect(await ledger.get(BLOCK_A)).to.deep.equal(entry());
		});

		it('reads an entry stored under another block id as absent', async () => {
			await kv.set(`${UNDER_REPLICATED_KEY_PREFIX}${BLOCK_A}`, JSON.stringify(entry({ blockId: BLOCK_B })));

			const captured = await captureLog('under-replication-ledger', async () => {
				expect(await ledger.get(BLOCK_A)).to.equal(undefined);
			});

			expect(hasTag(captured, 'read:malformed')).to.equal(true);
		});

		it('reads an entry claiming a full quorum as absent — full owes nobody', async () => {
			await kv.set(`${UNDER_REPLICATED_KEY_PREFIX}${BLOCK_A}`, JSON.stringify({ ...entry(), quorum: 'full' }));

			expect(await ledger.get(BLOCK_A)).to.equal(undefined);
		});
	});

	it('a store failure surfaces to the caller rather than being swallowed', async () => {
		const failing: IKVStore = {
			get: async () => undefined,
			set: async () => { throw new Error('disk full'); },
			delete: async () => { },
			list: async () => []
		};

		let thrown: unknown;
		try {
			await new KvUnderReplicationLedger(failing).record(entry());
		} catch (err) {
			thrown = err;
		}

		expect((thrown as Error)?.message).to.equal('disk full');
	});
});
