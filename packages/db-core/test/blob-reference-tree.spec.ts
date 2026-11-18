/**
 * Reference trees and the scope registry (docs/blobs.md §Registering references): the key framing,
 * staging and reading back, a racing first registration, and the two ways a committed read is
 * answered with content it cannot trust — a possibly-stale block and a below-floor answer.
 */
import { expect } from 'chai';
import {
	BlobReferenceTree,
	BlobScopeRegistry,
	blobReferenceBounds,
	buildBlob,
	Tree,
	type BlobRef,
	type BlockGets,
	type GetBlockResults,
	type IBlock,
	type PieceSink,
} from '../src/index.js';
import { TreeBranchBlockType, TreeLeafBlockType } from '../src/btree/nodes.js';
import { TestTransactor } from '../src/testing/test-transactor.js';

const REFERENCES = 'app/things/blobrefs';
const SCOPE = 'app/things/blobrefs';

const discard: PieceSink = { put: async () => {} };

/** A real reference: the root of a one-leaf blob of `text`. */
async function referenceTo(text: string): Promise<BlobRef> {
	const bytes = new TextEncoder().encode(text);
	return (await buildBlob((async function* () { yield bytes; })(), discard)).ref;
}

function isTreeNode(block: IBlock | undefined): boolean {
	return block?.header.type === TreeLeafBlockType || block?.header.type === TreeBranchBlockType;
}

/** While `doubt` is set, every tree node it serves carries a claim of a newer revision that nothing
 *  confirmed — set at the pin, or one past the latest for an unpinned read, which is exactly where
 *  `answeredBlock` throws `BlockPossiblyStaleError`. */
class DoubtingTransactor extends TestTransactor {
	doubt = false;

	override async get(gets: BlockGets): Promise<GetBlockResults> {
		const results = await super.get(gets);
		if (!this.doubt) return results;
		for (const [id, entry] of Object.entries(results)) {
			if (isTreeNode(entry.block)) {
				results[id] = { ...entry, unconfirmedAheadRev: gets.context?.rev ?? (entry.state.latest?.rev ?? 0) + 1 };
			}
		}
		return results;
	}
}

/** While `lagAt` is set, a tree node read pinned above it is answered as of `lagAt`, with that as
 *  the replica's latest — a machine that stopped there. The header and log tail, read unpinned, are
 *  current, so a fresh open learns of the newer commit and floors the blocks it names. (The shape of
 *  `LaggingDataTransactor` in `refresh-below-floor.spec.ts`.) */
class LaggingTreeTransactor extends TestTransactor {
	lagAt?: number;

	override async get(gets: BlockGets): Promise<GetBlockResults> {
		const lagAt = this.lagAt;
		const results = await super.get(gets);
		const askedRev = gets.context?.rev;
		if (lagAt === undefined || askedRev === undefined || askedRev <= lagAt) return results;
		for (const [id, entry] of Object.entries(results)) {
			if (!isTreeNode(entry.block)) continue;
			const lagged = (await super.get({ blockIds: [id], context: { ...gets.context!, committed: [], rev: lagAt } }))[id]!;
			results[id] = { ...lagged, state: { ...lagged.state, latest: lagged.materialized } };
		}
		return results;
	}
}

describe('blob reference trees', () => {
	it('frames keys so a longer reference never falls in a shorter one\'s range', () => {
		// Valid references all share one length, so the prefix case needs cast strings.
		const shorter = blobReferenceBounds('bafkab' as BlobRef);
		const longer = blobReferenceBounds('bafkabc' as BlobRef);
		const referrers = ['', 'a', '\u0000'];
		for (const referrer of referrers) {
			const longerKey = longer.lower + referrer;
			expect(longerKey >= shorter.lower && longerKey < shorter.upper, `longer key ${JSON.stringify(referrer)}`).to.equal(false);
			const shorterKey = shorter.lower + referrer;
			expect(shorterKey >= shorter.lower && shorterKey < shorter.upper, `shorter key ${JSON.stringify(referrer)}`).to.equal(true);
			for (const other of referrers) {
				expect(shorterKey < longer.lower + other, `${JSON.stringify(referrer)} below ${JSON.stringify(other)}`).to.equal(true);
			}
		}
	});

	it('stages, commits and reads back which references are listed', async () => {
		const net = new TestTransactor();
		const [r1, r2, r3, r4] = await Promise.all(['one', 'two', 'three', 'four'].map(referenceTo));

		expect(await BlobReferenceTree.listed(net, REFERENCES, [r1!])).to.deep.equal({ listed: new Set(), certain: true });
		expect(await Tree.open(net, REFERENCES), 'reading invents nothing').to.equal(undefined);

		const references = await BlobReferenceTree.createOrOpen(net, REFERENCES);
		await references.stage([
			{ kind: 'add', ref: r1!, referrer: 'a' },
			{ kind: 'add', ref: r1!, referrer: 'b' },
			{ kind: 'add', ref: r2!, referrer: 'a' },
			{ kind: 'add', ref: r3!, referrer: 'a' },
			{ kind: 'remove', ref: r3!, referrer: 'a' },
			{ kind: 'remove', ref: r4!, referrer: 'a' },
		]);
		await references.tree.sync();
		expect(await BlobReferenceTree.listed(net, REFERENCES, [r4!, r2!, r1!, r3!, r1!]))
			.to.deep.equal({ listed: new Set([r1, r2]), certain: true });

		await references.stageRemove(r1!, 'a');
		await references.tree.sync();
		expect((await BlobReferenceTree.listed(net, REFERENCES, [r1!])).listed, 'still listed through b').to.deep.equal(new Set([r1]));

		await references.stageRemove(r1!, 'b');
		await references.tree.sync();
		expect(await BlobReferenceTree.listed(net, REFERENCES, [r1!])).to.deep.equal({ listed: new Set(), certain: true });
	});

	it('commits both of two racing first registrations of one scope as one entry', async () => {
		const net = new TestTransactor();
		expect(await BlobScopeRegistry.enumerate(net)).to.deep.equal({ scopes: [], certain: true, exists: false });

		const a = await BlobScopeRegistry.createOrOpen(net);
		const b = await BlobScopeRegistry.createOrOpen(net);
		await a.stageRegister(SCOPE);
		await b.stageRegister(SCOPE);
		await Promise.all([a.tree.sync(), b.tree.sync()]);
		expect(await BlobScopeRegistry.enumerate(net)).to.deep.equal({ scopes: [SCOPE], certain: true, exists: true });

		await BlobScopeRegistry.unregister(net, SCOPE);
		await BlobScopeRegistry.unregister(net, SCOPE);
		expect(await BlobScopeRegistry.enumerate(net)).to.deep.equal({ scopes: [], certain: true, exists: true });
	});

	it('answers uncertain, without throwing, when a tree node may be stale', async () => {
		const net = new DoubtingTransactor();
		const r1 = await referenceTo('one');
		const references = await BlobReferenceTree.createOrOpen(net, REFERENCES);
		await references.stageAdd(r1, 'a');
		await references.tree.sync();

		net.doubt = true;
		expect((await BlobReferenceTree.listed(net, REFERENCES, [r1])).certain).to.equal(false);
	});

	it('answers uncertain when a tree node is answered older than the log says it is', async () => {
		const net = new LaggingTreeTransactor();
		const [r1, r2] = await Promise.all([referenceTo('one'), referenceTo('two')]);
		const references = await BlobReferenceTree.createOrOpen(net, REFERENCES);
		await references.stageAdd(r1!, 'a');
		await references.tree.sync();
		const lagAt = references.tree.committedRevision()!;
		await references.stageAdd(r2!, 'a');
		await references.tree.sync();

		net.lagAt = lagAt;
		const listing = await BlobReferenceTree.listed(net, REFERENCES, [r1!, r2!]);
		expect(listing.listed.has(r2!), 'the stale leaf does not show r2').to.equal(false);
		expect(listing.certain).to.equal(false);
	});
});
