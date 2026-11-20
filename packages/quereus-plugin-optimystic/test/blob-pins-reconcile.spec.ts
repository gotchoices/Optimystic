/**
 * A restart reconciles the blob reference pins the last process left behind, from COMMITTED STATE
 * (docs/blobs.md §SQL "Pins follow the transaction"; docs/internals.md §A table's blob references).
 *
 * The rule these hold: a reference pin is written when a commit starts and released when that
 * commit's outcome is known, and two things break that pairing — the process stopped in between, or
 * an arm KEPT the pin deliberately (`blob:pin-kept`) because its scope could not be confirmed or its
 * announcement failed. Either way the only durable record of what is owed is the pin's own label, and
 * the only thing that can judge it is the reference tree that label names: the tree either lists the
 * reference or it does not.
 *
 * One case per arm of that committed read. Each writes the pin DIRECTLY on the blob store under a
 * transaction id that is neither open nor queued — which is exactly the state a crashed process
 * leaves behind — and then restarts into a fresh plugin, whose `hydrate` awaits the reconciliation.
 *
 * A fourth case holds the ORDERING the three rest on: a transaction the offline journal still holds
 * is in no queue until a restore pass has read it, so a pass that judged it before then would release
 * the pins of an entry that goes on to commit. That is the one way this mechanism can lose an
 * application's bytes, so it is driven rather than inspected.
 *
 * The registered-scope arms (a table dropped on another machine, so the scope is certainly gone from
 * the network's registry) and the stray-`put`-pin arm are branches of the same pass with no new
 * mechanism behind them, and are checked by inspection rather than by two more harnesses.
 *
 * Everything shared — the stores, the handles, the restart, the pin rendering — is
 * `blob-pins-harness.ts`. The online arms are `blob-pins-online.spec.ts` and the queued ones
 * `blob-pins-queued.spec.ts`.
 */

import { expect } from 'chai';
import type { BlobRef } from '@optimystic/db-core';
import { TRANSACTION_PIN_PREFIX, transactionReferencePinLabel } from '../dist/index.js';
import {
	allPins, closePlugin, createStores, openPlugin, pinsOn, putBlob, referencesInTree, restart, scopeOf,
	soleQueuedEntry, transactorOf, type PluginHandle,
} from './blob-pins-harness.js';
import { Isolation } from './isolation.js';

const TABLE_DDL = (uri: string) =>
	`create table T (Id integer primary key, R blobref null) using optimystic('${uri}')`;

/**
 * A stamp id no transaction of this process ever had: base64url, so it is a shape
 * `parsePinLabel` reads back, and dead, so the reconciliation judges it rather than skipping it.
 */
const DEAD_TRANSACTION = 'deadstamp0';

/** The pin a process that died between `holdForCommit` and its release would have left on `ref`. */
async function pinAsCrashedProcess(handle: PluginHandle, ref: BlobRef, uri: string): Promise<string> {
	const label = transactionReferencePinLabel(DEAD_TRANSACTION, scopeOf(uri));
	await handle.plugin.blobs.pin(ref, label);
	return `${ref} ${label}`;
}

describe('blob reference pins reconcile after a restart', function () {
	this.timeout(30_000);

	it('announces and releases a leftover pin whose reference the table\'s tree lists', async () => {
		const uri = 'tree://blobpins-reconcile/listed';
		const stores = createStores();
		let handle = openPlugin(stores);
		try {
			await handle.db.exec(TABLE_DDL(uri));
			const ref = await putBlob(handle, 1);
			// Committed normally first, so the scope's reference tree lists the reference: this is the
			// state a process that crashed AFTER its commit landed and BEFORE its release leaves behind.
			await handle.db.exec(`insert into T (Id, R) values (1, '${ref}')`);
			const pinned = await pinAsCrashedProcess(handle, ref, uri);
			expect(await allPins(handle.plugin, TRANSACTION_PIN_PREFIX),
				'the hand-written pin is the only transaction pin on the machine').to.deep.equal([pinned]);

			handle = await restart(handle, stores);

			expect(await allPins(handle.plugin, TRANSACTION_PIN_PREFIX),
				'the tree lists the reference, certainly, so the pin was announced and released')
				.to.deep.equal([]);
			// The reference was already announced by the original commit, so this says the reconciliation
			// did not UNDO that rather than that it announced; the `does not announce` case below is what
			// makes a wrong announce fail.
			expect((await handle.plugin.blobs.stat(ref)).durability?.quorum,
				'the reference is announced; a cohort of this machine alone is `local`').to.equal('local');
			expect(await referencesInTree(await transactorOf(handle, stores), scopeOf(uri)),
				'the committed row still holds the reference').to.deep.equal([ref]);
		} finally {
			await closePlugin(handle);
		}
	});

	it('releases a leftover pin whose reference the tree does not list, announcing nothing', async () => {
		const uri = 'tree://blobpins-reconcile/unlisted';
		const stores = createStores();
		let handle = openPlugin(stores);
		try {
			await handle.db.exec(TABLE_DDL(uri));
			const ref = await putBlob(handle, 2);
			// Another row's reference, so the scope's tree EXISTS and is read — rather than reading as
			// never written, which would answer "lists nothing" without descending at all.
			const other = await putBlob(handle, 3);
			await handle.db.exec(`insert into T (Id, R) values (1, '${other}')`);
			const pinned = await pinAsCrashedProcess(handle, ref, uri);
			expect(await allPins(handle.plugin, TRANSACTION_PIN_PREFIX)).to.deep.equal([pinned]);

			handle = await restart(handle, stores);

			expect(await allPins(handle.plugin, TRANSACTION_PIN_PREFIX),
				'the transaction never committed that reference, so its pin goes and the bytes go with the next sweep')
				.to.deep.equal([]);
			expect((await handle.plugin.blobs.stat(ref)).durability,
				'nothing was announced: an announcement here would tell the cohort to keep bytes no row references')
				.to.equal(undefined);
			expect(await pinsOn(handle.plugin, ref),
				'the application\'s own hold on bytes it put outside a transaction is not the reconciliation\'s to drop')
				.to.deep.equal(['unstaged']);
		} finally {
			await closePlugin(handle);
		}
	});

	it('keeps a leftover pin whose reference tree cannot be read with confidence, and releases it on the next trigger', async () => {
		const uri = 'tree://blobpins-reconcile/uncertain';
		const stores = createStores();
		let handle = openPlugin(stores);
		try {
			await handle.db.exec(TABLE_DDL(uri));
			const ref = await putBlob(handle, 4);
			await handle.db.exec(`insert into T (Id, R) values (1, '${ref}')`);
			const pinned = await pinAsCrashedProcess(handle, ref, uri);

			// The restart by hand rather than through the harness: the wrapped transactor has to be
			// registered on the restarted factory BEFORE `hydrate`, which is what the reconciliation hangs
			// off. Only the reference tree's blocks are made unreachable — its header block id IS its
			// collection id — so the catalog and the scope registry still read.
			await closePlugin(handle);
			handle = openPlugin(stores);
			const isolation = new Isolation(blockId => blockId.startsWith(scopeOf(uri)));
			handle.plugin.collectionFactory.registerTransactor('local:test', isolation.wrap(await transactorOf(handle, stores)));
			isolation.armed = true;
			await handle.plugin.hydrate(handle.db);

			expect(await allPins(handle.plugin, TRANSACTION_PIN_PREFIX),
				'the committed read was uncertain, so every pin of that scope is kept rather than dropped')
				.to.deep.equal([pinned]);

			// The cohort can be read again: the next trigger retries exactly the pins the last pass kept.
			isolation.armed = false;
			await handle.plugin.offline.restore();

			expect(await allPins(handle.plugin, TRANSACTION_PIN_PREFIX),
				'now that the tree reads certainly, the pin is announced and released').to.deep.equal([]);
			expect((await handle.plugin.blobs.stat(ref)).durability?.quorum).to.equal('local');
		} finally {
			await closePlugin(handle);
		}
	});

	it('leaves a journaled transaction\'s pins alone until the restore has read the journal', async () => {
		const uri = 'tree://blobpins-reconcile/journaled';
		const stores = createStores();
		// Unreachable throughout, so the commit is sealed into the queue and journaled and NOTHING of
		// it reaches storage: its reference tree is never written, and a committed read of a tree that
		// was never written answers "lists nothing", certainly — the very answer that releases a pin.
		let handle = openPlugin(stores, { reachable: false });
		try {
			await handle.db.exec(TABLE_DDL(uri));
			const ref = await putBlob(handle, 5);
			handle.plugin.offline.enter();
			await handle.db.exec(`insert into T (Id, R) values (1, '${ref}')`);
			const transactionId = soleQueuedEntry(handle.plugin);
			const pinned = `${ref} ${transactionReferencePinLabel(transactionId, scopeOf(uri))}`;
			expect(await allPins(handle.plugin, TRANSACTION_PIN_PREFIX),
				'the queued transaction holds its reference pin').to.deep.equal([pinned]);

			// The restart WITHOUT `hydrate`: the journaled record is on disk and unread, so the
			// transaction is in no queue and deferred nowhere. Reading the blob service is what resolves
			// the default network's store, and that resolution is itself a reconciliation trigger.
			await closePlugin(handle);
			handle = openPlugin(stores, { reachable: false });
			expect((await handle.plugin.blobs.stat(ref)).durability,
				'nothing of the transaction reached the network, so nothing was announced').to.equal(undefined);
			await handle.plugin.blobPins.settled();

			expect(await referencesInTree(await transactorOf(handle, stores), scopeOf(uri)),
				'committed state says, certainly, that nothing lists the reference').to.deep.equal([]);
			expect(await allPins(handle.plugin, TRANSACTION_PIN_PREFIX),
				'the pin is kept anyway: judged now, it would be released and its bytes swept while the entry went on to commit')
				.to.deep.equal([pinned]);

			// Once the restore has read the journal the entry is back in the queue, and the queue is what
			// holds it live from then on.
			await handle.plugin.hydrate(handle.db);
			expect(handle.plugin.offline.entries().map(entry => entry.transactionId),
				'the journaled transaction is back in the queue').to.deep.equal([transactionId]);
			expect(await allPins(handle.plugin, TRANSACTION_PIN_PREFIX),
				'still held, now because the queue holds the transaction').to.deep.equal([pinned]);

			handle.gate.open();
			await handle.plugin.offline.whenDrained();
			await handle.plugin.blobPins.settled();

			expect(await allPins(handle.plugin, TRANSACTION_PIN_PREFIX),
				'the entry committed and its own settlement released the pin').to.deep.equal([]);
			expect((await handle.plugin.blobs.stat(ref)).durability?.quorum,
				'the bytes the deferral kept are the ones the commit announced').to.equal('local');
		} finally {
			await closePlugin(handle);
		}
	});
});
