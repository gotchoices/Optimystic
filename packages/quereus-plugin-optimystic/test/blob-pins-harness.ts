/**
 * The harness the blob-pin specs share: one set of stores, and as many plugin handles over them as a
 * test wants to open.
 *
 * What it exists for is the RESTART. Every store a plugin instance would otherwise create for itself
 * — the block storage behind its `local` transactor, the pieces and blob records behind its blob
 * service, and the offline journal — is created once here and handed to every handle, so closing one
 * handle and opening another over the same {@link BlobPinStores} is a restarted process: the second
 * handle finds the first's rows, its blob pins and its journaled queue entries, and remembers nothing
 * in memory. That is how a spec reaches the paths that read a pin's own label rather than what the
 * process that wrote it was holding.
 *
 * Every handle's transactor is `local`, which has no libp2p node, so the blob backend is a
 * `SingleMachineBlobService`: an announcement there yields an `owed` hold and durability `local`
 * rather than telling a cohort, which is the observable the specs assert against. Real blobs
 * throughout ({@link putBlob}), never fabricated references, so `stat` and the `owed` hold mean
 * something.
 *
 * The queue is held by a reachability gate ({@link Gate}) rather than by parking the transactor: an
 * entry the drain never sent stays queued, is still discardable (an entry that may have landed is
 * not withdrawn on this machine's say-so), and survives a restart as a journaled record — which is
 * what the queued-pin cases need.
 */

import { expect } from 'chai';
import { Database } from '@quereus/quereus';
import type { SqlValue } from '@quereus/quereus';
import { BlobReferenceTree, decodeBlobReferenceKey } from '@optimystic/db-core';
import type { BlobRef, CollectionId, ICohortReachability, ITransactor } from '@optimystic/db-core';
import { MemoryKVStore, MemoryPieceStore, MemoryRawStorage, type IKVStore, type IPieceStore } from '@optimystic/db-p2p';
import register from '../dist/plugin.js';
import { parsePinLabel } from '../dist/index.js';

export type Plugin = ReturnType<typeof register>;

/**
 * The journal of a handle's offline queue: a plain map, which is everything the journal asks of a
 * store, handed to every handle over one {@link BlobPinStores} so a restart reads what the last
 * process wrote. NOT a `MemoryKVStore`, which the registration config refuses by name — a journal
 * lost with the process is the no-journal configuration — and this one is deliberately not lost.
 */
class SharedJournal implements IKVStore {
	private readonly records = new Map<string, string>();

	async get(key: string): Promise<string | undefined> {
		return this.records.get(key);
	}

	async set(key: string, value: string): Promise<void> {
		this.records.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.records.delete(key);
	}

	async list(prefix: string): Promise<string[]> {
		return [...this.records.keys()].filter(key => key.startsWith(prefix));
	}
}

/**
 * A reachability gate as a test sets it (`offline-restore.spec.ts`'s own `Gate`): closed keeps every
 * submission unsent, and {@link open} is the connection event, called by hand.
 */
export class Gate implements ICohortReachability {
	private readonly listeners = new Set<() => void>();

	constructor(private reachable_ = true) {}

	readonly reachable = (): Promise<boolean> => Promise.resolve(this.reachable_);

	readonly onChange = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	};

	/** The cohort can be reached from now on, and the drain is woken. */
	open(): void {
		this.reachable_ = true;
		for (const listener of [...this.listeners]) listener();
	}

	close(): void {
		this.reachable_ = false;
	}
}

/** Everything a restarted process finds again: one block store, one blob store, one journal. */
export interface BlobPinStores {
	readonly storage: MemoryRawStorage;
	readonly blobs: { pieces: IPieceStore; kv: IKVStore };
	readonly journal: IKVStore;
}

export function createStores(): BlobPinStores {
	return {
		storage: new MemoryRawStorage(),
		blobs: { pieces: new MemoryPieceStore(), kv: new MemoryKVStore() },
		journal: new SharedJournal(),
	};
}

/** One life of a `Database` over the shared stores. */
export interface PluginHandle {
	readonly db: Database;
	readonly plugin: Plugin;
	/** The gate every submission of this handle's queue asks. */
	readonly gate: Gate;
}

export interface OpenOptions {
	/** Whether this handle's cohort can be reached when it opens; `false` keeps every queued entry
	 * unsent until {@link Gate.open}. Default `true`. */
	readonly reachable?: boolean;
}

/**
 * A `local` session over the shared stores, as `blob-reference-tree.spec.ts`'s harness builds one,
 * with the plugin's `types` registered as `registerPlugin` does — which is what makes a `blobref`
 * column resolve — plus the shared blob store and the shared journal.
 *
 * The drain's re-check timer is shortened, as every offline spec shortens it, so a woken gate is
 * noticed within a test's patience.
 */
export function openPlugin(stores: BlobPinStores, options: OpenOptions = {}): PluginHandle {
	const db = new Database();
	const plugin = register(db, {
		default_transactor: 'local',
		default_key_network: 'test',
		enable_cache: false,
		rawStorageFactory: () => stores.storage,
		blobStorageFactory: () => stores.blobs,
		offline: { journal: stores.journal, recheck: { baseMs: 20, maxMs: 100 } },
	} as unknown as Record<string, SqlValue>);
	// Before any table opens, so the gate a submission asks is this one rather than the always-open
	// stand-in the factory hands out until a gate is registered.
	const gate = new Gate(options.reachable ?? true);
	plugin.collectionFactory.registerCohortReachability('local:test', gate);
	for (const vtable of plugin.vtables) db.registerModule(vtable.name, vtable.module, vtable.auxData);
	for (const func of plugin.functions) db.registerFunction(func.schema);
	for (const type of plugin.types) db.registerType(type.name, type.definition);
	return { db, plugin, gate };
}

/** Close a handle as a host does: the `Database` first, then the plugin's own holdings. */
export async function closePlugin(handle: PluginHandle): Promise<void> {
	handle.db.close();
	await handle.plugin.dispose();
}

/**
 * The restart: `handle` is closed and a new handle opened over the same stores, its catalog and its
 * journaled queue entries put back (`plugin.hydrate`). The returned handle's plugin remembers
 * nothing of the old one — only what the stores hold.
 */
export async function restart(handle: PluginHandle, stores: BlobPinStores, options: OpenOptions = {}): Promise<PluginHandle> {
	await closePlugin(handle);
	const restarted = openPlugin(stores, options);
	await restarted.plugin.hydrate(restarted.db);
	return restarted;
}

/** A blob of a few distinct bytes, put on `handle`'s network: `seed` makes each case's blobs differ. */
export async function putBlob(handle: PluginHandle, seed: number): Promise<BlobRef> {
	const bytes = async function* (): AsyncIterable<Uint8Array> {
		yield Uint8Array.from({ length: 16 }, (_, i) => (seed * 31 + i) % 251);
	};
	const { ref } = await handle.plugin.blobs.put(bytes());
	return ref;
}

/**
 * The pins this machine holds on `ref`, rendered as the kinds the plugin writes and sorted
 * (`blob-pins-online.spec.ts`'s own): `unstaged` for a put outside a transaction, `put` for one
 * inside it, and `ref/<scope>` for a transaction's reference. A label this plugin did not write
 * renders verbatim, so a stray owner fails the comparison rather than being counted as one of ours.
 */
export async function pinsOn(plugin: Plugin, ref: BlobRef): Promise<string[]> {
	const labels = await plugin.blobs.pinsOf(ref);
	return labels.map(label => {
		const parsed = parsePinLabel(label);
		if (parsed === undefined) return `other(${label})`;
		return parsed.kind === 'reference' ? `ref/${parsed.scope}` : parsed.kind;
	}).sort();
}

/** Every pin on this machine whose owner starts with `prefix`, as `<ref> <owner>`. */
export async function allPins(plugin: Plugin, prefix: string): Promise<string[]> {
	const found: string[] = [];
	for await (const { ref, owner } of plugin.blobs.listPins(prefix)) found.push(`${ref} ${owner}`);
	return found.sort();
}

/** Options that resolve to the handle's one cached `local:test` transactor. */
function bindingOptions(stores: BlobPinStores) {
	return {
		collectionUri: 'tree://unused',
		transactor: 'local',
		keyNetwork: 'test',
		libp2pOptions: {},
		cache: false,
		encoding: 'json' as const,
		rawStorageFactory: () => stores.storage,
	};
}

export async function transactorOf(handle: PluginHandle, stores: BlobPinStores): Promise<ITransactor> {
	return await handle.plugin.collectionFactory.getOrCreateTransactor(bindingOptions(stores));
}

/** The reference tree's collection id — a table's blob scope — for a table declared at `uri`. */
export function scopeOf(uri: string): CollectionId {
	return `${uri.replace(/^tree:\/\//, '')}/blobrefs` as CollectionId;
}

/**
 * The references the committed reference tree at `scope` lists, each once and sorted. Read as the
 * plugin opens it, so a tree that was never written reads as empty and opening it here brings
 * nothing into existence.
 */
export async function referencesInTree(transactor: ITransactor, scope: CollectionId): Promise<string[]> {
	const references = await BlobReferenceTree.createOrOpen(transactor, scope);
	const tree = references.tree;
	await tree.update();
	const found = new Set<string>();
	const path = await tree.first();
	while (path.on) {
		found.add(decodeBlobReferenceKey(tree.at(path)![0]).ref);
		await tree.moveNext(path);
	}
	return [...found].sort();
}

/** The one queued entry, failing loudly when the queue does not hold exactly one. */
export function soleQueuedEntry(plugin: Plugin): string {
	const entries = plugin.offline.entries();
	expect(entries.map(entry => entry.transactionId), 'exactly one transaction is queued').to.have.lengthOf(1);
	return entries[0]!.transactionId;
}
