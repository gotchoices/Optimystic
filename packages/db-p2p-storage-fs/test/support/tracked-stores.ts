import { FileKVStore, FileRawStorage, type FileKVStoreOptions, type FileRawStorageOptions } from '../../src/index.js';

/**
 * Opens stores a test can forget about: every store opened here is closed by {@link closeAll},
 * which an `afterEach` runs before the temp directory is removed. A store holds the directory's
 * write-ahead log handle and lock from its first operation until it is closed, so closing is what
 * releases the lock and lets the directory go cleanly on every platform.
 */
export interface TrackedStores {
	open(base: string, options?: FileRawStorageOptions): FileRawStorage;
	openKv(base: string, options?: FileKVStoreOptions): FileKVStore;
	closeAll(): Promise<void>;
}

export function trackedStores(): TrackedStores {
	const opened: { close(): Promise<void> }[] = [];
	const track = <T extends { close(): Promise<void> }>(store: T): T => {
		opened.push(store);
		return store;
	};
	return {
		open: (base, options) => track(new FileRawStorage(base, options)),
		openKv: (base, options) => track(new FileKVStore(base, options)),
		async closeAll() {
			for (const store of opened.splice(0)) {
				// A store latched failed rejects its close after releasing its log; the test that
				// latched it has already asserted on the failure, and the release is what matters here.
				// Closing one already closed is a no-op flush and a release of nothing.
				await store.close().catch(() => { /* released regardless */ });
			}
		},
	};
}
