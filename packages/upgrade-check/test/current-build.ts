import { join } from 'node:path';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import register from '@optimystic/quereus-plugin-optimystic/plugin';
import { NetworkTransactor, type IRepo, type PeerId } from '@optimystic/db-core';
import { createLibp2pNode, RepoClient, type IRawStorage, type NodeStorage, type OptimysticNode } from '@optimystic/db-p2p';
import { FileKVStore, FilePieceStore, FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import { LevelDBKVStore, LevelDBPieceStore, LevelDBRawStorage } from '@optimystic/db-p2p-storage-rn';
import { privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { openClassicLevel } from '../writer/classic-level.mjs';
import type { FixtureManifest, StorageLayout } from './fixture.js';

/**
 * The working tree's build, started the way `writer/write-scenario.mjs` starts a published one:
 * one solo node over the same storage and the same identity, with a Quereus database over it. Only
 * the packages differ — which is the whole point.
 */
export interface CurrentBuild {
	node: OptimysticNode;
	/** The block storage the node was handed, over the older build's files. */
	storage: IRawStorage;
	transactor: NetworkTransactor;
	db: Database;
	plugin: ReturnType<typeof register>;
	stop(): Promise<void>;
}

export async function startCurrentBuild(dataDir: string, manifest: FixtureManifest): Promise<CurrentBuild> {
	const backend = await openBackend(dataDir, manifest.storage);
	const node = await createLibp2pNode({
		port: 0,
		networkName: manifest.networkName,
		bootstrapNodes: [],
		fretProfile: 'edge',
		clusterSize: 1,
		clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
		arachnode: { enableRingZulu: true },
		storage: backend.storage,
		privateKey: privateKeyFromProtobuf(Buffer.from(manifest.peerKey, 'base64')),
	});
	const transactor = nodeTransactor(node, manifest.networkName);
	const { db, plugin } = openDatabase(node, transactor, manifest.networkName);
	const stop = async (): Promise<void> => {
		db.close();
		await plugin.dispose();
		await node.stop();
		await backend.close();
	};
	try {
		// Loads the table definitions the older build persisted, so the catalog knows `users` and its
		// indexes before any statement names them.
		await plugin.hydrate(db);
	} catch (err) {
		// The caller never gets a handle to stop, so release the node and the store before rethrowing.
		await stop();
		throw err;
	}
	return { node, storage: backend.storage.blocks, transactor, db, plugin, stop };
}

interface OpenBackend {
	/**
	 * The node's storage over the older build's files. Hand-built rather than opened by one
	 * per-platform factory: this file's whole job is to reproduce the directory layout each release
	 * wrote, and for `fs` that is TWO directories (`blocks` and `kv`, as every fixture's `fs.json`
	 * manifest declares) — a layout no one-location factory can or should produce. The piece store
	 * sits over the same location as the blocks, which no fixture's build wrote a piece into.
	 */
	storage: NodeStorage;
	/** Releases what the node does not own: the three stores, and for LevelDB the handle they share, which no store closes. */
	close(): Promise<void>;
}

/** The current build's storage over the files the older build left, mirroring `BACKENDS` in the writer. */
async function openBackend(dataDir: string, layout: StorageLayout): Promise<OpenBackend> {
	switch (layout.backend) {
		case 'fs': {
			// Kept and closed here: the node never closes a store it was handed, and closing is what
			// checkpoints each directory's write-ahead log, releases its lock and makes the restart
			// below reopen it from disk.
			const blocks = new FileRawStorage(join(dataDir, layout.blocks));
			const kv = new FileKVStore(join(dataDir, layout.kv));
			// `<blocks>/optimystic-pieces/`, which `FileRawStorage`'s listing skips and its byte count includes.
			const pieces = new FilePieceStore(join(dataDir, layout.blocks));
			return {
				storage: { blocks, kv, pieces },
				close: async () => {
					try {
						await pieces.close();
					} finally {
						try {
							await kv.close();
						} finally {
							await blocks.close();
						}
					}
				},
			};
		}
		case 'leveldb': {
			// One storage and one key-value store over the handle, kept and closed here as the `fs`
			// case keeps its two: each holds a group's writes until a flush, and closing is what
			// applies what it still holds and disarms its timers before the handle goes away. The
			// piece store holds nothing in memory and has no `close`.
			const db = await openClassicLevel(join(dataDir, layout.path));
			const blocks = new LevelDBRawStorage(db);
			const kv = new LevelDBKVStore(db);
			const pieces = new LevelDBPieceStore(db);
			return {
				storage: { blocks, kv, pieces },
				close: async () => {
					try {
						await kv.close();
					} finally {
						try {
							await blocks.close();
						} finally {
							await db.close();
						}
					}
				},
			};
		}
	}
}

function nodeTransactor(node: OptimysticNode, networkName: string): NetworkTransactor {
	const protocolPrefix = `/optimystic/${networkName}`;
	return new NetworkTransactor({
		timeoutMs: 30_000,
		abortOrCancelTimeoutMs: 5_000,
		keyNetwork: node.keyNetwork,
		getRepo: (peerId: PeerId): IRepo => peerId.toString() === node.peerId.toString()
			? node.coordinatedRepo
			: RepoClient.create(peerId, node.keyNetwork, protocolPrefix),
		localPeerId: node.peerId,
	});
}

function openDatabase(node: OptimysticNode, transactor: NetworkTransactor, networkName: string): { db: Database; plugin: ReturnType<typeof register> } {
	const db = new Database();
	const plugin = register(db, {
		default_transactor: 'network',
		default_key_network: 'libp2p',
		default_network_name: networkName,
	} satisfies Record<string, SqlValue>);
	plugin.collectionFactory.registerLibp2pNode(networkName, node, node.coordinatedRepo);
	plugin.collectionFactory.registerTransactor('network:libp2p', transactor);
	for (const vtable of plugin.vtables) {
		db.registerModule(vtable.name, vtable.module, vtable.auxData);
	}
	for (const func of plugin.functions) {
		db.registerFunction(func.schema);
	}
	return { db, plugin };
}
