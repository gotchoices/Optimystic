/**
 * A `classic-level` database in the shape `@optimystic/db-p2p-storage-rn` takes (its `LevelDBLike`),
 * so the React Native backend can run under Node — the stand-in that package's own suite uses
 * (`test/classic-level-driver.ts` there). The keys and values the backend stores come from that
 * package, not from which LevelDB binding writes them, so data written through this reads the same
 * as data a phone wrote through `rn-leveldb`.
 *
 * Plain JavaScript because the writer runs it inside a published build's scratch install, and the
 * reader imports the same file (typed by `classic-level.d.mts`) so the two cannot drift.
 */

import { ClassicLevel } from 'classic-level';

/** Open (creating if absent) the database at `path`. The caller closes it. */
export async function openClassicLevel(path) {
	const db = new ClassicLevel(path, { keyEncoding: 'view', valueEncoding: 'view' });
	await db.open();
	return {
		async get(key) {
			const value = await db.get(key);
			return value === undefined ? undefined : new Uint8Array(value);
		},
		async put(key, value) {
			await db.put(key, value);
		},
		async delete(key) {
			await db.del(key);
		},
		batch() {
			const chain = db.batch();
			return {
				put(key, value) {
					chain.put(key, value);
					return this;
				},
				delete(key) {
					chain.del(key);
					return this;
				},
				async write() {
					await chain.write();
				},
			};
		},
		iterator(options = {}) {
			const iterator = db.iterator({
				...(options.gte !== undefined && { gte: options.gte }),
				...(options.gt !== undefined && { gt: options.gt }),
				...(options.lte !== undefined && { lte: options.lte }),
				...(options.lt !== undefined && { lt: options.lt }),
				...(options.reverse && { reverse: true }),
				...(options.limit !== undefined && { limit: options.limit }),
				...(options.keys && { values: false }),
				keyEncoding: 'view',
				valueEncoding: 'view',
			});
			let closed = false;
			return {
				async next() {
					if (closed) {
						return undefined;
					}
					const entry = await iterator.next();
					if (entry === undefined) {
						return undefined;
					}
					const [key, value] = entry;
					return [new Uint8Array(key), value ? new Uint8Array(value) : new Uint8Array(0)];
				},
				async close() {
					if (!closed) {
						closed = true;
						await iterator.close();
					}
				},
			};
		},
		async close() {
			await db.close();
		},
	};
}
