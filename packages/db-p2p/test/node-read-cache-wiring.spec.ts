import { expect } from 'chai';
import { createLibp2pNode } from '../src/libp2p-node.js';
import { KvRawStorage } from '../src/storage/kv-raw-storage.js';
import { MemoryStoreDriver } from '../src/storage/memory-store-driver.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import { CachedRawStorage } from '../src/storage/cached-raw-storage.js';
import { defaultCachePool } from '../src/storage/shared-cache-pool.js';

/**
 * The node half of the read-cache wiring: `resolveStorage` wraps a host-supplied persistent
 * storage, and the stop wrapper releases the cache it built. Both were previously verified only
 * by reading the code — the largest untested surface in the change — on the belief that a node
 * spin-up was too slow to justify. It is not: the node below comes up and goes down in well
 * under a second (the seconds a run of this file costs are mocha/ts-node startup, paid once for
 * the whole suite either way).
 *
 * Observed through `defaultCachePool().stats().stores` rather than through the node, because the
 * resolved `IRawStorage` is deliberately absent from `OptimysticNodeAttachments` (node-internal
 * wiring) — and the pool row is the stronger assertion anyway: it proves the cache registered
 * under this node's label and that stop retired that exact registration.
 *
 * Counts are compared as deltas against the pool's state at entry. This is the process-wide
 * default pool that production seams use, and a sibling spec may have left its own stores in it.
 */
describe('libp2p node read-cache wiring (resolveStorage / stop release)', function () {
	this.timeout(60_000);

	const labels = (): string[] => defaultCachePool().stats().stores.map(s => s.label ?? '');

	async function spawn(networkName: string, storage?: unknown) {
		return await createLibp2pNode({
			port: 0,
			networkName,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 1,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: false },
			...(storage === undefined ? {} : { storage }),
		} as any);
	}

	it('wraps a host-supplied persistent storage and retires the cache when the node stops', async () => {
		const networkName = 'read-cache-wiring';
		const label = `node:${networkName}`;
		expect(labels(), 'nothing registered under this label yet').to.not.include(label);

		// A KvRawStorage over the memory driver is "persistent host storage" as far as the seam is
		// concerned — the same path FileRawStorage takes, without touching a disk.
		const node: any = await spawn(networkName, new KvRawStorage(new MemoryStoreDriver()));
		try {
			expect(labels(), 'resolveStorage put the read cache in front of it').to.include(label);
		} finally {
			await node.stop();
		}
		expect(labels(), 'the stop wrapper released the registration it created').to.not.include(label);
	});

	it('leaves a MemoryRawStorage unwrapped (nothing to cache, nothing to release)', async () => {
		const networkName = 'read-cache-wiring-memory';
		const before = defaultCachePool().stats().stores.length;

		const node: any = await spawn(networkName, new MemoryRawStorage());
		try {
			expect(labels(), 'memory storage is excluded at the seam').to.not.include(`node:${networkName}`);
			expect(defaultCachePool().stats().stores.length, 'no store registered at all').to.equal(before);
		} finally {
			await node.stop();
		}
		expect(defaultCachePool().stats().stores.length).to.equal(before);
	});

	it('does not dispose a CachedRawStorage the host supplied and still owns', async () => {
		// A host sharing one store across concurrent in-process consumers builds the cache itself
		// and hands that same object to each (see `withReadCache`). Stopping one node must not
		// clear and unregister it — the other consumers are still reading through it.
		const networkName = 'read-cache-wiring-shared';
		const shared = new CachedRawStorage(new KvRawStorage(new MemoryStoreDriver()), undefined, 'host-owned-node-store');
		try {
			const node: any = await spawn(networkName, shared);
			await node.stop();
			expect(labels(), 'the host keeps its store after the node it lent it to stops')
				.to.include('host-owned-node-store');
			expect(labels(), 'and the node never registered a second cache over it').to.not.include(`node:${networkName}`);
		} finally {
			await shared.dispose();
		}
		expect(labels()).to.not.include('host-owned-node-store');
	});

	it('two nodes over one uncached instance share one cache; the first stop keeps it, the last retires it', async () => {
		// The seam dedupes per backing store (`withReadCache`), so two concurrently running nodes
		// handed the same storage read and write through ONE cache under two leases. Stopping the
		// first releases its lease only — the second must keep reading through a registered cache
		// — and stopping the second retires the registration.
		const first = 'read-cache-wiring-shared-a';
		const second = 'read-cache-wiring-shared-b';
		const storage = new KvRawStorage(new MemoryStoreDriver());
		const before = defaultCachePool().stats().stores.length;

		const nodeA: any = await spawn(first, storage);
		let nodeB: any;
		try {
			nodeB = await spawn(second, storage);
			expect(defaultCachePool().stats().stores.length, 'one registration for both nodes').to.equal(before + 1);
			expect(labels(), 'labelled by whichever node wrapped first').to.include(`node:${first}`);
			expect(labels()).to.not.include(`node:${second}`);

			await nodeA.stop();
			expect(labels(), 'the first node stopping does not retire the cache the second still reads through')
				.to.include(`node:${first}`);
		} finally {
			await nodeB?.stop();
		}
		expect(defaultCachePool().stats().stores.length, 'the last lease releasing retired the registration').to.equal(before);
		expect(labels()).to.not.include(`node:${first}`);
	});
});
