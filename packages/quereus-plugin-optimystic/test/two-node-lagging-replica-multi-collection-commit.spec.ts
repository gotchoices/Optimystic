/**
 * Ticket: a-multi-collection-commit-half-lands-when-the-writers-replica-lags.
 *
 * A node that has just joined writes one SQL transaction touching three collections — a
 * Member row, that table's UNIQUE index tree, and a ConsumedInvite row — while its OWN
 * replica has not yet received the founder's blocks for Member. Nobody else is writing.
 *
 * On the mesh, every pend is accepted (a member holding no revision of a block records an
 * update-shaped pend; see the NOTE in `StorageRepo.pend`). At commit the joiner's member
 * refuses Member's tail with `missing-base-revision`, the durability gate counts one holder
 * of two and answers the retryable `commit-not-durable`, and the transactor drops the
 * reason on the way up. `TransactionCoordinator.commitCollection` then reports that
 * collection as a permanent stale loss while the sibling collections — fanned out in
 * parallel — commit. The caller gets `CoordinatorPartialCommitError`: the invite is spent,
 * the member is never seated, and nothing retries. Before the pended batch
 * (`legacy-multi-tree-commit-pends-everything-before-committing-anything`) each tree's own
 * `Collection.sync` refreshed and retried the same refusal until the joiner had caught up.
 *
 * The lag is modelled at the joiner's raw storage: after both nodes hold the founder's
 * seed, a veil over Member's block ids makes every read of them answer "absent" and drops
 * every materializing write to them — the replica has not received those blocks, and a
 * read-repair or reconcile cannot land them yet either. The veil lifts on the joiner's
 * first refused commit, standing in for peer-join catch-up landing a moment later, so a
 * commit phase that recovers forward (refresh, finish its own entry, re-send) can land the
 * write; one that gives up at the first refusal cannot.
 *
 * The assertion is all-or-nothing, on BOTH nodes, read through fresh trees: either every
 * collection holds the joiner's write (and the founder is refused when it reuses the
 * joiner's StampId — the UNIQUE index landed too), or none of them does.
 */

import { expect } from 'chai';
import type { SqlValue } from '@quereus/quereus';
import type {
	ActionId, ActionRev, BlockId, IBlock, IRepo, ITransactor, Transform, CommitRequest, CommitResult, MessageOptions
} from '@optimystic/db-core';
import { CoordinatorPartialCommitError } from '@optimystic/db-core';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import type { BlockCommitProof, BlockMetadata } from '@optimystic/db-p2p';
import { createMesh, buildNetworkTransactors, type MeshOptions } from '@optimystic/db-p2p/testing';
import { createMeshDbNode, type MeshDbNode } from './mesh-node-harness.js';

type RawStorage = ReturnType<NonNullable<MeshOptions['rawStorageFactory']>>;
type Row = Record<string, SqlValue>;

const MEMBER_URI = 'tree://lag/Member';
const INVITE_URI = 'tree://lag/ConsumedInvite';
/** The collection id the plugin derives from a `tree://` URI: the path after the scheme. */
const MEMBER_COLLECTION_ID = MEMBER_URI.slice('tree://'.length);

/**
 * A raw storage whose replica of one collection can be made to LAG: while a collection is
 * veiled, every read of its (already stored) block ids answers absent and every materializing
 * write to them is dropped, so neither a read-repair nor a commit-time reconcile can land the
 * block. Pending records pass through untouched — the member accepts the pend exactly as a
 * behind replica does. `lift()` makes the store transparent again: the blocks it held before
 * the veil are what catch-up would have delivered.
 */
class LaggingRawStorage implements RawStorage {
	private readonly inner = new MemoryRawStorage();
	/** Which collection each stored block belongs to, learned from its header as it is stored. */
	private readonly owner = new Map<BlockId, string>();
	private hidden = new Set<BlockId>();
	droppedWrites = 0;

	veil(collectionId: string): number {
		for (const [blockId, owner] of this.owner) {
			if (owner === collectionId) this.hidden.add(blockId);
		}
		return this.hidden.size;
	}

	lift(): void {
		this.hidden = new Set();
	}

	private drop(blockId: BlockId): boolean {
		if (!this.hidden.has(blockId)) return false;
		this.droppedWrites++;
		return true;
	}

	async getMetadata(blockId: BlockId): Promise<BlockMetadata | undefined> {
		return this.hidden.has(blockId) ? undefined : this.inner.getMetadata(blockId);
	}
	async saveMetadata(blockId: BlockId, metadata: BlockMetadata): Promise<void> {
		if (!this.drop(blockId)) await this.inner.saveMetadata(blockId, metadata);
	}
	async getRevision(blockId: BlockId, rev: number): Promise<ActionId | undefined> {
		return this.hidden.has(blockId) ? undefined : this.inner.getRevision(blockId, rev);
	}
	async saveRevision(blockId: BlockId, rev: number, actionId: ActionId): Promise<void> {
		if (!this.drop(blockId)) await this.inner.saveRevision(blockId, rev, actionId);
	}
	async *listRevisions(blockId: BlockId, startRev: number, endRev: number): AsyncIterable<ActionRev> {
		if (this.hidden.has(blockId)) return;
		yield* this.inner.listRevisions(blockId, startRev, endRev);
	}
	getPendingTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		return this.inner.getPendingTransaction(blockId, actionId);
	}
	savePendingTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		return this.inner.savePendingTransaction(blockId, actionId, transform);
	}
	deletePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		return this.inner.deletePendingTransaction(blockId, actionId);
	}
	listPendingTransactions(blockId: BlockId): AsyncIterable<ActionId> {
		return this.inner.listPendingTransactions(blockId);
	}
	async getTransaction(blockId: BlockId, actionId: ActionId): Promise<Transform | undefined> {
		return this.hidden.has(blockId) ? undefined : this.inner.getTransaction(blockId, actionId);
	}
	async saveTransaction(blockId: BlockId, actionId: ActionId, transform: Transform): Promise<void> {
		if (!this.drop(blockId)) await this.inner.saveTransaction(blockId, actionId, transform);
	}
	async getBlockProof(blockId: BlockId, rev: number): Promise<BlockCommitProof | undefined> {
		return this.hidden.has(blockId) ? undefined : this.inner.getBlockProof(blockId, rev);
	}
	async saveBlockProof(blockId: BlockId, rev: number, proof: BlockCommitProof): Promise<void> {
		if (!this.drop(blockId)) await this.inner.saveBlockProof(blockId, rev, proof);
	}
	async getMaterializedBlock(blockId: BlockId, actionId: ActionId): Promise<IBlock | undefined> {
		return this.hidden.has(blockId) ? undefined : this.inner.getMaterializedBlock(blockId, actionId);
	}
	async saveMaterializedBlock(blockId: BlockId, actionId: ActionId, block?: IBlock): Promise<void> {
		if (block !== undefined) this.owner.set(blockId, block.header.collectionId);
		if (!this.drop(blockId)) await this.inner.saveMaterializedBlock(blockId, actionId, block);
	}
	async promotePendingTransaction(blockId: BlockId, actionId: ActionId): Promise<void> {
		if (!this.drop(blockId)) await this.inner.promotePendingTransaction(blockId, actionId);
	}
}

/** Lifts `onFirstRefusal` the first time any commit RPC answers `success: false`. */
function liftOnFirstRefusedCommit(repo: IRepo, onFirstRefusal: () => void): IRepo {
	let lifted = false;
	return new Proxy(repo, {
		get(target, prop, receiver) {
			if (prop !== 'commit') return Reflect.get(target, prop, receiver);
			return async (request: CommitRequest, options?: MessageOptions): Promise<CommitResult> => {
				const result = await target.commit(request, options);
				if (!result.success && !lifted) {
					lifted = true;
					onFirstRefusal();
				}
				return result;
			};
		},
	});
}

async function ids(node: MeshDbNode, table: string): Promise<string[]> {
	const out: string[] = [];
	for await (const row of node.db.eval(`select Id from ${table} order by Id`)) {
		out.push(String((row as Row).Id));
	}
	return out;
}

async function declareTables(node: MeshDbNode): Promise<void> {
	await node.db.exec(`create table Member (Id text primary key, StampId text not null unique, Name text) using optimystic('${MEMBER_URI}')`);
	await node.db.exec(`create table ConsumedInvite (Id text primary key, MemberId text not null) using optimystic('${INVITE_URI}')`);
}

const joinSql = (who: string): string => `begin;
	insert into Member (Id, StampId, Name) values ('${who}', 'stamp-${who}', '${who}');
	insert into ConsumedInvite (Id, MemberId) values ('inv-${who}', '${who}');
	commit;`;

describe('Two-node multi-collection commit when the writer\'s own replica lags', function () {
	this.timeout(120_000);

	it('lands every collection or none of them (Member + UNIQUE index + ConsumedInvite)', async () => {
		const stores: LaggingRawStorage[] = [];
		const mesh = await createMesh(2, {
			responsibilityK: 2,
			clusterSize: 2,
			superMajorityThreshold: 0.67,
			rawStorageFactory: (index) => {
				stores[index] = new LaggingRawStorage();
				return stores[index];
			},
		});
		const joinerStore = stores[1]!;
		const transactors = buildNetworkTransactors(mesh, {
			wrapRepo: (repo) => liftOnFirstRefusedCommit(repo, () => joinerStore.lift()),
		});
		const transactorFor = (index: number): ITransactor => transactors.get(mesh.nodes[index]!.peerId.toString())!;
		const founder = createMeshDbNode(transactorFor(0));
		const joiner = createMeshDbNode(transactorFor(1));

		await declareTables(founder);
		await declareTables(joiner);
		// The founder's bootstrap: every collection the join touches has a committed revision on
		// both nodes before the joiner writes.
		await founder.db.exec(joinSql('founder'));
		// The joiner has read the strand once (what a join does before it writes).
		expect(await ids(joiner, 'Member')).to.deep.equal(['founder']);

		const veiled = joinerStore.veil(MEMBER_COLLECTION_ID);
		expect(veiled, 'the joiner had stored Member blocks to lose').to.be.greaterThan(0);

		let outcome: { landed: true } | { landed: false; error: unknown };
		try {
			await joiner.db.exec(joinSql('joiner'));
			outcome = { landed: true };
		} catch (error) {
			outcome = { landed: false, error };
		}
		const describeOutcome = outcome.landed
			? 'the join was reported saved'
			: `the join was refused: ${outcome.error instanceof Error ? `${outcome.error.constructor.name}: ${outcome.error.message}` : String(outcome.error)}`;

		// Fresh Databases: a refused join leaves the joiner's own Database degraded (its committed
		// reads refuse), and neither node's vtab cache should stand in for what consensus stored.
		const views = [createMeshDbNode(transactorFor(0)), createMeshDbNode(transactorFor(1))];
		for (const view of views) await declareTables(view);
		const expectedMembers = outcome.landed ? ['founder', 'joiner'] : ['founder'];
		const expectedInvites = outcome.landed ? ['inv-founder', 'inv-joiner'] : ['inv-founder'];
		for (const [index, view] of views.entries()) {
			expect(await ids(view, 'Member'), `Member on node ${index} — ${describeOutcome}`).to.deep.equal(expectedMembers);
			expect(await ids(view, 'ConsumedInvite'), `ConsumedInvite on node ${index} — ${describeOutcome}`).to.deep.equal(expectedInvites);
		}

		// The UNIQUE index tree is the third collection: it landed exactly when the row did.
		let duplicateRefused = false;
		try {
			await founder.db.exec(`insert into Member (Id, StampId, Name) values ('rival', 'stamp-joiner', 'rival')`);
		} catch {
			duplicateRefused = true;
		}
		expect(duplicateRefused, `the UNIQUE index holds the joiner's StampId iff the row landed — ${describeOutcome}`).to.equal(outcome.landed);

		if (!outcome.landed) {
			// Nothing landed: the refusal must be a clean one, never a half-landed report.
			expect(outcome.error, describeOutcome).not.to.be.instanceOf(CoordinatorPartialCommitError);
		}
	});
});
