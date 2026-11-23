/**
 * The node a `network` transactor builds keeps its storage where the plugin's `storageFactory` says.
 *
 * That is the capability the one-storage-setting narrowing added: before it, the plugin's own node
 * was built with no `storage` at all and kept its blocks, blob pieces and blob records in memory, so
 * a blob pinned through `plugin.blobs` was lost on restart unless the host built and registered a
 * node by hand.
 *
 * Two assertions, and both are load-bearing. The host's piece store must receive the put — which is
 * what says the node was handed this storage rather than keeping its own. AND the resolved backend's
 * service must be the node's own `NodeBlobService`: the single-machine arm of
 * `CollectionFactory.resolveBlobBackend` now reads the same `pieces`, so a plugin that fell through
 * to it — a node built without a blob service, or no node built at all — would satisfy the first
 * assertion on its own.
 *
 * Real libp2p, so gated on OPTIMYSTIC_INTEGRATION=1 as every real-node spec in this package is:
 *   yarn workspace @optimystic/quereus-plugin-optimystic test:integration
 */
import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { NodeBlobService, memoryNodeStorage, type NodeStorage } from '@optimystic/db-p2p';
import register from '../dist/plugin.js';

type Plugin = ReturnType<typeof register>;

const NETWORK_NAME = 'plugin-node-storage-it';

/** Every id the store holds, drained so the assertion reads a number rather than a cursor. */
async function storedPieceIds(storage: NodeStorage): Promise<string[]> {
	const ids: string[] = [];
	for await (const id of storage.pieces.list()) ids.push(id);
	return ids;
}

describe("A network transactor's node keeps its storage where storageFactory says", function () {
	this.timeout(120_000);

	before(function () {
		if (!process.env.OPTIMYSTIC_INTEGRATION) this.skip();
	});

	let db: Database | undefined;
	let plugin: Plugin | undefined;

	afterEach(async () => {
		if (db !== undefined) await db.close();
		if (plugin !== undefined) {
			await plugin.dispose();
			// `plugin.dispose()` reaches everything the plugin owns but does not stop the libp2p node
			// the factory BUILT; `shutdown` does, and is safe after a dispose.
			await plugin.collectionFactory.shutdown();
		}
		db = undefined;
		plugin = undefined;
	});

	it("puts the blob's pieces in the host's store, through the node's own blob service", async () => {
		// One value for all of it, as a host's storage package would return. In memory because what is
		// under test is WHOSE stores the node was given, not whether they outlive the process.
		const storage: NodeStorage = memoryNodeStorage();
		db = new Database();
		plugin = register(db, {
			default_transactor: 'network',
			default_key_network: 'libp2p',
			default_network_name: NETWORK_NAME,
			enable_cache: false,
			storageFactory: () => storage,
		} as unknown as Record<string, SqlValue>);
		for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
		for (const func of plugin.functions) db.registerFunction(func.schema);

		expect(await storedPieceIds(storage), 'precondition: nothing stored yet').to.have.lengthOf(0);

		// Resolving the default network is what builds the node, so the put is also the first thing to
		// hand it this storage.
		await plugin.blobs.put((async function* () { yield new Uint8Array([1, 2, 3]); })());

		expect(await storedPieceIds(storage), "the host's piece store holds the blob").to.have.lengthOf(1);

		const backends = await plugin.collectionFactory.knownBlobBackends();
		expect(backends.map(backend => backend.key)).to.deep.equal(['network:libp2p']);
		expect(backends[0]!.service, 'served by the node, not by the single-machine fallback')
			.to.be.instanceOf(NodeBlobService);
	});
});
