import assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import { FileRawStorage } from '../src/index.js';
import { CachedRawStorage, SharedCachePool } from '@optimystic/db-p2p';

// FileStoreDriver names the RESOLVED directory it is backed by, so two storages over one
// directory — however spelled — compare equal, and two over different directories do not.
describe('FileRawStorage store identity', () => {
	const base = path.join(os.tmpdir(), 'optimystic-fs-identity');

	it('is scheme-prefixed with the resolved path', () => {
		const identity = new FileRawStorage(base).getStoreIdentity();
		assert.strictEqual(typeof identity, 'string');
		assert.ok(identity.startsWith('file:'), `expected a file: prefix, got ${identity}`);
	});

	it('normalizes an equivalent spelling of the same directory to one identity', () => {
		// `<base>/sub/..` resolves to `<base>` — same directory, so same identity.
		const direct = new FileRawStorage(base).getStoreIdentity();
		const roundabout = new FileRawStorage(path.join(base, 'sub', '..')).getStoreIdentity();
		assert.strictEqual(roundabout, direct);
	});

	it('gives a different directory a different identity', () => {
		const a = new FileRawStorage(path.join(base, 'a')).getStoreIdentity();
		const b = new FileRawStorage(path.join(base, 'b')).getStoreIdentity();
		assert.notStrictEqual(a, b);
	});

	it('is stable across repeated calls on one storage', () => {
		const storage = new FileRawStorage(base);
		assert.strictEqual(storage.getStoreIdentity(), storage.getStoreIdentity());
	});

	// Windows paths are case-insensitive, so `C:\Foo` and `C:\foo` are ONE directory and must
	// fold to ONE identity. Off win32 the driver does not fold, so the two spellings stay
	// distinct — correct on a case-sensitive volume, and a known alias miss on a case-insensitive
	// one (e.g. a default macOS volume). See the alias NOTE in FileStoreDriver.
	it('treats case-differing spellings as one directory on win32 only', function () {
		const lower = new FileRawStorage(path.join(base, 'casetest')).getStoreIdentity();
		const upper = new FileRawStorage(path.join(base, 'CaseTest')).getStoreIdentity();
		if (process.platform === 'win32') {
			assert.strictEqual(upper, lower);
		} else {
			assert.notStrictEqual(upper, lower);
		}
	});

	// `path.resolve` is cwd-dependent and captured at construction — deliberately. Two storages
	// built from the same RELATIVE path under different cwds address different directories.
	it('resolves a relative basePath against the cwd at construction time', () => {
		const relative = new FileRawStorage('relative-store').getStoreIdentity();
		const absolute = new FileRawStorage(path.resolve('relative-store')).getStoreIdentity();
		assert.strictEqual(relative, absolute);
	});

	it('does not crash on an empty basePath (resolves to the cwd)', () => {
		const empty = new FileRawStorage('').getStoreIdentity();
		assert.strictEqual(empty, new FileRawStorage(process.cwd()).getStoreIdentity());
	});

	// The composition the whole passthrough chain exists for, and the one the `IRawStorage`
	// doc comment promises by name. Each half is covered elsewhere (fs identity above; the
	// wrapper chain over a synthetic driver in db-p2p's store-identity.spec.ts), but the
	// end-to-end join across the two packages was asserted nowhere.
	describe('through CachedRawStorage', () => {
		it('a cache over a FileRawStorage reports the file identity unchanged', () => {
			const inner = new FileRawStorage(base);
			const cached = new CachedRawStorage(inner, new SharedCachePool());
			assert.strictEqual(cached.getStoreIdentity?.(), inner.getStoreIdentity());
			assert.strictEqual(cached.getStoreIdentity?.(), `file:${process.platform === 'win32' ? path.resolve(base).toLowerCase() : path.resolve(base)}`);
		});

		it('two independent caches over ONE directory report equal identities', () => {
			// The exact fact an identity-keyed dedupe keys on: two caches built separately over
			// the same directory are two objects naming one store.
			const pool = new SharedCachePool();
			const a = new CachedRawStorage(new FileRawStorage(base), pool);
			const b = new CachedRawStorage(new FileRawStorage(base), pool);
			assert.strictEqual(a.getStoreIdentity?.(), b.getStoreIdentity?.());
		});

		it('caches over DIFFERENT directories report different identities', () => {
			const pool = new SharedCachePool();
			const a = new CachedRawStorage(new FileRawStorage(path.join(base, 'a')), pool);
			const b = new CachedRawStorage(new FileRawStorage(path.join(base, 'b')), pool);
			assert.notStrictEqual(a.getStoreIdentity?.(), b.getStoreIdentity?.());
		});
	});
});
