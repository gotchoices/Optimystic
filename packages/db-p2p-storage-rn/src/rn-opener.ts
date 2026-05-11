import type {
	LevelDBIteratorLike,
	LevelDBIteratorOptions,
	LevelDBLike,
	LevelDBWriteBatchLike,
} from './leveldb-like.js';

/**
 * Minimal subset of `rn-leveldb`'s `LevelDB` we depend on. Re-declared
 * locally so this module's *types* don't pull in the plugin's declarations
 * (the plugin is a peer dependency that may not be installed at typecheck
 * time on non-RN consumers).
 *
 * Matches the shape used by `@quereus/plugin-react-native-leveldb` so apps
 * embedding both Optimystic and Quereus can share one native module.
 */
export interface RNLevelDBNative {
	put(key: ArrayBuffer | string, value: ArrayBuffer | string): void;
	getBuf(key: ArrayBuffer | string): ArrayBuffer | null;
	delete(key: ArrayBuffer | string): void;
	close(): void;
	newIterator(): RNLevelDBIteratorNative;
	write(batch: RNLevelDBWriteBatchNative): void;
}

export interface RNLevelDBWriteBatchNative {
	put(key: ArrayBuffer | string, value: ArrayBuffer | string): void;
	delete(key: ArrayBuffer | string): void;
	close(): void;
}

export interface RNLevelDBIteratorNative {
	valid(): boolean;
	seek(target: ArrayBuffer | string): RNLevelDBIteratorNative;
	seekToFirst(): RNLevelDBIteratorNative;
	seekLast(): RNLevelDBIteratorNative;
	next(): void;
	prev(): void;
	keyBuf(): ArrayBuffer;
	valueBuf(): ArrayBuffer;
	close(): void;
}

/** Constructor type for `rn-leveldb`'s `LevelDBWriteBatch`. */
export type RNLevelDBWriteBatchCtor = new () => RNLevelDBWriteBatchNative;

/**
 * Open function shape — typically `(name, createIfMissing, errorIfExists) =>
 * new LevelDB(name, createIfMissing, errorIfExists)`. The caller controls
 * how `rn-leveldb` is imported so this package never directly imports it,
 * which keeps the unit tests runnable under Node.
 */
export type RNLevelDBOpenFn = (name: string, createIfMissing: boolean, errorIfExists: boolean) => RNLevelDBNative;

export const DEFAULT_DB_NAME = 'optimystic';

export interface OpenOptimysticRNDbOptions {
	/** `rn-leveldb`'s `LevelDB` constructor wrapped as an open function. */
	openFn: RNLevelDBOpenFn;
	/** `rn-leveldb`'s `LevelDBWriteBatch` constructor. */
	WriteBatch: RNLevelDBWriteBatchCtor;
	/** Database name (LevelDB directory). Default `optimystic`. */
	name?: string;
	/** Whether to create the database if it doesn't exist. Default `true`. */
	createIfMissing?: boolean;
	/** Whether to error if the database already exists. Default `false`. */
	errorIfExists?: boolean;
}

/**
 * Opens (creating if needed) the Optimystic LevelDB database used by
 * `LevelDBRawStorage`, `LevelDBKVStore`, and `loadOrCreateRNPeerKey`.
 *
 * The caller passes the `rn-leveldb` constructors in; this keeps the
 * native module out of the package's static import graph. Apps embedding
 * both Optimystic and Quereus can pass the same constructors to both —
 * one native module, one Podfile entry.
 */
export function openOptimysticRNDb(options: OpenOptimysticRNDbOptions): LevelDBLike {
	const native = options.openFn(
		options.name ?? DEFAULT_DB_NAME,
		options.createIfMissing ?? true,
		options.errorIfExists ?? false,
	);
	return wrapRNLevelDB(native, options.WriteBatch);
}

/**
 * Wraps an already-open `rn-leveldb` `LevelDB` instance to satisfy the
 * `LevelDBLike` interface. Exported for callers that already hold a handle
 * (rare — usually `openOptimysticRNDb` is the right entry point).
 */
export function wrapRNLevelDB(native: RNLevelDBNative, WriteBatch: RNLevelDBWriteBatchCtor): LevelDBLike {
	return new RNLevelDBAdapter(native, WriteBatch);
}

class RNLevelDBAdapter implements LevelDBLike {
	constructor(
		private readonly native: RNLevelDBNative,
		private readonly WriteBatch: RNLevelDBWriteBatchCtor,
	) {}

	async get(key: Uint8Array): Promise<Uint8Array | undefined> {
		const result = this.native.getBuf(toArrayBuffer(key));
		return result === null ? undefined : new Uint8Array(result);
	}

	async put(key: Uint8Array, value: Uint8Array): Promise<void> {
		this.native.put(toArrayBuffer(key), toArrayBuffer(value));
	}

	async delete(key: Uint8Array): Promise<void> {
		this.native.delete(toArrayBuffer(key));
	}

	batch(): LevelDBWriteBatchLike {
		return new RNLevelDBWriteBatchAdapter(this.native, new this.WriteBatch());
	}

	iterator(options: LevelDBIteratorOptions = {}): LevelDBIteratorLike {
		return new RNLevelDBIteratorAdapter(this.native.newIterator(), options);
	}

	async close(): Promise<void> {
		this.native.close();
	}
}

class RNLevelDBWriteBatchAdapter implements LevelDBWriteBatchLike {
	constructor(
		private readonly native: RNLevelDBNative,
		private readonly batch: RNLevelDBWriteBatchNative,
	) {}

	put(key: Uint8Array, value: Uint8Array): this {
		this.batch.put(toArrayBuffer(key), toArrayBuffer(value));
		return this;
	}

	delete(key: Uint8Array): this {
		this.batch.delete(toArrayBuffer(key));
		return this;
	}

	async write(): Promise<void> {
		try {
			this.native.write(this.batch);
		} finally {
			this.batch.close();
		}
	}
}

class RNLevelDBIteratorAdapter implements LevelDBIteratorLike {
	private positioned = false;
	private yielded = 0;
	private done = false;

	constructor(
		private readonly iter: RNLevelDBIteratorNative,
		private readonly opts: LevelDBIteratorOptions,
	) {}

	async next(): Promise<[Uint8Array, Uint8Array] | undefined> {
		if (this.done) return undefined;
		if (this.opts.limit !== undefined && this.yielded >= this.opts.limit) {
			this.done = true;
			return undefined;
		}

		if (!this.positioned) {
			this.positionInitial();
			this.positioned = true;
		} else if (this.opts.reverse) {
			this.iter.prev();
		} else {
			this.iter.next();
		}

		if (!this.iter.valid()) {
			this.done = true;
			return undefined;
		}

		const key = new Uint8Array(this.iter.keyBuf());

		// Range bounds: bail out as soon as we cross.
		if (this.opts.reverse) {
			if (this.opts.gte && compareBytes(key, this.opts.gte) < 0) {
				this.done = true;
				return undefined;
			}
			if (this.opts.gt && compareBytes(key, this.opts.gt) <= 0) {
				this.done = true;
				return undefined;
			}
		} else {
			if (this.opts.lt && compareBytes(key, this.opts.lt) >= 0) {
				this.done = true;
				return undefined;
			}
			if (this.opts.lte && compareBytes(key, this.opts.lte) > 0) {
				this.done = true;
				return undefined;
			}
		}

		// `keys: true` means caller wants only keys; skip the `valueBuf` native call.
		const value = this.opts.keys ? new Uint8Array(0) : new Uint8Array(this.iter.valueBuf());
		this.yielded++;
		return [key, value];
	}

	async close(): Promise<void> {
		this.iter.close();
	}

	private positionInitial(): void {
		if (this.opts.reverse) {
			if (this.opts.lte !== undefined) {
				this.iter.seek(toArrayBuffer(this.opts.lte));
				if (!this.iter.valid()) {
					this.iter.seekLast();
				} else {
					const key = new Uint8Array(this.iter.keyBuf());
					if (compareBytes(key, this.opts.lte) > 0) this.iter.prev();
				}
			} else if (this.opts.lt !== undefined) {
				this.iter.seek(toArrayBuffer(this.opts.lt));
				if (this.iter.valid()) {
					this.iter.prev();
				} else {
					this.iter.seekLast();
				}
			} else {
				this.iter.seekLast();
			}
		} else {
			if (this.opts.gte !== undefined) {
				this.iter.seek(toArrayBuffer(this.opts.gte));
			} else if (this.opts.gt !== undefined) {
				this.iter.seek(toArrayBuffer(this.opts.gt));
				if (this.iter.valid()) {
					const key = new Uint8Array(this.iter.keyBuf());
					if (compareBytes(key, this.opts.gt) === 0) this.iter.next();
				}
			} else {
				this.iter.seekToFirst();
			}
		}
	}
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = bytes.buffer;
	if (buffer instanceof ArrayBuffer
		&& bytes.byteOffset === 0
		&& bytes.byteLength === buffer.byteLength) {
		return buffer;
	}
	const copy = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(copy).set(bytes);
	return copy;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const minLength = Math.min(a.length, b.length);
	for (let i = 0; i < minLength; i++) {
		const av = a[i]!;
		const bv = b[i]!;
		if (av !== bv) return av - bv;
	}
	return a.length - b.length;
}
