import type { Path } from '../btree/path.js';
import type { CollectionId } from '../collection/struct.js';
import type { TreeReplaceAction } from '../collections/tree/struct.js';
import { Tree, type TreeCollectionOptions } from '../collections/tree/tree.js';
import type { ITransactor } from '../transactor/transactor.js';
import type { BlobRef } from './blob-ref.js';
import { pairEntryKey, readCommittedTree } from './committed-read.js';
import { blobReferenceBounds, blobReferenceKey } from './reference-key.js';

/** A reference-tree entry. The second element is the reference, which the key already contains:
 * the entry carries nothing the key does not say, and exists so the key exists. */
export type BlobReferenceEntry = [key: string, ref: BlobRef];

export type BlobReferenceChange = {
	readonly kind: 'add' | 'remove';
	readonly ref: BlobRef;
	/** Opaque name of what holds the reference (for a SQL table: framed primary key and column,
	 * chosen by the SQL plugin). */
	readonly referrer: string;
};

/** What a reader found. Every reference in `listed` is listed. `certain` is whether an unlisted
 * reference is known to be unlisted (`readCommittedTree` in
 * `packages/db-core/src/blob/committed-read.ts`). */
export type BlobListing = { listed: Set<BlobRef>; certain: boolean };

/**
 * The tree action for `changes`, in the order given: an add is the upsert `[key, [key, ref]]`, a
 * remove the delete `[key, undefined]`, neither guarded. Every change is validated before any element
 * is built, so a non-reference stages nothing.
 *
 * A pure function of its input — no clock, no randomness, no read — so a validating member
 * re-executing the same statements produces the same operations. Unguarded is replay-safe: an add is
 * an upsert of a key fixed by (reference, referrer) with a value fixed by the key, and a remove a
 * blind delete of a fixed key, so re-running either over any committed state leaves the state the
 * change describes. The row the referrer names carries the guard that refuses a racing change to it
 * (docs/blobs.md §Registering references).
 */
export function blobReferenceAction(changes: readonly BlobReferenceChange[]): TreeReplaceAction<string, BlobReferenceEntry> {
	const keyed = changes.map(change => ({ kind: change.kind, ref: change.ref, key: blobReferenceKey(change.ref, change.referrer) }));
	return keyed.map(({ kind, ref, key }): ReferenceElement => kind === 'add' ? [key, [key, ref]] : [key, undefined]);
}

type ReferenceElement = TreeReplaceAction<string, BlobReferenceEntry>[number];

/** One collection's reference tree: which blobs its rows reference, written in the same transaction
 * as the rows (docs/blobs.md §Registering references). */
export class BlobReferenceTree {
	/** Wraps a tree a caller already opened — e.g. the SQL plugin's, through its collection factory —
	 * whose key is `entry[0]` and comparator the default. */
	constructor(readonly tree: Tree<string, BlobReferenceEntry>) {}

	/** The staging path: a first write is when a reference tree comes into existence. */
	static async createOrOpen(
		transactor: ITransactor,
		id: CollectionId,
		options?: TreeCollectionOptions<string, BlobReferenceEntry>,
	): Promise<BlobReferenceTree> {
		return new BlobReferenceTree(await Tree.createOrOpen<string, BlobReferenceEntry>(transactor, id, pairEntryKey, undefined, undefined, options));
	}

	/** Stage `changes` as one action into the tree; never syncs. The entries commit or roll back with
	 * whatever the caller commits `tree` with. An empty list stages nothing. */
	async stage(changes: readonly BlobReferenceChange[]): Promise<void> {
		if (changes.length === 0) {
			return;
		}
		await this.tree.stage(blobReferenceAction(changes));
	}

	async stageAdd(ref: BlobRef, referrer: string): Promise<void> {
		await this.stage([{ kind: 'add', ref, referrer }]);
	}

	async stageRemove(ref: BlobRef, referrer: string): Promise<void> {
		await this.stage([{ kind: 'remove', ref, referrer }]);
	}

	/** Which of `refs` the reference tree `id` lists in committed state. `refs` may come in any order
	 * and repeat. A tree never written lists nothing, certainly. */
	static async listed(transactor: ITransactor, id: CollectionId, refs: Iterable<BlobRef>): Promise<BlobListing> {
		const listed = new Set<BlobRef>();
		// Default sort compares UTF-16 code units, the order the tree's keys are in.
		const ascending = [...new Set(refs)].sort();
		if (ascending.length === 0) {
			return { listed, certain: true };
		}
		const { certain } = await readCommittedTree<BlobReferenceEntry>(transactor, id, tree => collectListed(tree, ascending, listed));
		return { listed, certain };
	}
}

/**
 * One ascending pass, merge-joined with `ascending`, holding one cursor. A reference whose range
 * holds no entry leaves the cursor on the next entry, which answers every following reference that
 * sorts below it with no further descent. Rejected: one range scan from the first reference to the
 * last, which reads every entry between them — for a large table and a few held blobs, the whole
 * tree.
 */
async function collectListed(tree: Tree<string, BlobReferenceEntry>, ascending: readonly BlobRef[], listed: Set<BlobRef>): Promise<void> {
	let cursor: Path<string, BlobReferenceEntry> | undefined;
	for (const ref of ascending) {
		const { lower, upper } = blobReferenceBounds(ref);
		if (cursor === undefined || tree.at(cursor)![0] < lower) {
			cursor = await firstAtOrAbove(tree, lower);
		}
		if (!cursor.on) {
			return;	// nothing at or after `lower`: this and every later reference is unlisted
		}
		if (tree.at(cursor)![0] < upper) {
			listed.add(ref);
		}
	}
}

/** The first entry whose key is `key` or above, or a path that is not on when there is none — what
 * `BTree.findFirst` does for an ascending range. */
async function firstAtOrAbove(tree: Tree<string, BlobReferenceEntry>, key: string): Promise<Path<string, BlobReferenceEntry>> {
	const path = await tree.find(key);
	if (!path.on) {
		await tree.moveNext(path);
	}
	return path;
}
