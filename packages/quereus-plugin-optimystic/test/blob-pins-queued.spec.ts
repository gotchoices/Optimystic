/**
 * A QUEUED transaction's blob pins settle with the transaction (docs/blobs.md §SQL "Pins follow the
 * transaction"; docs/offline-sync.md §Persistence).
 *
 * The rule these hold: a commit that reaches the queue instead of the network leaves its reference
 * pins in place on purpose — nothing is on the network yet, so the writer is the only machine
 * holding the bytes — and those pins are settled when the queue finally finishes with the
 * transaction: announced into the table's reference tree and released for the collections that
 * committed, released outright for the ones that did not, so the writer's piece sweep can take the
 * bytes of a transaction that never landed.
 *
 * One case per arm of `SqlBlobPins.settleQueued` with a distinct outcome: a queued transaction that
 * commits, one that is discarded, and one that survives a restart and then commits — which is the
 * arm that reads the pins back from their own LABELS, since the process that settles it is not the
 * process that sealed the entry and so remembers nothing of it. The partial-commit and cascade arms
 * are these same two branches driven by a different `committedCollections`, and are checked by
 * inspection rather than by a fourth harness.
 *
 * Everything shared — the stores, the handles, the restart, the pin rendering — is
 * `blob-pins-harness.ts`. The online arms are `blob-pins-online.spec.ts`.
 */

import { expect } from 'chai';
import { TRANSACTION_PIN_PREFIX } from '../dist/index.js';
import {
	allPins, closePlugin, createStores, openPlugin, pinsOn, putBlob, referencesInTree, restart, scopeOf,
	soleQueuedEntry, transactorOf, type PluginHandle,
} from './blob-pins-harness.js';

const TABLE_DDL = (uri: string) =>
	`create table T (Id integer primary key, R blobref null) using optimystic('${uri}')`;

/**
 * Everything `settleQueued` chains, run. Awaited AFTER the queue is empty, because the release is
 * chained by the terminal status the drain delivers on its way out — and never from inside a
 * transaction, since a chained step waits for the open one to end.
 */
async function settledPins(handle: PluginHandle): Promise<void> {
	await handle.plugin.offline.whenDrained();
	await handle.plugin.blobPins.settled();
}

describe('a queued transaction\'s blob pins settle with it', function () {
	this.timeout(30_000);

	it('announces and releases the reference pins of a queued transaction that commits', async () => {
		const uri = 'tree://blobpins-queued/commit';
		const stores = createStores();
		// Unreachable, so the entry the commit seals stays queued and its pin can be observed before
		// the drain settles it.
		const handle = openPlugin(stores, { reachable: false });
		try {
			const { db, plugin } = handle;
			await db.exec(TABLE_DDL(uri));
			const ref = await putBlob(handle, 1);

			plugin.offline.enter();
			await db.exec(`insert into T (Id, R) values (1, '${ref}')`);
			const transactionId = soleQueuedEntry(plugin);

			expect(await pinsOn(plugin, ref), 'the queued transaction holds its reference pin, and the put its unstaged one')
				.to.deep.equal([`ref/${scopeOf(uri)}`, 'unstaged']);
			expect(await allPins(plugin, `${TRANSACTION_PIN_PREFIX}${transactionId}/`),
				'exactly one pin of the transaction: its reference, with no put pin left over')
				.to.deep.equal([`${ref} sql/${transactionId}/ref/${encodeURIComponent(scopeOf(uri))}`]);
			expect((await plugin.blobs.stat(ref)).durability,
				'nothing has reached the network, so nothing has been announced').to.equal(undefined);

			plugin.offline.exit();
			handle.gate.open();
			await settledPins(handle);

			expect(await allPins(plugin, TRANSACTION_PIN_PREFIX),
				'the settled transaction left no pin of its own').to.deep.equal([]);
			expect((await plugin.blobs.stat(ref)).durability?.quorum,
				'the commit landed, so the reference was announced; a cohort of this machine alone is `local`')
				.to.equal('local');
			expect(await referencesInTree(await transactorOf(handle, stores), scopeOf(uri)),
				'the reference tree lists the reference the committed row holds').to.deep.equal([ref]);
		} finally {
			await closePlugin(handle);
		}
	});

	it('releases the reference pins of a queued transaction that is discarded, announcing nothing', async () => {
		const uri = 'tree://blobpins-queued/discard';
		const stores = createStores();
		const handle = openPlugin(stores, { reachable: false });
		try {
			const { db, plugin } = handle;
			await db.exec(TABLE_DDL(uri));
			const ref = await putBlob(handle, 2);

			plugin.offline.enter();
			await db.exec(`insert into T (Id, R) values (1, '${ref}')`);
			const transactionId = soleQueuedEntry(plugin);
			expect(await pinsOn(plugin, ref)).to.deep.equal([`ref/${scopeOf(uri)}`, 'unstaged']);

			// Never sent, because the gate was closed the whole time, so it can still be withdrawn.
			plugin.offline.discard(transactionId);
			await settledPins(handle);

			expect(await allPins(plugin, TRANSACTION_PIN_PREFIX),
				'the withdrawn transaction left no pin of its own; the bytes go with the next piece sweep')
				.to.deep.equal([]);
			expect(await pinsOn(plugin, ref),
				'the application\'s own hold on bytes it put outside the transaction stays, so a retry need not put them again')
				.to.deep.equal(['unstaged']);
			expect((await plugin.blobs.stat(ref)).durability,
				'nothing committed, so nothing was announced').to.equal(undefined);
			expect(await referencesInTree(await transactorOf(handle, stores), scopeOf(uri)),
				'the reference tree holds nothing: the row never landed').to.deep.equal([]);
		} finally {
			await closePlugin(handle);
		}
	});

	it('settles a queued transaction restored after a restart from the pins\' own labels', async () => {
		const uri = 'tree://blobpins-queued/restart';
		const stores = createStores();
		let handle = openPlugin(stores, { reachable: false });
		try {
			await handle.db.exec(TABLE_DDL(uri));
			const ref = await putBlob(handle, 3);

			handle.plugin.offline.enter();
			await handle.db.exec(`insert into T (Id, R) values (1, '${ref}')`);
			const transactionId = soleQueuedEntry(handle.plugin);

			// The restarted process remembers nothing of the entry it did not seal, so its settle has
			// to read what the transaction owes off the pins' labels.
			handle = await restart(handle, stores, { reachable: false });
			expect(handle.plugin.offline.entries().map(entry => entry.transactionId),
				'the journaled transaction is back in the queue').to.deep.equal([transactionId]);
			expect(await pinsOn(handle.plugin, ref),
				'its reference pin survived the restart, because no terminal status had arrived')
				.to.deep.equal([`ref/${scopeOf(uri)}`, 'unstaged']);

			handle.gate.open();
			await settledPins(handle);

			expect(await allPins(handle.plugin, TRANSACTION_PIN_PREFIX),
				'the settle found the pin by its label and released it').to.deep.equal([]);
			expect((await handle.plugin.blobs.stat(ref)).durability?.quorum,
				'the restored transaction committed, so its reference was announced').to.equal('local');
			// The load-bearing one for this arm: an announcement into a scope the registry does not
			// list would be the silent failure here, and the tree is what says the scope is real.
			expect(await referencesInTree(await transactorOf(handle, stores), scopeOf(uri)),
				'the reference tree lists the reference the restored row holds').to.deep.equal([ref]);
		} finally {
			await closePlugin(handle);
		}
	});
});
