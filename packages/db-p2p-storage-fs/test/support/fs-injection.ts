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
