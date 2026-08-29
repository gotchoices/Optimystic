import { expect } from 'chai';
import { identityForHandle } from '../src/storage/store-identity.js';
import type { StoreIdentity } from '../src/storage/store-identity.js';
import type { RawStoreDriver } from '../src/storage/raw-store-driver.js';
import { KvRawStorage } from '../src/storage/kv-raw-storage.js';
import { MemoryStoreDriver } from '../src/storage/memory-store-driver.js';
import { CachedRawStorage } from '../src/storage/cached-raw-storage.js';
import { SharedCachePool } from '../src/storage/shared-cache-pool.js';

// A driver that DOES report an identity: MemoryStoreDriver deliberately does not (two memory
// drivers are two genuinely different stores), so identity-carrying cases wrap one in this.
class IdentifiedDriver extends MemoryStoreDriver {
	constructor(private readonly id: StoreIdentity) {
		super();
	}
	storeIdentity(): StoreIdentity {
		return this.id;
	}
}

describe('store identity', () => {
	describe('identityForHandle', () => {
		it('returns the same string for the same object across calls', () => {
			const handle = {};
			expect(identityForHandle('test-handle', handle)).to.equal(identityForHandle('test-handle', handle));
		});

		it('returns different strings for different objects', () => {
			expect(identityForHandle('test-handle', {})).to.not.equal(identityForHandle('test-handle', {}));
		});

		it('returns different strings for one object under two schemes', () => {
			const handle = {};
			expect(identityForHandle('scheme-a', handle)).to.not.equal(identityForHandle('scheme-b', handle));
		});

		it('scheme-prefixes its result', () => {
			expect(identityForHandle('my-scheme', {})).to.match(/^my-scheme:/);
		});
	});

	describe('passthrough', () => {
		it('two KvRawStorage over ONE identified driver report equal identities', () => {
			const driver = new IdentifiedDriver('test:shared' as StoreIdentity);
			const a = new KvRawStorage(driver);
			const b = new KvRawStorage(driver);
			expect(a.getStoreIdentity?.()).to.equal('test:shared');
			expect(a.getStoreIdentity?.()).to.equal(b.getStoreIdentity?.());
		});

		it('the full wrapper chain reports the innermost driver identity', () => {
			// CachedRawStorage → CachedStoreDriver → RawStorageDriverAdapter → KvRawStorage → driver.
			// A cache and the storage it fronts must name the SAME store.
			const driver = new IdentifiedDriver('test:chained' as StoreIdentity);
			const inner = new KvRawStorage(driver);
			const cached = new CachedRawStorage(inner, new SharedCachePool());
			expect(cached.getStoreIdentity?.()).to.equal('test:chained');
			expect(cached.getStoreIdentity?.()).to.equal(inner.getStoreIdentity?.());
		});
	});

	describe('feature detection', () => {
		it('a driver WITHOUT identity leaves getStoreIdentity undefined on the storage object', () => {
			// Pins the contract itself, not just an undefined return: a stub method would defeat
			// every consumer that feature-detects before deduping.
			const storage = new KvRawStorage(new MemoryStoreDriver());
			expect(storage.getStoreIdentity).to.equal(undefined);
		});

		it('the wrapper chain over an identity-less driver stays identity-less throughout', () => {
			const inner = new KvRawStorage(new MemoryStoreDriver());
			const cached = new CachedRawStorage(inner, new SharedCachePool());
			expect(cached.getStoreIdentity).to.equal(undefined);
		});

		it('MemoryStoreDriver reports no identity (two memory stores are genuinely two stores)', () => {
			const driver: RawStoreDriver = new MemoryStoreDriver();
			expect(driver.storeIdentity).to.equal(undefined);
		});
	});
});
