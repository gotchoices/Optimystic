import { FileRawStorage, type FileRawStorageOptions } from '../../src/index.js';

/**
 * Opens stores a test can forget about: every store opened here is closed by {@link closeAll},
 * which an `afterEach` runs before the temp directory is removed. A store holds the directory's
 * write-ahead log handle and lock from its first operation until it is closed, so closing is what
 * releases the lock and lets the directory go cleanly on every platform.
 */
export interface TrackedStores {
	open(base: string, options?: FileRawStorageOptions): FileRawStorage;
	closeAll(): Promise<void>;
}

export function trackedStores(): TrackedStores {
	const opened: FileRawStorage[] = [];
	return {
		open(base, options) {
			const storage = new FileRawStorage(base, options);
			opened.push(storage);
			return storage;
		},
		async closeAll() {
			for (const storage of opened.splice(0)) {
				// A store latched failed rejects its close after releasing its backend; the test that
				// latched it has already asserted on the failure, and the release is what matters here.
				await storage.close().catch(() => { /* released regardless */ });
			}
		},
	};
}
