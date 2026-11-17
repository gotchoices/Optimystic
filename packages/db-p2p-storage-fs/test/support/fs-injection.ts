import { promises as fs } from 'fs';
import * as path from 'path';

type OpenFn = (...args: unknown[]) => Promise<fs.FileHandle>;

/**
 * Wraps `fs.promises.open` so every handle opened while the wrapper is installed runs `onSync`
 * before its `sync`. `file-write-log.ts` holds the same `fs.promises` singleton and reads `open`
 * off it at call time, so the log's own handle — opened on the store's first operation — is
 * wrapped when the wrapper is installed before that. Returns the restore; always call it in a
 * `finally` so one test's injection never leaks into another.
 */
export function interceptHandleSync(onSync: () => void): () => void {
	const target = fs as unknown as { open: OpenFn };
	const original = target.open;
	target.open = async (...args: unknown[]) => {
		const handle = await original.apply(fs, args);
		const sync = handle.sync.bind(handle);
		handle.sync = async () => {
			onSync();
			return sync();
		};
		return handle;
	};
	return () => { target.open = original; };
}

export interface ParkedSync {
	/** The path the handle was opened on, resolved. */
	readonly path: string;
	/** Let the sync run. */
	release(): void;
	/** Settles once the handle the sync was made on has been closed, which is when the caller's sync step ends. */
	readonly closed: Promise<void>;
}

export interface SyncParking {
	/** Resolves with the oldest parked sync, not yet handed out, whose path satisfies `match`. */
	parked(match: (filePath: string) => boolean): Promise<ParkedSync>;
	/** How many syncs whose path satisfies `match` have started. */
	started(match: (filePath: string) => boolean): number;
	/** The most syncs whose path satisfies `match` that were ever in flight at once, parked or running. */
	mostInFlight(match: (filePath: string) => boolean): number;
	/** Stop parking: release every parked sync and let later ones straight through. */
	releaseAll(): void;
	restore(): void;
}

/**
 * Wraps `fs.promises.open`, like {@link interceptHandleSync}, so a `sync` on a handle whose path
 * satisfies `shouldPark` — asked as the sync is called — waits until the test releases it. Every
 * sync's start and end is recorded, parked or not, so a test can tell how many of one kind were in
 * flight at once; a test tells the log's own handle from a tree file's by `FileWriteLog.logPath`.
 * Restore in a `finally`, after {@link SyncParking.releaseAll}.
 */
export function parkHandleSyncs(shouldPark: (filePath: string) => boolean): SyncParking {
	const target = fs as unknown as { open: OpenFn };
	const original = target.open;
	const events: { path: string; delta: 1 | -1 }[] = [];
	const unclaimed: ParkedSync[] = [];
	const claims: { match: (filePath: string) => boolean; resolve: (parked: ParkedSync) => void }[] = [];
	const releases: (() => void)[] = [];
	let parking = true;

	const hand = (parked: ParkedSync): void => {
		const at = claims.findIndex(claim => claim.match(parked.path));
		if (at >= 0) claims.splice(at, 1)[0]!.resolve(parked);
		else unclaimed.push(parked);
	};

	const park = (filePath: string, closed: Promise<void>): Promise<void> => new Promise(release => {
		releases.push(release);
		hand({ path: filePath, release, closed });
	});

	target.open = async (...args: unknown[]) => {
		const handle = await original.apply(fs, args);
		const filePath = path.resolve(String(args[0]));
		const close = handle.close.bind(handle);
		let markClosed!: () => void;
		const closed = new Promise<void>(resolve => { markClosed = resolve; });
		handle.close = async () => {
			try {
				return await close();
			} finally {
				markClosed();
			}
		};
		const sync = handle.sync.bind(handle);
		handle.sync = async () => {
			events.push({ path: filePath, delta: 1 });
			try {
				if (parking && shouldPark(filePath)) await park(filePath, closed);
				return await sync();
			} finally {
				events.push({ path: filePath, delta: -1 });
			}
		};
		return handle;
	};

	return {
		parked: match => {
			const at = unclaimed.findIndex(parked => match(parked.path));
			if (at >= 0) return Promise.resolve(unclaimed.splice(at, 1)[0]!);
			return new Promise(resolve => claims.push({ match, resolve }));
		},
		started: match => events.filter(event => event.delta === 1 && match(event.path)).length,
		mostInFlight: match => {
			let inFlight = 0;
			let most = 0;
			for (const event of events) {
				if (!match(event.path)) continue;
				inFlight += event.delta;
				most = Math.max(most, inFlight);
			}
			return most;
		},
		releaseAll: () => {
			parking = false;
			for (const release of releases.splice(0)) release();
		},
		restore: () => { target.open = original; },
	};
}

/**
 * Makes `fs.promises.writeFile` throw for the duration of `fn` — the tree write a commit makes
 * after its record is durable, so the crash between the log sync and the apply can be staged.
 * Restored in a `finally`.
 */
export async function withFailingWriteFile(fn: () => Promise<void>): Promise<void> {
	const target = fs as unknown as { writeFile: unknown };
	const original = target.writeFile;
	target.writeFile = async () => { throw new Error('injected crash before the tree write'); };
	try {
		await fn();
	} finally {
		target.writeFile = original;
	}
}

export interface ParkedUnlink {
	/** Resolves when `fs.promises.unlink` is called on the target. */
	readonly reached: Promise<void>;
	/** Let the parked unlink go: it runs, or throws `failure` without unlinking when one is given. */
	proceed(failure?: Error): void;
	restore(): void;
}

/**
 * Parks `fs.promises.unlink` of one path until {@link ParkedUnlink.proceed}, so a test can act
 * while a checkpoint stands between its sync and its truncate, and then let the truncate succeed
 * or fail. Unlinks of every other path pass straight through. Restore in a `finally`.
 */
export function parkUnlink(target: string): ParkedUnlink {
	const fsTarget = fs as unknown as { unlink: (filePath: unknown) => Promise<void> };
	const original = fsTarget.unlink;
	let arrived!: () => void;
	const reached = new Promise<void>(resolve => { arrived = resolve; });
	let release!: (failure: Error | undefined) => void;
	const released = new Promise<Error | undefined>(resolve => { release = resolve; });
	fsTarget.unlink = async (filePath: unknown) => {
		if (path.resolve(String(filePath)) !== path.resolve(target)) return original.call(fs, filePath);
		arrived();
		const failure = await released;
		if (failure) throw failure;
		return original.call(fs, filePath);
	};
	return {
		reached,
		proceed: failure => release(failure),
		restore: () => { fsTarget.unlink = original; },
	};
}

/** Calls `onRename` with each `fs.promises.rename`'s destination before it runs. Returns the restore; call it in a `finally`. */
export function interceptRename(onRename: (to: string) => void): () => void {
	const target = fs as unknown as { rename: (from: unknown, to: unknown) => Promise<void> };
	const original = target.rename;
	target.rename = async (from: unknown, to: unknown) => {
		onRename(String(to));
		return original.call(fs, from, to);
	};
	return () => { target.rename = original; };
}
