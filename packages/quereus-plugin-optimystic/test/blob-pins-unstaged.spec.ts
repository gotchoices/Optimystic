/**
 * The holding period on a blob put outside any transaction and never referenced
 * (docs/blobs.md §SQL "A put outside a transaction"; docs/internals.md §A table's blob references).
 *
 * The rule these hold: a put made with no transaction open is pinned `sql-unstaged/<putAtMs>` and
 * nothing but a commit that references the blob releases that pin — so an application that puts a
 * file and then never inserts anything (the user cancelled the upload, the statement failed, the
 * process stopped) would hold those bytes for ever. `SqlBlobPins.sweepUnstaged` bounds it: past
 * `blob_unstaged_holding_ms` the pin is released and the writer's piece sweep takes the bytes.
 *
 * Three cases. The first is the period itself, driven on both sides of the boundary. The second is
 * the protection that is the whole reason the rule is not just "older than the period": a reference
 * some unfinished transaction is relying on is never expired, however old its pin. It is driven
 * through a QUEUED transaction, which is live for as long as it sits in the queue with no SQL
 * transaction open — the one way a spec can watch a sweep run while a transaction still owes a
 * reference, since the sweep's own work chain waits for an OPEN transaction to end before it looks.
 *
 * That protection has a second half no spec can watch directly, for the same reason: the references
 * a statement has staged and whose commit has not yet pinned them, which only the open transaction's
 * own ledger knows (`TransactionBridge.openBlobReferences`). What the THIRD case drives is the half
 * of it that can go wrong in the quiet direction — the `isActive` guard. The bridge keeps a
 * transaction, and so its ledger, until the next `begin`, so without that guard a reference a
 * rolled-back insert staged would read as still owed for ever and its pin could never expire, which
 * is exactly the leak this sweep exists to close.
 *
 * By inspection: the arm that leaves an `unstaged` label this build cannot read pinned for ever, and
 * the clock-moved-backwards arm, which is the boundary case below with the comparison the other way
 * round.
 *
 * Every sweep here is driven by hand with an explicit `now`, so no case waits on the plugin's own
 * interval — which, at the default 24-hour holding period, is an hour.
 *
 * Everything shared — the stores, the handles, the pin rendering — is `blob-pins-harness.ts`. The
 * online arms are `blob-pins-online.spec.ts`, the queued ones `blob-pins-queued.spec.ts` and the
 * restart ones `blob-pins-reconcile.spec.ts`.
 */

import { expect } from 'chai';
import type { BlobRef } from '@optimystic/db-core';
import {
	DEFAULT_UNSTAGED_HOLDING_MS, TRANSACTION_PIN_PREFIX, UNSTAGED_PIN_PREFIX, parsePinLabel,
	transactionReferencePinLabel,
} from '../dist/index.js';
import {
	allPins, closePlugin, createStores, openPlugin, pinsOn, putBlob, referencesInTree, scopeOf,
	soleQueuedEntry, transactorOf, type PluginHandle,
} from './blob-pins-harness.js';
// From `src`, as `cost-profile.spec.ts` reads its own parse: a pure function with no state to share
// with the plugin handles above, and not part of the package's public surface.
import { parseUnstagedHoldingMs } from '../src/optimystic-adapter/blob-pins.js';

const TABLE_DDL = (uri: string) =>
	`create table T (Id integer primary key, R blobref null) using optimystic('${uri}')`;

/**
 * When the `unstaged` pin on `ref` was taken, read back out of its own label — the only record of
 * it, and what the holding period is measured from. Fails loudly for a reference holding no such
 * pin, so a case that expected one does not silently assert about a time nothing wrote.
 */
async function unstagedPutAt(handle: PluginHandle, ref: BlobRef): Promise<number> {
	const labels = await handle.plugin.blobs.pinsOf(ref);
	const times = labels
		.map(label => parsePinLabel(label))
		.filter(parsed => parsed?.kind === 'unstaged')
		.map(parsed => (parsed as { putAtMs: number }).putAtMs);
	expect(times, `exactly one unstaged pin on ${ref}`).to.have.lengthOf(1);
	return times[0]!;
}

describe('an unreferenced blob put outside a transaction is released after its holding period', function () {
	this.timeout(30_000);

	it('keeps the pin up to the holding period and releases it past it', async () => {
		const uri = 'tree://blobpins-unstaged/boundary';
		const stores = createStores();
		const handle = openPlugin(stores);
		try {
			const { plugin } = handle;
			await handle.db.exec(TABLE_DDL(uri));
			// Put and never referenced: the cancelled upload. Nothing but this sweep ever releases it.
			const ref = await putBlob(handle, 1);
			const putAt = await unstagedPutAt(handle, ref);
			expect(await pinsOn(plugin, ref), 'the put outside a transaction holds its unstaged pin')
				.to.deep.equal(['unstaged']);

			await plugin.blobPins.sweepUnstaged(putAt + DEFAULT_UNSTAGED_HOLDING_MS - 1);

			expect(await pinsOn(plugin, ref), 'one millisecond inside the period, the bytes are still held')
				.to.deep.equal(['unstaged']);

			await plugin.blobPins.sweepUnstaged(putAt + DEFAULT_UNSTAGED_HOLDING_MS + 1);

			expect(await pinsOn(plugin, ref),
				'past the period the pin goes, and the writer\'s next piece sweep takes the bytes')
				.to.deep.equal([]);
			expect(await allPins(plugin, UNSTAGED_PIN_PREFIX),
				'no unstaged pin is left on the machine').to.deep.equal([]);
		} finally {
			await closePlugin(handle);
		}
	});

	it('never expires the pin of a reference a queued transaction is still relying on', async () => {
		const uri = 'tree://blobpins-unstaged/queued';
		const stores = createStores();
		// Unreachable, so the insert's commit is sealed into the queue and stays there: the queued
		// transaction holds its reference pin, and nothing of it has reached the network.
		const handle = openPlugin(stores, { reachable: false });
		try {
			const { db, plugin } = handle;
			await db.exec(TABLE_DDL(uri));
			const abandoned = await putBlob(handle, 2);
			const referenced = await putBlob(handle, 3);
			const putAt = Math.max(await unstagedPutAt(handle, abandoned), await unstagedPutAt(handle, referenced));
			const expired = putAt + DEFAULT_UNSTAGED_HOLDING_MS + 1;

			plugin.offline.enter();
			await db.exec(`insert into T (Id, R) values (1, '${referenced}')`);
			const transactionId = soleQueuedEntry(plugin);
			expect(await allPins(plugin, TRANSACTION_PIN_PREFIX),
				'the queued transaction holds the reference pin whose liveness protects the put')
				.to.deep.equal([`${referenced} ${transactionReferencePinLabel(transactionId, scopeOf(uri))}`]);
			expect(await pinsOn(plugin, referenced),
				'the queued transaction holds its reference pin, and the put its unstaged one')
				.to.deep.equal([`ref/${scopeOf(uri)}`, 'unstaged']);

			await plugin.blobPins.sweepUnstaged(expired);

			expect(await pinsOn(plugin, abandoned),
				'the put nothing references is past its period, so its pin goes').to.deep.equal([]);
			expect(await pinsOn(plugin, referenced),
				'the queued transaction can still fail with nothing committed, so this machine keeps the only copy')
				.to.deep.equal([`ref/${scopeOf(uri)}`, 'unstaged']);

			// The queue finishes with the transaction: the reference is announced, which takes the `owed`
			// hold that keeps the bytes here, and its reference pin goes. The `unstaged` pin is NOT
			// dropped by that settlement — only an online commit drops one — so this sweep is what
			// finally releases it, by which time the announcement is the blob's hold.
			plugin.offline.exit();
			handle.gate.open();
			await plugin.offline.whenDrained();
			await plugin.blobPins.settled();
			expect(await pinsOn(plugin, referenced), 'the settled transaction left only the put\'s own pin')
				.to.deep.equal(['unstaged']);

			await plugin.blobPins.sweepUnstaged(expired);

			expect(await allPins(plugin, UNSTAGED_PIN_PREFIX),
				'nothing holds the transaction live any longer, so the last unstaged pin expires too')
				.to.deep.equal([]);
			expect((await plugin.blobs.stat(referenced)).durability?.quorum,
				'the bytes the protection kept are the ones the commit announced; a cohort of this machine alone is `local`')
				.to.equal('local');
			expect(await referencesInTree(await transactorOf(handle, stores), scopeOf(uri)),
				'the committed row still holds the reference').to.deep.equal([referenced]);
		} finally {
			await closePlugin(handle);
		}
	});

	it('expires the pin of a reference only a rolled-back transaction ever staged', async () => {
		const uri = 'tree://blobpins-unstaged/rolled-back';
		const stores = createStores();
		const handle = openPlugin(stores);
		try {
			const { db, plugin } = handle;
			await db.exec(TABLE_DDL(uri));
			const ref = await putBlob(handle, 4);
			const putAt = await unstagedPutAt(handle, ref);

			await db.exec('begin');
			await db.exec(`insert into T (Id, R) values (1, '${ref}')`);
			await db.exec('rollback');
			// The rollback leaves the put's own pin, so an application that retries the insert need
			// not put the bytes again (`blob-pins-online.spec.ts` holds that rule); from there the
			// holding period is the only thing that bounds it.
			expect(await pinsOn(plugin, ref), 'the rollback left the application its own hold')
				.to.deep.equal(['unstaged']);

			await plugin.blobPins.sweepUnstaged(putAt + DEFAULT_UNSTAGED_HOLDING_MS + 1);

			// The ledger of the ended transaction still records the add, and the bridge still holds
			// that transaction: only `openBlobReferences`' `isActive` guard stops it from answering
			// for a reference nothing owes any more.
			expect(await pinsOn(plugin, ref),
				'the transaction has ended, so nothing protects the pin from its period')
				.to.deep.equal([]);
		} finally {
			await closePlugin(handle);
		}
	});
});

/**
 * What `register` does with `blob_unstaged_holding_ms`, one case per branch. The refusal is the
 * load-bearing one: silently ignoring a bad value would keep every unreferenced put for a day when
 * the host asked for a minute, or expire bytes it meant to hold.
 */
describe('parseUnstagedHoldingMs: the holding period a registration declares', () => {
	it('defaults to 24 hours when the config declares nothing', () => {
		expect(parseUnstagedHoldingMs({})).to.equal(DEFAULT_UNSTAGED_HOLDING_MS);
		// What a plugin loader's settings form sends for a field left empty, as for `cost_profile`.
		expect(parseUnstagedHoldingMs({ blob_unstaged_holding_ms: '' })).to.equal(DEFAULT_UNSTAGED_HOLDING_MS);
		expect(parseUnstagedHoldingMs({ blob_unstaged_holding_ms: null })).to.equal(DEFAULT_UNSTAGED_HOLDING_MS);
	});

	it('takes a declared number of milliseconds', () => {
		expect(parseUnstagedHoldingMs({ blob_unstaged_holding_ms: 60_000 })).to.equal(60_000);
	});

	it('refuses anything that is not a finite, positive number', () => {
		for (const declared of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '86400000', true, {}]) {
			expect(() => parseUnstagedHoldingMs({ blob_unstaged_holding_ms: declared }),
				`refuses ${String(declared)}`).to.throw(/blob_unstaged_holding_ms/);
		}
	});
});
