/**
 * The blob service an application puts files through (`plugin.blobs`) and the two SQL functions
 * that read a reference's local state (docs/blobs.md §SQL).
 *
 * What is pinned here: what `BlobLocality` and `BlobSize` answer for a blob this machine holds, for
 * a well-formed reference nobody ever put, for a malformed one and for NULL; and the one piece of
 * branching logic in `SqlBlobService` — which owner label a `put` pins under when the caller names
 * none.
 *
 * Nothing here tests the registration of the functions, the option plumbing, or the label builders
 * on their own: `parsePinLabel` is exercised by the owner-label cases below, and a round-trip of the
 * builders against the parser would test the module against itself.
 */

import { expect } from 'chai';
import { Database, QuereusError, StatusCode } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { BLOB_PIECE_BYTES, BlobRefError } from '@optimystic/db-core';
import register from '../dist/plugin.js';
import { parsePinLabel } from '../dist/index.js';
import { captureThrown, queryAll } from './query-helpers.js';

/**
 * A canonical reference nobody put in this process: one of the fixed vectors in
 * `packages/db-core/test/blob-builder.spec.ts` (its 1,000-byte file), so it is a reference real IPFS
 * tools produce rather than one made to fit.
 */
const UNKNOWN_REF = 'bafkreicojquuwmy7piqjti3zx3buxh47ya64i2vumxmzr5gwqpnfgsd6nu';

/** Bytes past one piece, so the blob's size comes off a list root rather than a raw root. */
const TAIL_BYTES = 1_000;

const TABLE_DDL = `
	create table Attachment (Id text primary key, Content blobref null)
		using optimystic('tree://blobfn/attachment')
`;

type PluginHandle = ReturnType<typeof register>;

/**
 * The plugin over the in-memory `test` transactor, with its `types` and `functions` registered as
 * `registerPlugin` (`@quereus/quereus/src/util/plugin-helper.ts`) does — which is what a host
 * assembling the plugin's parts by hand must also do. The `test` transactor has no libp2p node, so
 * `plugin.blobs` resolves a `SingleMachineBlobService` over memory.
 */
function openSession(): { db: Database; plugin: PluginHandle } {
	const db = new Database();
	const plugin = register(db, {
		default_transactor: 'test',
		default_key_network: 'test',
		enable_cache: false,
	} as unknown as Record<string, SqlValue>);
	for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
	for (const func of plugin.functions) db.registerFunction(func.schema);
	for (const type of plugin.types) db.registerType(type.name, type.definition);
	return { db, plugin };
}

/** Two pieces of a repeating pattern: a full leaf and a short tail. */
async function* twoPieces(): AsyncIterable<Uint8Array> {
	yield Uint8Array.from({ length: BLOB_PIECE_BYTES }, (_, i) => i % 251);
	yield Uint8Array.from({ length: TAIL_BYTES }, (_, i) => (i * 7) % 251);
}

/** What the two functions answer for `ref`, through SQL. */
async function localityAndSize(db: Database, ref: SqlValue): Promise<{ locality: SqlValue; size: SqlValue }> {
	const rows = await queryAll(db, `select BlobLocality(?) as locality, BlobSize(?) as size`, [ref, ref]);
	expect(rows).to.have.lengthOf(1);
	return rows[0] as { locality: SqlValue; size: SqlValue };
}

describe('blob SQL functions and plugin.blobs', function () {
	this.timeout(15_000);

	it('reports a blob put through plugin.blobs as here, with its size', async () => {
		const { db, plugin } = openSession();
		try {
			const { ref, size } = await plugin.blobs.put(twoPieces());
			expect(size, 'a full leaf plus the tail').to.equal(BLOB_PIECE_BYTES + TAIL_BYTES);
			expect(await localityAndSize(db, ref)).to.deep.equal({ locality: 'here', size });
		} finally {
			db.close();
			await plugin.dispose();
		}
	});

	it('reports a well-formed reference nobody put as unknown, with no size', async () => {
		// Never an error and never a missing-block fault: "known but not here is an ordinary state"
		// (docs/blobs.md §Design principles).
		const { db, plugin } = openSession();
		try {
			expect(await localityAndSize(db, UNKNOWN_REF)).to.deep.equal({ locality: 'unknown', size: null });
		} finally {
			db.close();
			await plugin.dispose();
		}
	});

	it('answers NULL for NULL, and refuses a value that is not a reference', async () => {
		const { db, plugin } = openSession();
		try {
			expect(await localityAndSize(db, null)).to.deep.equal({ locality: null, size: null });

			// One case per arm of the parse rule: a string the grammar refuses (the upper-cased spelling
			// of a real reference — a blob has one accepted spelling) and a value that is not a string.
			// Which spellings are and are not references is `isBlobRef`'s rule, pinned over the whole
			// vector set by `packages/db-core/test/blob-ref.spec.ts`.
			const REFUSED: readonly { readonly what: string; readonly value: SqlValue }[] = [
				{ what: 'the upper-cased spelling of a real reference', value: UNKNOWN_REF.toUpperCase() },
				{ what: 'an integer', value: 42 },
			];
			for (const { what, value } of REFUSED) {
				for (const sql of [`select BlobLocality(?) as v`, `select BlobSize(?) as v`]) {
					const error = await captureThrown(() => queryAll(db, sql, [value]));
					const why = `${sql} over ${what}`;
					expect(error, why).to.be.instanceOf(QuereusError);
					expect((error as QuereusError).code, why).to.equal(StatusCode.MISMATCH);
					expect(error.cause, why).to.be.instanceOf(BlobRefError);
				}
			}
		} finally {
			db.close();
			await plugin.dispose();
		}
	});

	it('pins a put made outside any transaction as unstaged', async () => {
		const { db, plugin } = openSession();
		try {
			const before = Date.now();
			const { ref } = await plugin.blobs.put(twoPieces());
			const after = Date.now();

			const pins = await plugin.blobs.pinsOf(ref);
			expect(pins, 'exactly the one pin the put took').to.have.lengthOf(1);
			const parsed = parsePinLabel(pins[0]!);
			expect(parsed?.kind, pins[0]).to.equal('unstaged');
			expect(parsed?.kind === 'unstaged' ? parsed.putAtMs : undefined)
				.to.be.within(before, after);
		} finally {
			db.close();
			await plugin.dispose();
		}
	});

	it('pins a put made while a transaction is open under that transaction', async () => {
		const { db, plugin } = openSession();
		try {
			await db.exec(TABLE_DDL);
			await db.exec('begin');
			// StampId() answers the open transaction's stamp once a table has been touched — the
			// insert is what registers the connection and begins the Optimystic transaction (see the
			// StampId() contract in src/functions/transaction-id.ts).
			await db.exec(`insert into Attachment (Id, Content) values (?, ?)`, ['a', null]);
			const stampId = (await queryAll(db, `select StampId() as id`))[0]!['id'] as string;
			expect(stampId, 'a touched table gives the statement a stamp').to.be.a('string');

			const { ref } = await plugin.blobs.put(twoPieces());
			await db.exec('commit');

			// The pin survives the commit: this release releases nothing (`feat-blob-pins-follow-sql-commits`).
			const pins = await plugin.blobs.pinsOf(ref);
			expect(pins, 'exactly the one pin the put took').to.have.lengthOf(1);
			expect(parsePinLabel(pins[0]!), pins[0]).to.deep.equal({ kind: 'put', stampId });
		} finally {
			db.close();
			await plugin.dispose();
		}
	});
});
