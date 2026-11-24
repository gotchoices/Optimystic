import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'node:crypto';
import type { PieceId } from '@optimystic/db-core';
import type { IPieceStore, StoreDurability, StoreIdentity } from '@optimystic/db-p2p';
import { createLogger } from './logger.js';
import { fileStoreIdentity, fsyncDir, readFileIfExists } from './file-write-log.js';

const log = createLogger('pieces:file');

/**
 * The directory under a base path that holds the piece store. Named like the `optimystic-offline`
 * key-value namespace so a collection id is unlikely to collide with it at the root, where block
 * directories also live; `FileBatchBackend`'s block listing skips it.
 */
export const PIECE_DIRECTORY = 'optimystic-pieces';

/** Where a piece is written before it is renamed into place; cleared on open, never listed. */
const INCOMING_DIRECTORY = 'incoming';

/**
 * The alphabet of a lowercase base32 CIDv1. A path-safety guard, not a CID parser (the blob service
 * has already parsed every id it hands over): it admits no `/`, `\`, `.`, `:` or uppercase letter, so
 * no id can name a path outside its fan directory.
 */
const PIECE_ID_PATTERN = /^b[a-z2-7]{50,}$/u;

/** A fan directory's name: two characters of the id's alphabet, which `incoming` is not. */
const FAN_DIRECTORY_PATTERN = /^[a-z2-7]{2}$/u;

/**
 * The fan directory an id is filed under: the two characters before its last. Every piece id starts
 * the same way (`bafkrei` for raw, `bafybei` for dag-pb), so the front spreads nothing, and the last
 * character of a 59-character id carries only 3 bits; the two before it are digest bits. One level of
 * 1024 directories keeps about a thousand files in each at a million pieces.
 */
function fanOf(id: string): string {
	return id.slice(-3, -1);
}

interface PieceLocation {
	readonly fanDirectory: string;
	readonly file: string;
}

/** Refuses anything that is not a lowercase base32 CID before it becomes a path. */
function pieceLocation(root: string, id: PieceId): PieceLocation {
	if (!PIECE_ID_PATTERN.test(id)) {
		throw new RangeError(`Not a piece id: ${JSON.stringify(String(id).slice(0, 80))}`);
	}
	const fanDirectory = path.join(root, fanOf(id));
	return { fanDirectory, file: path.join(fanDirectory, id) };
}

function errorCode(err: unknown): string | undefined {
	return (err as NodeJS.ErrnoException | undefined)?.code;
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.access(file);
		return true;
	} catch (err) {
		if (errorCode(err) === 'ENOENT') return false;
		throw err;
	}
}

async function unlinkIfPresent(file: string): Promise<void> {
	try {
		await fs.unlink(file);
	} catch (err) {
		if (errorCode(err) !== 'ENOENT') throw err;
	}
}

/**
 * A rename refused because the target exists, or (Windows) because another handle has the target
 * open. Either means another put of the same id may have won; the caller checks the target.
 */
function mayBeRenameRace(err: unknown): boolean {
	const code = errorCode(err);
	return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES';
}

/** Deepest first, so a directory's own entries are synced before the entry naming it. */
function deepestFirst(a: string, b: string): number {
	return b.split(path.sep).length - a.split(path.sep).length;
}

/**
 * The filesystem {@link IPieceStore}: one file per piece under `<basePath>/optimystic-pieces/`,
 * named by its id and holding exactly its bytes, fanned out by {@link fanOf}. A put writes the piece
 * to `incoming/`, syncs it, and renames it into place, so after a crash a piece's name holds the
 * whole piece or nothing; the directory entry becomes durable at the next {@link flush}. No
 * write-ahead log, no write group and no lock: content-addressed files written by rename need none
 * to stay consistent (docs/blobs.md §The local store).
 *
 * NOTE: two `FilePieceStore`s over one directory, in one process or two, are not supported: the
 * second's open deletes the first's in-flight temps, failing its put. One process per store is what a
 * host already keeps (Invariant 5 of `packages/db-p2p/docs/storage.md`), and `FileRawStorage`'s lock
 * is not taken here because a second taker in the same process would be refused by it.
 */
export class FilePieceStore implements IPieceStore {
	/** On the same footing as `FileBatchBackend`'s: directory syncs are skipped on win32 (`fsyncDir`). */
	readonly durability: StoreDurability = 'power-loss';

	private readonly basePath: string;
	private readonly root: string;
	private readonly incoming: string;
	private readonly identity: StoreIdentity;
	/** Directories whose entries changed since the last flush; the flush's work list. */
	private readonly dirty = new Set<string>();
	/** The last flush called; the next one starts after it. */
	private flushing: Promise<void> = Promise.resolve();
	private opened: Promise<void> | undefined;

	/** Pieces go in `<basePath>/optimystic-pieces/`. Synchronous; the directories are created on first use. */
	constructor(basePath: string) {
		this.basePath = path.resolve(basePath);
		this.root = path.join(this.basePath, PIECE_DIRECTORY);
		this.incoming = path.join(this.root, INCOMING_DIRECTORY);
		this.identity = fileStoreIdentity(basePath);
	}

	/**
	 * Equal to a `FileRawStorage` over the same base path, whose byte count measures the whole
	 * directory, pieces included, so `StorageAccount` does not add this store's figure again.
	 */
	storeIdentity(): StoreIdentity {
		return this.identity;
	}

	async has(id: PieceId): Promise<boolean> {
		const { file } = pieceLocation(this.root, id);
		await this.open();
		return exists(file);
	}

	async get(id: PieceId): Promise<Uint8Array | undefined> {
		const { file } = pieceLocation(this.root, id);
		await this.open();
		const bytes = await readFileIfExists(file);
		// A plain view over the buffer the read allocated, which no one else holds.
		return bytes === undefined ? undefined : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	async put(id: PieceId, bytes: Uint8Array): Promise<void> {
		const location = pieceLocation(this.root, id);
		await this.open();
		if (!await exists(location.file)) {
			await this.ensureFanDirectory(location.fanDirectory);
			const temp = await this.writeTemp(bytes);
			await this.moveIntoPlace(id, temp, location.file);
		}
		// Also when the piece was already there: a concurrent put of the id may have renamed it
		// without having marked the directory yet, and a flush after this put must cover the entry.
		this.dirty.add(location.fanDirectory);
	}

	async delete(id: PieceId): Promise<void> {
		const location = pieceLocation(this.root, id);
		await this.open();
		// On Windows a piece another handle is reading can refuse deletion; the error propagates and
		// the caller retries later.
		await unlinkIfPresent(location.file);
		this.dirty.add(location.fanDirectory);
	}

	async *list(): AsyncIterable<PieceId> {
		await this.open();
		for (const fan of await this.fanDirectoryNames()) {
			// Drained before the first yield from it.
			const ids = await this.pieceIdsIn(fan);
			yield* ids;
		}
	}

	/** The sum of the sizes of the files `list` yields; temps are excluded. */
	async bytesUsed(): Promise<number> {
		// NOTE: one stat per piece; if this ever shows up slow on a store of millions of pieces, keep a
		// running total instead. A node whose block store shares the base path leaves it out of its
		// `capacity()` — the block store's directory walk already covers these bytes — and calls it only
		// from `StorageAccount.breakdown`, which needs the piece figure on its own to subtract it; that
		// is an operator's report on no timer, and nothing on a hot path asks for it.
		let total = 0;
		for await (const id of this.list()) total += await this.sizeOf(id);
		return total;
	}

	/**
	 * Syncs every directory whose entries a resolved put or delete changed. A put synced its file's
	 * bytes before it resolved, so the directory entries are all a flush owes. Flushes run one after
	 * another: a flush called while an earlier one is still syncing the directories it took finds the
	 * work list empty, and must not resolve before those syncs have finished.
	 */
	flush(): Promise<void> {
		const flushed = this.flushing.then(() => this.syncDirtyDirectories());
		// The caller of this flush sees its rejection; the next flush still runs.
		this.flushing = flushed.catch(() => undefined);
		return flushed;
	}

	/** `fsyncDir` swallows its errors, so this cannot reject on its own. */
	private async syncDirtyDirectories(): Promise<void> {
		const directories = [...this.dirty].sort(deepestFirst);
		this.dirty.clear();
		// NOTE: one directory at a time; if a flush after a large blob's put ever shows up slow on
		// POSIX, sync the fan directories concurrently before the ones above them.
		for (const directory of directories) await fsyncDir(directory);
	}

	/** The store holds no handle between calls, so closing is flushing. */
	close(): Promise<void> {
		return this.flush();
	}

	// --- opening ---

	/** Retried on the next call when it fails, rather than remembered. */
	private open(): Promise<void> {
		return this.opened ??= this.openOnce().catch((err: unknown) => {
			this.opened = undefined;
			throw err;
		});
	}

	private async openOnce(): Promise<void> {
		const created = await fs.mkdir(this.root, { recursive: true });
		// The piece root and the base path above it are synced by the first flush even when an
		// earlier process created them and crashed before it flushed: a piece found already present is
		// then durable once this process flushes. When this call created directories, every one of
		// them and the directory holding the first are synced too.
		this.markAncestorsDirty(created === undefined ? this.basePath : path.dirname(created));
		// Its entry is never synced: temps are transient by design.
		await fs.mkdir(this.incoming, { recursive: true });
		await this.clearIncoming();
	}

	/** Marks the piece root and every directory above it, up to and including `top`. */
	private markAncestorsDirty(top: string): void {
		for (let directory = this.root; ; directory = path.dirname(directory)) {
			this.dirty.add(directory);
			if (directory === top || path.dirname(directory) === directory) return;
		}
	}

	/** A temp left by a crashed put is never served or listed; it is removed here. */
	private async clearIncoming(): Promise<void> {
		const names = await fs.readdir(this.incoming);
		await Promise.all(names.map(name => unlinkIfPresent(path.join(this.incoming, name))));
		if (names.length > 0) log('incoming:cleared count=%d', names.length);
	}

	// --- writing ---

	private async ensureFanDirectory(fanDirectory: string): Promise<void> {
		const created = await fs.mkdir(fanDirectory, { recursive: true });
		if (created !== undefined) this.dirty.add(this.root);
	}

	/**
	 * The piece's bytes in a new temp, synced: a rename of an unsynced file could come back empty or
	 * truncated after a power cut, serving a corrupt piece where a missing one belongs.
	 */
	private async writeTemp(bytes: Uint8Array): Promise<string> {
		const temp = path.join(this.incoming, `${randomBytes(8).toString('hex')}.tmp`);
		const handle = await fs.open(temp, 'wx');
		try {
			await handle.writeFile(bytes);
			await handle.sync();
		} catch (err) {
			await handle.close().catch((closeErr: unknown) => log('temp:close-failed temp=%s - %o', temp, closeErr));
			await this.discardTemp(temp);
			throw err;
		}
		await handle.close();
		return temp;
	}

	private async moveIntoPlace(id: PieceId, temp: string, file: string): Promise<void> {
		try {
			await fs.rename(temp, file);
		} catch (err) {
			await this.discardTemp(temp);
			if (mayBeRenameRace(err) && await exists(file)) {
				log('rename:raced id=%s code=%s', id, errorCode(err));
				return;
			}
			throw err;
		}
	}

	/** Best effort: a temp left behind is removed by the next open. */
	private async discardTemp(temp: string): Promise<void> {
		await unlinkIfPresent(temp).catch((err: unknown) => log('temp:unlink-failed temp=%s - %o', temp, err));
	}

	// --- listing ---

	private async fanDirectoryNames(): Promise<string[]> {
		const entries = await fs.readdir(this.root, { withFileTypes: true }).catch((err: unknown) => {
			if (errorCode(err) === 'ENOENT') return [];
			throw err;
		});
		return entries.filter(entry => entry.isDirectory() && FAN_DIRECTORY_PATTERN.test(entry.name)).map(entry => entry.name);
	}

	/** The ids filed in one fan directory; a file that is not a piece id, or is filed under another fan, is not one. */
	private async pieceIdsIn(fan: string): Promise<PieceId[]> {
		const entries = await fs.readdir(path.join(this.root, fan), { withFileTypes: true }).catch((err: unknown) => {
			if (errorCode(err) === 'ENOENT') return [];
			throw err;
		});
		return entries
			.filter(entry => entry.isFile() && PIECE_ID_PATTERN.test(entry.name) && fanOf(entry.name) === fan)
			.map(entry => entry.name as PieceId);
	}

	/** 0 for a piece deleted between the listing and the stat. */
	private async sizeOf(id: PieceId): Promise<number> {
		try {
			return (await fs.stat(pieceLocation(this.root, id).file)).size;
		} catch (err) {
			if (errorCode(err) === 'ENOENT') return 0;
			throw err;
		}
	}
}
