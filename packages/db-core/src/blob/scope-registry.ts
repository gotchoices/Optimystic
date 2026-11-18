import type { CollectionId } from '../collection/struct.js';
import type { TreeReplaceAction } from '../collections/tree/struct.js';
import { Tree, type TreeCollectionOptions } from '../collections/tree/tree.js';
import type { WriteDurability } from '../network/struct.js';
import type { ITransactor } from '../transactor/transactor.js';
import { pairEntryKey, readCommittedTree } from './committed-read.js';
import type { BlobScope } from './service.js';

/** The scope registry's collection id on every network. Under the `optimystic/` prefix the SQL
 * plugin already uses for its own catalog (`optimystic/schema`); an application collection or a
 * plugin table (`<uri path>`, `<uri path>/index/<name>`, `<uri path>/blobrefs`) does not take it
 * unless it is deliberately named so, and a random block id contains no `/`. */
export const BLOB_SCOPE_REGISTRY_ID: CollectionId = 'optimystic/blob-scope-registry';

/** A scope-registry entry: the scope twice. Its value is a fixed function of its key, so two
 * writers registering one scope write identical entries. */
export type BlobScopeEntry = [key: BlobScope, value: BlobScope];

export type BlobScopeListing = {
	/** Ascending. */
	scopes: BlobScope[];
	certain: boolean;
	/** False when the registry has never been written. A node holding blobs treats an absent
	 * registry as uncertain (docs/blobs.md §Lifetime); an existing, empty registry is not that. */
	exists: boolean;
};

/**
 * `[scope, [scope, scope]]` to register, `[scope, undefined]` to unregister, unguarded.
 *
 * No guard, deliberately: an unguarded upsert of the fixed entry is never refused and replays to the
 * same state, so two machines registering one scope at once both commit and the registry holds one
 * entry. `absentOrEqual` would add nothing, since the value cannot differ, and would cost a wrong
 * report: it counts in the already-applied tally where reference entries do not, so an offline entry
 * registering a scope a rival already registered beside reference entries would read
 * `already-applied` although its references landed. A delete is blind for the same reasons.
 * @throws RangeError for an empty scope.
 */
export function blobScopeAction(kind: 'register' | 'unregister', scope: BlobScope): TreeReplaceAction<string, BlobScopeEntry> {
	if (scope.length === 0) {
		throw new RangeError('A blob scope names a reference tree and cannot be empty');
	}
	return kind === 'register' ? [[scope, [scope, scope]]] : [[scope, undefined]];
}

/** The network's one list of reference trees (docs/blobs.md §Registering references). A register
 * racing an unregister of one scope ends as whichever commit is applied last; the callers, table
 * create and drop, are serialized by the catalog. Unregistering leaves the reference tree alone. */
export class BlobScopeRegistry {
	constructor(readonly tree: Tree<string, BlobScopeEntry>) {}

	/** The staging path. */
	static async createOrOpen(transactor: ITransactor, options?: TreeCollectionOptions<string, BlobScopeEntry>): Promise<BlobScopeRegistry> {
		return new BlobScopeRegistry(await Tree.createOrOpen<string, BlobScopeEntry>(transactor, BLOB_SCOPE_REGISTRY_ID, pairEntryKey, undefined, undefined, options));
	}

	/** Stage into the caller's transaction; never syncs. */
	async stageRegister(scope: BlobScope): Promise<void> {
		await this.tree.stage(blobScopeAction('register', scope));
	}

	async stageUnregister(scope: BlobScope): Promise<void> {
		await this.tree.stage(blobScopeAction('unregister', scope));
	}

	/** Open, stage and sync in one step (`Tree.replace`, which unstages on failure). */
	static async register(transactor: ITransactor, scope: BlobScope): Promise<WriteDurability | undefined> {
		return await BlobScopeRegistry.replace(transactor, blobScopeAction('register', scope));
	}

	static async unregister(transactor: ITransactor, scope: BlobScope): Promise<WriteDurability | undefined> {
		return await BlobScopeRegistry.replace(transactor, blobScopeAction('unregister', scope));
	}

	/** Every registered scope in committed state, read as `readCommittedTree` in
	 * `packages/db-core/src/blob/committed-read.ts` reads. */
	static async enumerate(transactor: ITransactor): Promise<BlobScopeListing> {
		const scopes: BlobScope[] = [];
		const { exists, certain } = await readCommittedTree<BlobScopeEntry>(transactor, BLOB_SCOPE_REGISTRY_ID, async tree => {
			const path = await tree.first();
			while (path.on) {
				scopes.push(tree.at(path)![0]);
				await tree.moveNext(path);
			}
		});
		return { scopes, certain, exists };
	}

	private static async replace(transactor: ITransactor, action: TreeReplaceAction<string, BlobScopeEntry>): Promise<WriteDurability | undefined> {
		const registry = await BlobScopeRegistry.createOrOpen(transactor);
		return await registry.tree.replace(action);
	}
}
