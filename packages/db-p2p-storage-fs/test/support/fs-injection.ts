import { promises as fs } from 'fs';

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
