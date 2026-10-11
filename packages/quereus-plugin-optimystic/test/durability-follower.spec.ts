/**
 * The follower that tells a SQL commit saved below full replication when its whole cohort holds
 * it, driven directly with hand-built commit answers and full-replication events: it is
 * plugin-owned logic with no SQL or libp2p in it, so nothing is mocked. The producer side (who
 * records the shortfall, when the event fires) is pinned by db-p2p's own specs.
 */
import { expect } from 'chai';
import { transactionDurability } from '@optimystic/db-core';
import type {
	BlockDurabilityListener, BlockDurabilityReachedEvent, IBlockDurabilityNotifier, TransactionDurability, WriteDurability,
} from '@optimystic/db-core';
import { DurabilityFollower, type FollowVerdict } from '../src/optimystic-adapter/durability-follower.js';

const SELF = 'self-peer';
const OTHER = 'other-peer';

/** A node's full-replication event source, fired by hand. */
class Notifier implements IBlockDurabilityNotifier {
	private readonly listeners = new Set<BlockDurabilityListener>();
	onBlockDurabilityReached(listener: BlockDurabilityListener): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}
	reach(blockId: string, rev: number): void {
		const event: BlockDurabilityReachedEvent = { blockIds: [blockId], rev, actionId: `action@${rev}` };
		for (const listener of [...this.listeners]) listener(event);
	}
}

/** A collection saved on this node alone, its missing copy owed by this node's ledger. */
function local(blockRevs: Record<string, number> | undefined, overrides: Partial<WriteDurability> = {}): WriteDurability {
	return {
		quorum: 'local', confirmed: 1, cohort: 2, unconfirmed: [OTHER], cohortPeerIds: [SELF, OTHER],
		recordedBy: SELF, ...(blockRevs === undefined ? {} : { blockRevs }), ...overrides,
	};
}

function full(blockRevs: Record<string, number>): WriteDurability {
	return { quorum: 'full', confirmed: 2, cohort: 2, unconfirmed: [], cohortPeerIds: [SELF, OTHER], blockRevs };
}

function commit(collections: Record<string, WriteDurability | undefined>): TransactionDurability {
	return transactionDurability(new Map(Object.entries(collections)));
}

function setup(): { follower: DurabilityFollower; notifier: Notifier; held: string[]; follow: (id: string, d: TransactionDurability) => FollowVerdict } {
	const held: string[] = [];
	const follower = new DurabilityFollower({ onFullyHeld: id => held.push(id) });
	const notifier = new Notifier();
	follower.watch(notifier);
	return { follower, notifier, held, follow: (id, d) => follower.follow(id, d, { selfPeerId: SELF, notifier }) };
}

describe('DurabilityFollower', () => {
	it('decides which commits it can follow', () => {
		const cases: { name: string; durability: TransactionDurability; notifier?: 'none'; verdict: FollowVerdict }[] = [
			{ name: 'owed by this node', durability: commit({ t: local({ x: 5 }) }), verdict: 'pending' },
			{ name: 'already fully held', durability: commit({ t: full({ x: 5 }) }), verdict: 'held' },
			{ name: 'owed by another node', durability: commit({ t: local({ x: 5 }, { recordedBy: OTHER }) }), verdict: 'unfollowed' },
			{ name: 'owed by no ledger', durability: commit({ t: local({ x: 5 }, { recordedBy: undefined }) }), verdict: 'unfollowed' },
			{ name: 'torn', durability: commit({ t: local({ x: 5 }, { torn: ['y'] }) }), verdict: 'unfollowed' },
			{ name: 'holders unknown', durability: commit({ t: local({ x: 5 }), u: undefined }), verdict: 'unfollowed' },
			{ name: 'blocks unnamed', durability: commit({ t: local(undefined) }), verdict: 'unfollowed' },
			{
				name: 'one collection mixing a full and a below-full cohort answer',
				durability: commit({ t: local({ x: 5, y: 5 }, { otherCohorts: [full({})] }) }),
				verdict: 'unfollowed',
			},
			{ name: 'no event source on the node', durability: commit({ t: local({ x: 5 }) }), notifier: 'none', verdict: 'unfollowed' },
		];
		for (const c of cases) {
			const { follower, notifier } = setup();
			const verdict = follower.follow('tx', c.durability, { selfPeerId: SELF, notifier: c.notifier === 'none' ? undefined : notifier });
			expect(verdict, c.name).to.equal(c.verdict);
		}
	});

	it('clears a superseded write with the event for the write that superseded it', () => {
		const { notifier, held, follow } = setup();
		expect(follow('A', commit({ t: local({ x: 5 }) }))).to.equal('pending');
		expect(follow('B', commit({ t: local({ x: 7 }) }))).to.equal('pending');

		// The ledger keeps one entry per block, at its highest revision: X@5's event never fires.
		notifier.reach('x', 7);

		expect(held).to.deep.equal(['A', 'B']);
	});

	it('remembers an event that arrives before the commit it covers, at that revision only', () => {
		const { notifier, held, follow } = setup();
		notifier.reach('x', 5);

		expect(follow('at5', commit({ t: local({ x: 5 }) }))).to.equal('covered');
		expect(follow('at7', commit({ t: local({ x: 7 }) }))).to.equal('pending');
		expect(held, 'a covered commit is reported by the caller, not the follower').to.deep.equal([]);

		notifier.reach('x', 6);
		expect(held, 'a lower revision covers nothing').to.deep.equal([]);
		notifier.reach('x', 7);
		expect(held).to.deep.equal(['at7']);
	});

	it('waits for every collection of a commit (a table and its index)', () => {
		const { notifier, held, follow } = setup();
		expect(follow('tx', commit({ table: local({ row: 3, header: 3 }), index: local({ entry: 3 }) }))).to.equal('pending');

		notifier.reach('row', 3);
		notifier.reach('header', 3);
		expect(held).to.deep.equal([]);
		notifier.reach('entry', 3);
		expect(held).to.deep.equal(['tx']);
	});

	it('clears a pending block when a later commit writes it at full replication, without an event', () => {
		const { follower, notifier, held, follow } = setup();
		expect(follow('A', commit({ t: local({ x: 5 }) }))).to.equal('pending');

		follower.coverHeld(commit({ t: full({ x: 8 }) }), notifier);

		expect(held).to.deep.equal(['A']);
	});
});
