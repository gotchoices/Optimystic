/**
 * Ticket: a-cancel-that-misses-the-bar-strands-the-writers-pending-record.
 *
 * A cancel that runs out of budget is kept by the transactor that sent it and re-sent until some peer
 * answers it (`OwedCancels`, `packages/db-core/src/transactor/owed-cancels.ts`). The mesh reproduction
 * (`packages/db-p2p/test/failed-cancel-does-not-strand-the-writers-pend.spec.ts`) covers the re-send a
 * writer's next pend triggers; these cover the two paths it cannot reach without waiting on the wall
 * clock: the backoff timer, and a re-pend of the owed action itself, after which a late cancel would
 * delete the live record.
 */

import { expect } from 'chai';
import { NetworkTransactor } from '../src/transactor/network-transactor.js';
import type { OwedCancelClock } from '../src/transactor/owed-cancels.js';
import { peerIdFromString } from '../src/network/types.js';
import { localDurability } from '../src/network/durability.js';
import { waitFor } from '../src/testing/async-wait.js';
import type { ActionBlocks, ActionId, BlockId, ClusterPeers, IKeyNetwork, IRepo, PendRequest, PeerId } from '../src/index.js';

const PEER = 'peer-A';

const keyNetwork: IKeyNetwork = {
	async findCoordinator(): Promise<PeerId> { return peerIdFromString(PEER); },
	async findCluster(): Promise<ClusterPeers> { return { [PEER]: { multiaddrs: [], publicKey: '' } }; }
};

interface Sent { kind: 'pend' | 'cancel'; actionId: ActionId; blockIds: BlockId[] }

/** One coordinator whose cancel can be taken down, recording every pend and cancel it is sent. */
function makeRepo() {
	const sent: Sent[] = [];
	const state = { cancelDown: false };
	const repo: IRepo = {
		async get() { throw new Error('unused'); },
		async commit() { throw new Error('unused'); },
		async pend(request: PendRequest) {
			const blockIds = [...Object.keys(request.transforms.inserts ?? {}), ...Object.keys(request.transforms.updates ?? {})];
			sent.push({ kind: 'pend', actionId: request.actionId, blockIds });
			return { success: true, pending: [], blockIds, durability: localDurability() };
		},
		async cancel(actionRef: ActionBlocks) {
			if (state.cancelDown) throw new Error('The stream has been reset');
			sent.push({ kind: 'cancel', actionId: actionRef.actionId, blockIds: [...actionRef.blockIds] });
		}
	};
	return { repo, sent, state };
}

/** A clock whose timers fire only when the test says so, advancing time to their due instant. */
function makeClock() {
	let now = 1_000_000;
	const timers: { fn: () => void; dueAt: number; live: boolean }[] = [];
	const clock: OwedCancelClock = {
		now: () => now,
		setTimer: (fn, delayMs) => {
			const timer = { fn, dueAt: now + delayMs, live: true };
			timers.push(timer);
			return () => { timer.live = false; };
		}
	};
	const live = () => timers.filter(t => t.live);
	const fireNext = (): void => {
		const [timer] = live();
		if (!timer) throw new Error('no timer armed');
		timer.live = false;
		now = timer.dueAt;
		timer.fn();
	};
	return { clock, live, fireNext };
}

function makeTransactor() {
	const { repo, sent, state } = makeRepo();
	const { clock, live, fireNext } = makeClock();
	const transactor = new NetworkTransactor({
		timeoutMs: 1_000,
		// Short, so the cancel loop that runs out of budget does so in tens of milliseconds.
		abortOrCancelTimeoutMs: 50,
		keyNetwork,
		getRepo: () => repo,
		owedCancelClock: clock
	});
	return { transactor, sent, state, live, fireNext };
}

const cancelsOf = (sent: Sent[], actionId: ActionId): Sent[] => sent.filter(s => s.kind === 'cancel' && s.actionId === actionId);

describe('A cancel the transactor could not discharge is kept and re-sent', () => {
	it('is re-sent on the backoff timer with no pend in between, and stops once it is answered', async () => {
		const { transactor, sent, state, live, fireNext } = makeTransactor();
		state.cancelDown = true;
		let threw: unknown;
		try { await transactor.cancel({ actionId: 'X', blockIds: ['b1'] }); } catch (err) { threw = err; }
		expect(threw, 'the cancel still reports that it did not discharge').to.be.instanceOf(Error);
		expect(Object.fromEntries(transactor.owedCancelBlocks())).to.deep.equal({ X: ['b1'] });
		expect(live().length, 'one timer is armed while a cancel is owed').to.equal(1);

		// A re-send that still reaches nobody stays owed and re-arms.
		fireNext();
		await waitFor(() => live().length === 1, { description: 'the timer re-arms after a re-send that fell short' });
		expect(transactor.owedCancelBlocks().has('X')).to.equal(true);

		state.cancelDown = false;
		fireNext();
		await waitFor(() => transactor.owedCancelBlocks().size === 0, { description: 'the owed cancel is discharged' });
		expect(cancelsOf(sent, 'X'), 'exactly one answered re-send').to.deep.equal([{ kind: 'cancel', actionId: 'X', blockIds: ['b1'] }]);
		expect(live().length, 'nothing is armed once nothing is owed').to.equal(0);
	});

	it('is not sent for blocks its own action is pended on again, and stays owed for the blocks that pend does not name', async () => {
		const { transactor, sent, state, live, fireNext } = makeTransactor();
		state.cancelDown = true;
		await transactor.cancel({ actionId: 'X', blockIds: ['b1', 'b2'] }).catch(() => undefined);
		expect(Object.fromEntries(transactor.owedCancelBlocks())).to.deep.equal({ X: ['b1', 'b2'] });
		state.cancelDown = false;

		// The retry of X writes a fresh record on b1; a late cancel for X there would delete it.
		const pend = await transactor.pend({ actionId: 'X', transforms: { inserts: {}, updates: { b1: [['entries', 0, 0, ['x']]] }, deletes: [] }, policy: 'c' });
		expect(pend.success).to.equal(true);
		const pendAt = sent.findIndex(s => s.kind === 'pend' && s.actionId === 'X');
		expect(Object.fromEntries(transactor.owedCancelBlocks())).to.deep.equal({ X: ['b2'] });

		fireNext();
		await waitFor(() => transactor.owedCancelBlocks().size === 0, { description: 'the cancel still owed for b2 is discharged' });
		const after = cancelsOf(sent.slice(pendAt + 1), 'X');
		expect(after, 'the re-send after the pend names only the block the pend left behind').to.deep.equal([{ kind: 'cancel', actionId: 'X', blockIds: ['b2'] }]);
		expect(live().length).to.equal(0);
	});
});
