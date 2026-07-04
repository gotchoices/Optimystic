import { promises as fs } from 'fs';
import * as path from 'path';

// Per-process monotonic counter for unique temp names. Combined with the pid it
// makes each temp path unique across concurrent writers to the same logical
// target — even two FileRawStorage/FileKVStore instances in one process, which
// do not lock (see the proper-lockfile TODO in file-storage.ts). Deterministic
// and collision-safe, unlike Math.random()/Date.now().
let tempCounter = 0;

/**
 * Atomically write `content` to `filePath`.
 *
 * Writes to a unique `*.tmp` sibling, fsyncs the data, then renames it into
 * place. `rename` over an existing file is atomic on POSIX and NTFS, so a
 * concurrent reader only ever sees the complete old file or the complete new
 * file — never a torn/half-written one. After the rename we best-effort fsync
 * the containing directory so the rename itself survives power loss on POSIX;
 * that directory fsync is unsupported on win32 and its error is swallowed.
 *
 * On any failure the temp file is removed (best-effort) so a crashed write does
 * not leave the canonical path damaged. A crash *between* the temp write and the
 * rename leaves only an inert `*.tmp` sibling — never read (reads target
 * canonical paths) and skipped by `.json` directory scans.
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
	const dir = path.dirname(filePath);
	await fs.mkdir(dir, { recursive: true });

	// Suffix ends in `.tmp` (not `.json`) so listPendingTransactions / FileKVStore.list,
	// which filter on `.json`, never surface an in-flight temp file.
	// NOTE: a crash between open and rename leaves an inert `*.tmp` orphan (never read,
	// skipped by `.json` scans). No cleanup sweep exists; if a crash-looping writer ever
	// accumulates many, add a startup sweep of stale `*.tmp` siblings.
	const tmpPath = path.join(dir, `${path.basename(filePath)}.${process.pid}.${tempCounter++}.tmp`);

	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(tmpPath, 'w');
		await handle.writeFile(content);
		await handle.sync();
		await handle.close();
		handle = undefined;
		// NOTE: on win32, rename-over-existing can throw EPERM/EACCES/EBUSY if a
		// concurrent reader holds the target open without FILE_SHARE_DELETE (Node
		// readIfExists/get open→read→close in a tiny window, so it's rare). Modern
		// libuv retries some cases; if this ever surfaces as spurious write failures
		// under concurrent read+write on Windows, add a bounded retry loop here (the
		// write-file-atomic package does exactly this). Conditional — the adapter is
		// already last-writer-wins with no cross-process lock (proper-lockfile TODO
		// in file-storage.ts), so it is not reachable under current single-writer use.
		await fs.rename(tmpPath, filePath);
	} catch (err) {
		if (handle) await handle.close().catch(() => { /* best-effort */ });
		await fs.unlink(tmpPath).catch(() => { /* best-effort: temp may not exist */ });
		throw err;
	}

	await fsyncDir(dir);
}

/**
 * Best-effort fsync of a directory so a completed rename is durable. POSIX needs
 * this; win32 (and platforms that reject opening a directory for fsync) throw,
 * and we ignore that rather than failing the write.
 */
async function fsyncDir(dir: string): Promise<void> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(dir, 'r');
		await handle.sync();
	} catch {
		// Directory fsync unsupported here (e.g. win32) — nothing to do.
	} finally {
		if (handle) await handle.close().catch(() => { /* best-effort */ });
	}
}
