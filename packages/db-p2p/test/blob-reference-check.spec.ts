/**
 * `BlobReferenceCheck` (docs/blobs.md §Who may fetch and who may store): the registry is read before
 * any reference tree, a scope it does not list is never read, and a reference-tree read that cannot be
 * trusted is uncertain rather than an absence.
 */
import { expect } from 'chai';
import {
	BlobReferenceTree,
	BlobScopeRegistry,
	BlockPossiblyStaleError,
	buildBlob,
	type BlobRef,
	type BlobScope,
	type BlockGets,
	type GetBlockResults,
} from '@optimystic/db-core';
import { TestTransactor } from '@optimystic/db-core/test';
import { BlobReferenceCheck } from '../src/blob/reference-check.js';

const REGISTERED: BlobScope = 'app/photos/blobrefs';
const UNREGISTERED: BlobScope = 'app/drafts/blobrefs';

/** Records every block id a read names, and while `staleHeader` is set refuses a read of that header
 * as possibly stale. A tree's header block id is its collection id, and every open reads it first. */
class WatchedTransactor extends TestTransactor {
	readonly requested: string[] = [];
	staleHeader?: string;

	override async get(gets: BlockGets): Promise<GetBlockResults> {
		this.requested.push(...gets.blockIds);
		if (this.staleHeader !== undefined && gets.blockIds.includes(this.staleHeader)) {
			throw new BlockPossiblyStaleError(this.staleHeader, 99);
		}
		return await super.get(gets);
	}
}

async function referenceTo(text: string): Promise<BlobRef> {
	const bytes = new TextEncoder().encode(text);
	return (await buildBlob((async function* () { yield bytes; })(), { put: async () => undefined })).ref;
}

async function listIn(net: TestTransactor, scope: BlobScope, ref: BlobRef): Promise<void> {
	const references = await BlobReferenceTree.createOrOpen(net, scope);
	await references.stageAdd(ref, 'row-1');
	await references.tree.sync();
}

describe('blob reference check', () => {
	it('finds a reference listed by a registered scope, asked by scope and anywhere', async () => {
		const net = new WatchedTransactor();
		const ref = await referenceTo('a photo');
		await BlobScopeRegistry.register(net, REGISTERED);
		await listIn(net, REGISTERED, ref);
		const check = new BlobReferenceCheck({ transactor: net });

		expect(await check.inScope(ref, REGISTERED)).to.deep.equal({ kind: 'listed', scope: REGISTERED });
		expect(await check.anywhere(ref)).to.deep.equal({ kind: 'listed', scope: REGISTERED });
	});

	it('answers not-listed for a scope the registry lacks, without reading its tree', async () => {
		const net = new WatchedTransactor();
		const ref = await referenceTo('a draft');
		await BlobScopeRegistry.register(net, REGISTERED);
		// The unregistered tree does list the reference, so reading it would have answered `listed`.
		await listIn(net, UNREGISTERED, ref);
		const check = new BlobReferenceCheck({ transactor: net });
		net.requested.length = 0;

		expect(await check.inScope(ref, UNREGISTERED)).to.deep.equal({ kind: 'not-listed' });
		expect(net.requested, 'reads of the unregistered tree').to.not.include(UNREGISTERED);
	});

	it('answers uncertain when the reference tree is possibly stale', async () => {
		const net = new WatchedTransactor();
		const ref = await referenceTo('another photo');
		await BlobScopeRegistry.register(net, REGISTERED);
		await listIn(net, REGISTERED, ref);
		const check = new BlobReferenceCheck({ transactor: net });
		net.staleHeader = REGISTERED;

		expect((await check.inScope(ref, REGISTERED)).kind).to.equal('uncertain');
	});
});
