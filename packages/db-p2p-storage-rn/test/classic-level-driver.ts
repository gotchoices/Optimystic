import { ClassicLevel, type Iterator as ClassicIterator } from 'classic-level';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	LevelDBIteratorLike,
	LevelDBIteratorOptions,
	LevelDBLike,
	LevelDBTextIteratorOptions,
	LevelDBWriteBatchLike,
	LevelDBWriteOptions,
} from '../src/leveldb-like.js';

/**
 * Test-only `LevelDBLike` driver backed by `classic-level`, the Node-native
 * LevelDB binding maintained by the Level team. Production code uses
 * `openOptimysticRNDb` (which wraps `rn-leveldb`); this driver lets the same
 * storage classes run under Mocha without the React Native native module.
 * Unlike `rn-leveldb` it can sync a batch (`WriteOptions.sync`), which is what
 * lets the suite exercise the synced apply path the phone binding cannot
 * take yet. Its text reads ask `classic-level` for the `utf8` value encoding,
 * which it decodes in native code as `rn-leveldb`'s `getStr` does, so the text
 * path runs over Node's native decoder and never a JavaScript `TextDecoder`.
 *
 * Each `openTestDb()` returns an isolated, file-backed database in a fresh
 * temp directory; the matching `cleanup()` closes the handle and removes the
 * directory. File-backed (not in-memory) so we can also exercise the
 * close + reopen path that the identity helper relies on.
 */
class ClassicLevelAdapter implements LevelDBLike {
	readonly canSync = true;

	constructor(private readonly db: ClassicLevel<Uint8Array, Uint8Array>) {}

	async get(key: Uint8Array): Promise<Uint8Array | undefined> {
		const value = await this.db.get(key);
		return value === undefined ? undefined : new Uint8Array(value);
	}

	getText(key: Uint8Array): Promise<string | undefined> {
		return this.db.get<Uint8Array, string>(key, { valueEncoding: 'utf8' });
	}

	batch(): LevelDBWriteBatchLike {
		const chain = this.db.batch();
		return {
			put(key: Uint8Array, value: Uint8Array) {
				chain.put(key, value);
				return this;
			},
			delete(key: Uint8Array) {
				chain.del(key);
				return this;
			},
			async write(options?: LevelDBWriteOptions) {
				await chain.write({ sync: options?.sync === true });
			},
		};
	}

	iterator(options: LevelDBIteratorOptions = {}): LevelDBIteratorLike {
		// `view` encoding gives back Uint8Array rather than Buffer or string.
		const iter = this.db.iterator<Uint8Array, Uint8Array>({
			...rangeOf(options),
			keyEncoding: 'view',
			valueEncoding: 'view',
			...(options.keys && { values: false }),
		});
		return adaptIterator(iter, value => value ? new Uint8Array(value) : new Uint8Array(0));
	}

	textIterator(options: LevelDBTextIteratorOptions = {}): LevelDBIteratorLike<string> {
		const iter = this.db.iterator<Uint8Array, string>({ ...rangeOf(options), keyEncoding: 'view', valueEncoding: 'utf8' });
		return adaptIterator(iter, value => value ?? '');
	}

	async close(): Promise<void> {
		await this.db.close();
	}
}

/** The range options `classic-level` takes natively (gte/gt/lte/lt/reverse/limit), passed through. */
function rangeOf(options: LevelDBTextIteratorOptions) {
	return {
		...(options.gte !== undefined && { gte: options.gte }),
		...(options.gt !== undefined && { gt: options.gt }),
		...(options.lte !== undefined && { lte: options.lte }),
		...(options.lt !== undefined && { lt: options.lt }),
		...(options.reverse && { reverse: true }),
		...(options.limit !== undefined && { limit: options.limit }),
	};
}

/** A `classic-level` iterator as a `LevelDBIteratorLike`, its keys copied into plain Uint8Arrays and each value read by `toValue`. */
function adaptIterator<V, Raw>(iter: ClassicIterator<ClassicLevel<Uint8Array, Uint8Array>, Uint8Array, Raw>, toValue: (value: Raw | undefined) => V): LevelDBIteratorLike<V> {
	let closed = false;
	return {
		async next() {
			if (closed) return undefined;
			const entry = await iter.next();
			if (entry === undefined) return undefined;
			const [k, v] = entry;
			return [new Uint8Array(k), toValue(v)];
		},
		async close() {
			if (closed) return;
			closed = true;
			await iter.close();
		},
	};
}

export interface TestDbHandle {
	db: LevelDBLike;
	path: string;
	cleanup(): Promise<void>;
}

/**
 * Open a fresh file-backed `LevelDBLike` database in an isolated temp directory.
 * Returns a `cleanup()` function so the spec can release the handle and remove
 * the directory in `afterEach`.
 */
export async function openTestDb(): Promise<TestDbHandle> {
	const dir = mkdtempSync(join(tmpdir(), 'optimystic-rn-leveldb-'));
	const db = new ClassicLevel<Uint8Array, Uint8Array>(dir, { keyEncoding: 'view', valueEncoding: 'view' });
	await db.open();
	const adapter = new ClassicLevelAdapter(db);
	return {
		db: adapter,
		path: dir,
		cleanup: async () => {
			try {
				await adapter.close();
			} catch {
				// Already closed by test — fine.
			}
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

/**
 * Open a file-backed `LevelDBLike` at a caller-controlled path. Used by tests
 * that close and reopen the same database (identity persistence). Caller is
 * responsible for cleanup.
 */
export async function openAtPath(path: string): Promise<LevelDBLike> {
	const db = new ClassicLevel<Uint8Array, Uint8Array>(path, { keyEncoding: 'view', valueEncoding: 'view' });
	await db.open();
	return new ClassicLevelAdapter(db);
}
