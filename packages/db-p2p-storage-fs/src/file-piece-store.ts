import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'node:crypto';
import { rawPieceIdOfDigest, type PieceId } from '@optimystic/db-core';
import type { ImportedPiece, IPieceStore, IPieceStoreFiles, StoreDurability, StoreIdentity } from '@optimystic/db-p2p';
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
 * How much of a piece an export copies at a time. A leaf this repository cuts is 256 KiB and the
 * largest piece it accepts from anywhere is 1 MiB (`MAX_BLOB_PIECE_BYTES`), so a piece is one chunk
 * or a few.
 */
const EXPORT_CHUNK_BYTES = 256 * 1024;

/**
 * Fills `buffer` from the handle's current position, answering how many bytes it got: short of the
 * buffer's length only at the end of the file. A single `read` may answer fewer bytes than it was
 * asked for without being at the end, and an import that took that for the end would cut a leaf
 * shorter than `pieceSize` — a different cut from a stream put's, so a different blob.
 */
async function readFully(handle: fs.FileHandle, buffer: Uint8Array): Promise<number> {
	let filled = 0;
	while (filled < buffer.byteLength) {
		const { bytesRead } = await handle.read(buffer, filled, buffer.byteLength - filled, null);
		if (bytesRead <= 0) break;
		filled += bytesRead;
	}
	return filled;
}

/** As `writeAll` in file-write-log.ts; not shared because exporting it would widen this package's API. */
async function writeAll(handle: fs.FileHandle, bytes: Uint8Array): Promise<void> {
	let written = 0;
	while (written < bytes.byteLength) {
		const { bytesWritten } = await handle.write(bytes, written, bytes.byteLength - written);
		if (bytesWritten <= 0) throw new Error('an export wrote nothing');
		written += bytesWritten;
	}
}

/** Appends a stored piece's bytes to the open export, through `buffer`. A missing piece's ENOENT propagates. */
async function copyPieceInto(out: fs.FileHandle, file: string, buffer: Uint8Array): Promise<void> {
	const source = await fs.open(file, 'r');
	try {
		for (;;) {
			const filled = await readFully(source, buffer);
			if (filled > 0) await writeAll(out, buffer.subarray(0, filled));
			if (filled < buffer.byteLength) return;
		}
	} finally {
		await source.close().catch((err: unknown) => log('export:piece-close-failed file=%s - %o', file, err));
	}
}

/**
 * The filesystem {@link IPieceStore}: one file per piece under `<basePath>/optimystic-pieces/`,
 * named by its id and holding exactly its bytes, fanned out by {@link fanOf}. A put writes the piece
 * to `incoming/`, syncs it, and renames it into place, so after a crash a piece's name holds the
 * whole piece or nothing; the directory entry becomes durable at the next {@link flush}. No
 * write-ahead log, no write group and no lock: content-addressed files written by rename need none
 * to stay consistent (docs/blobs.md §The local store).
 *
 * It also offers {@link IPieceStoreFiles}: on Node the pieces are already files, so an import is a
 * read and a SHA-256 per leaf through the same write steps a put uses, and an export is a join into
 * a temp beside the target and a rename over it (docs/blobs.md §Putting and reading by file path).
 * The bytes are hashed by `node:crypto` and never leave typed arrays: neither base64 nor the blob
 * service's own digest port is on the path.
 *
 * NOTE: two `FilePieceStore`s over one directory, in one process or two, are not supported: the
 * second's open deletes the first's in-flight temps, failing its put. One process per store is what a
 * host already keeps (Invariant 5 of `packages/db-p2p/docs/storage.md`), and `FileRawStorage`'s lock
 * is not taken here because a second taker in the same process would be refused by it.
 */
export class FilePieceStore implements IPieceStore, IPieceStoreFiles {
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
		await this.storePiece(location, id, bytes);
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

	// --- files ---

	/**
	 * Cuts the file into leaves of exactly `pieceSize` bytes (the last shorter, one empty leaf for an
	 * empty file), names each by the SHA-256 of its bytes, and stores it through the same steps `put`
	 * uses. One leaf at a time, so an import of any file holds one `pieceSize` buffer; a read error
	 * rejects and the leaves already stored stay, for the blob service's sweep to collect as it does
	 * after a stream put that failed part way.
	 *
	 * NOTE: the read of a leaf and the write of the leaf before it do not overlap, so an import runs
	 * at a read and a write in turn rather than both at once; if importing a large file ever shows up
	 * slow, overlap them with a second buffer rather than reading more of the file into memory.
	 *
	 * NOTE: a file another writer is changing under the import is read as it reads — the leaves
	 * describe the bytes this call saw, which need not be any version of the file that existed whole.
	 * No lock is taken because not every platform this capability is meant for has one, and the
	 * caller chose the file.
	 */
	async importFile(filePath: string, pieceSize: number): Promise<ImportedPiece[]> {
		// A size of zero or less would make the loop below cut leaves for ever.
		if (!Number.isSafeInteger(pieceSize) || pieceSize <= 0) {
			throw new RangeError(`A piece size is a whole number of bytes above zero, not ${pieceSize}`);
		}
		await this.open();
		// `fs` reads and writes any typed array, so no `Buffer` is needed (the lint rule that bans the
		// global is in eslint.config.js: it is absent under React Native's engine).
		const buffer = new Uint8Array(pieceSize);
		const leaves: ImportedPiece[] = [];
		const handle = await fs.open(filePath, 'r');
		try {
			for (;;) {
				const filled = await readFully(handle, buffer);
				// Nothing left to cut: a file whose length is a multiple of the piece size ends here,
				// its last full leaf already stored. An empty file is one empty leaf, not no leaves.
				if (filled === 0 && leaves.length > 0) break;
				leaves.push(await this.storeLeaf(buffer.subarray(0, filled)));
				if (filled < pieceSize) break;
			}
		} finally {
			// A read handle's close says nothing about the result, and must not mask a read's error.
			await handle.close().catch((err: unknown) => log('import:close-failed path=%s - %o', filePath, err));
		}
		log('import:done path=%s leaves=%d', filePath, leaves.length);
		return leaves;
	}

	/**
	 * Joins the pieces into a temp beside `target` and renames it over `target`, so `target` holds
	 * the whole result or is left exactly as it was: a missing piece, or any other failure, removes
	 * the temp and rejects. The temp's directory is synced after the rename, as a flush syncs a fan
	 * directory, so the new name survives the crashes {@link durability} names.
	 */
	async exportFile(ids: readonly PieceId[], target: string): Promise<void> {
		// Every id is turned into a path before anything is written, so a refused one leaves no temp.
		const files = ids.map(id => pieceLocation(this.root, id).file);
		await this.open();
		const resolved = path.resolve(target);
		const directory = path.dirname(resolved);
		const temp = path.join(directory, `.${path.basename(resolved)}.${randomBytes(8).toString('hex')}.tmp`);
		const handle = await fs.open(temp, 'wx');
		try {
			const buffer = new Uint8Array(EXPORT_CHUNK_BYTES);
			for (const file of files) await copyPieceInto(handle, file, buffer);
			// Synced before the rename, for the reason `writeTemp` syncs a piece: a rename of unsynced
			// bytes can leave the target truncated after a power cut, where the caller reads a short
			// blob rather than none.
			await handle.sync();
			await handle.close();
			// NOTE: on win32 `fs.rename` replaces an existing target, but is refused (EPERM) while
			// another handle holds that target open; the export then rejects with the target untouched,
			// which is the contract. Nothing is retried here: a piece's refused rename means another
			// put of the same id may have won and `moveIntoPlace` can settle it by looking, while the
			// target of an export is the caller's file and waiting on whoever holds it open is the
			// caller's call. If a host meets this, retry the rename for a bounded time before rejecting.
			await fs.rename(temp, resolved);
		} catch (err) {
			// Closing an already-closed handle resolves, so the rename's failure takes this path too.
			await handle.close().catch((closeErr: unknown) => log('export:close-failed temp=%s - %o', temp, closeErr));
			await unlinkIfPresent(temp).catch((unlinkErr: unknown) => log('export:unlink-failed temp=%s - %o', temp, unlinkErr));
			throw err;
		}
		await fsyncDir(directory);
		log('export:done path=%s pieces=%d', resolved, files.length);
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

	/**
	 * The write half of `put`, which an import's leaves take too: nothing at all when the piece is
	 * already stored, otherwise a temp, a sync and a rename into the fan directory. The caller has
	 * opened the store and turned the id into `location`, which is where the id is checked.
	 */
	private async storePiece(location: PieceLocation, id: PieceId, bytes: Uint8Array): Promise<void> {
		if (!await exists(location.file)) {
			await this.ensureFanDirectory(location.fanDirectory);
			const temp = await this.writeTemp(bytes);
			await this.moveIntoPlace(id, temp, location.file);
		}
		// Also when the piece was already there: a concurrent put of the id may have renamed it
		// without having marked the directory yet, and a flush after this put must cover the entry.
		this.dirty.add(location.fanDirectory);
	}

	/** One leaf of an import: its id from its own bytes, then the write steps `put` takes. */
	private async storeLeaf(bytes: Uint8Array): Promise<ImportedPiece> {
		const id = rawPieceIdOfDigest(createHash('sha256').update(bytes).digest());
		await this.storePiece(pieceLocation(this.root, id), id, bytes);
		return { id, size: bytes.byteLength };
	}

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
