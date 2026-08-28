import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import type { BlockId, ActionId, IBlock, BlockHeader, Transforms, IRepo } from '@optimystic/db-core';
import { createLibp2pNode } from '../src/libp2p-node.js';
import { MemoryRawStorage } from '../src/storage/memory-storage.js';
import type { BlockMetadata } from '../src/storage/struct.js';

/**
 * **Owned-block startup seed / node wiring.** A node's two resilience monitors (churn-spread and
 * rebalance) share ONE `Set<string>` of "blocks this node holds". The live feed
 * (`storageRepo.onAnyCollectionChange`) fires only on a NEW commit or a RECEIVED replica, so blocks
 * already durable from a PREVIOUS process run would stay untracked after a restart — a freshly
 * restarted node under-protecting exactly the data it already holds. `createLibp2pNodeBase` closes
 * that gap with a fire-and-forget startup scan (`seedOwnedBlocksFromStorage`).
 *
 * Every piece of that is already unit-tested in isolation: the scan loop in `owned-block-seed.spec.ts`,
 * the subscribe/gate/teardown wiring in `spread-on-churn-node-wiring.spec.ts` and
 * `rebalance-monitor-node-wiring.spec.ts`, and each backend's `listBlockIds` in that backend's spec.
 * What NONE of them covers is the seam this spec owns: that node construction calls the helper with
 * the *shared* owned-block set, under the "at least one monitor consumes it" gate, and that the ids
 * really arrive. A regression that reordered the gate, passed a fresh `Set` instead of the shared one,
 * or dropped the `void`-dispatch would pass every existing test.
 *
 * The restart is faithful, not simulated: `resolveStorage` returns a supplied `MemoryRawStorage`
 * verbatim (`withReadCache` wraps only non-memory storage) and nothing on the node's stop path
 * closes or clears it, so handing ONE `MemoryRawStorage` to two sequential `createLibp2pNode` calls
 * really does bring the second node up over the first node's durable state.
 *
 * Deliberately NOT staged here (each is covered where the mechanism actually lives):
 * - **Both monitors disabled → no scan.** The gate holds, but with no monitor wired there is no
 *   tracked set to inspect, so it is not externally observable at node level. The two wiring specs
 *   cover the disabled paths.
 * - **Backend without `listBlockIds`.** Second half of the same gate; covered by the helper spec's
 *   no-op case.
 * - **Stop during scan.** With a handful of ids the scan finishes far too fast to hit deterministically
 *   at node level; the helper spec's `isStopping` case covers the mechanism.
 */
describe('owned-block startup seed / node wiring (real libp2p, restart over durable storage)', function () {
	// Arm 1 boots TWO real nodes in sequence; the sibling wiring specs already budget 40s for one.
	this.timeout(60_000);

	const makeHeader = (id: string, collectionId: string): BlockHeader => ({
		id: id as BlockId,
		type: 'test',
		collectionId: collectionId as BlockId,
	});
	const makeBlock = (id: string, collectionId: string): IBlock => ({ header: makeHeader(id, collectionId) });
	const makeTransforms = (blockId: string, collectionId: string): Transforms => ({
		inserts: { [blockId]: makeBlock(blockId, collectionId) },
		updates: {},
		deletes: [],
	});

	/** Pend WITHOUT committing — the block gets durable metadata but never a committed revision. */
	async function pendOnly(repo: IRepo, blockId: string, collectionId: string, actionId: string): Promise<void> {
		const pend = await repo.pend({ actionId, transforms: makeTransforms(blockId, collectionId), policy: 'c' });
		expect(pend.success, `pend(${blockId})`).to.equal(true);
	}

	async function pendCommit(repo: IRepo, blockId: string, collectionId: string, actionId: string, rev: number): Promise<void> {
		await pendOnly(repo, blockId, collectionId, actionId);
		const commit = await repo.commit({ actionId, tailId: blockId as BlockId, rev, blockIds: [blockId as BlockId] });
		expect(commit.success, `commit(${blockId})`).to.equal(true);
	}

	async function spawn(networkName: string, overrides: Record<string, unknown> = {}): Promise<Libp2p> {
		return await createLibp2pNode({
			port: 0,
			networkName,
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 1,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: false },
			...overrides,
		} as any);
	}

	/**
	 * The monitors expose only `getTrackedBlockCount()` — no id enumeration — so read the set itself.
	 * That is the stronger assertion anyway: this IS the shared `ownedBlocks` instance node-base passed
	 * into the monitor via `deps.trackedBlocks`, so reading it proves identity as well as content. The
	 * monitors are deliberately absent from `OptimysticNodeAttachments` (node-internal wiring, see
	 * `src/optimystic-node.ts`), which is why the sibling wiring specs use the same `node: any` style.
	 */
	const trackedIds = (monitor: unknown): Set<string> => (monitor as any).trackedBlocks as Set<string>;

	/**
	 * The seed is dispatched with `void …` — node construction does NOT await it. Poll on a short
	 * interval rather than sleeping a fixed span and asserting once (flaky, or needlessly slow), and
	 * name the missing ids on timeout so a failure says what never arrived.
	 */
	async function waitForTrackedIds(monitor: unknown, expected: string[], label: string, timeoutMs = 5000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const tracked = trackedIds(monitor);
			const missing = expected.filter((id) => !tracked.has(id));
			if (missing.length === 0) return;
			if (Date.now() >= deadline) {
				throw new Error(
					`${label}: startup seed never delivered [${missing.join(', ')}] within ${timeoutMs}ms `
					+ `(tracked: [${Array.from(tracked).join(', ')}])`
				);
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}

	it('a restarted node seeds its owned-block set from storage the previous run left behind', async () => {
		// ONE storage instance across two node lifetimes = a real restart. Each `it` builds its own so
		// ids cannot leak between arms and break set equality.
		const shared = new MemoryRawStorage();
		const networkName = 'seed-restart';
		const committed = ['seed-restart-b1', 'seed-restart-b2', 'seed-restart-b3'];
		const pendOnlyId = 'seed-restart-pending';

		const node1: any = await spawn(networkName, { storage: shared });
		try {
			// Commit through the real coordinated repo (clusterSize 1 → self-only consensus). Going through
			// the production commit path is the point: it proves the scan later enumerates metadata a REAL
			// commit wrote, rather than a hand-seeded shape production never produces.
			const repo1 = node1.coordinatedRepo as IRepo;
			let rev = 1;
			for (const id of committed) await pendCommit(repo1, id, 'seed-coll', `seed-a${rev}`, rev++);

			expect(trackedIds(node1.spreadOnChurnMonitor), 'node1 tracked its own commits via the live feed')
				.to.deep.equal(new Set(committed));

			// A fourth block that is pended and never committed — see the node2 assertion below.
			await pendOnly(repo1, pendOnlyId, 'seed-coll', 'seed-pending-1');
		} finally {
			// Stop node1 unconditionally: an assertion failure above must not leak a live node into node2's
			// lifetime (and the seed's stop wrapper is the OUTERMOST one — a hang here means the wrapper
			// chain broke).
			await node1.stop();
		}

		// node2 commits NOTHING. Anything in its tracked set can only have come from the startup scan —
		// that is the whole assertion. A restart keeps its network name.
		const node2: any = await spawn(networkName, { storage: shared });
		try {
			const monitor = node2.spreadOnChurnMonitor;
			expect(monitor, 'spread monitor wired on the restarted node').to.exist;

			// The pend-only block IS seeded, and that is the truthful assertion — not an oversight. Why, and
			// why the over-inclusion is accepted, is the NOTE on `seedOwnedBlocksFromStorage`; the shared
			// raw-storage conformance suite pins the same population per backend. Asserting the real
			// behavior means a future change that starts filtering to committed-only fails loudly instead of
			// silently altering what a restarted node protects.
			//
			// Deterministic here only because a solo node with no peers never runs a spread sweep during the
			// test — `SpreadOnChurnMonitor` sweeps on `connection:close`, and its sweep is what would untrack
			// a no-local-data block. An unconditional startup sweep would make this timing-dependent.
			const expected = [...committed, pendOnlyId];
			await waitForTrackedIds(monitor, expected, 'node2');
			expect(trackedIds(monitor), 'restarted node tracks exactly the durable blocks, nothing more')
				.to.deep.equal(new Set(expected));
		} finally {
			await node2.stop();
		}
	});

	it('the gate is the owned-block FEED, not the spread block: a rebalance-only node still seeds', async () => {
		// The scan is gated on `offOwnedBlockFeed` being set — i.e. on SOME monitor consuming the shared
		// set — not on the spread monitor specifically. With spread disabled, the feed is registered by the
		// rebalance block's own `ensureOwnedBlockFeed()` call, and the scan's gate must see that. This is
		// the path arm 1 cannot reach.
		//
		// Storage is pre-populated DIRECTLY here (no producer node): arm 1 already established that a real
		// commit writes metadata `listBlockIds` enumerates, so this arm only needs *some* durable metadata
		// to prove the gate.
		const storage = new MemoryRawStorage();
		const ids = ['seed-gate-b1', 'seed-gate-b2'];
		let rev = 1;
		for (const id of ids) {
			const meta: BlockMetadata = { ranges: [[1, rev]], latest: { rev, actionId: `tx:gate${rev}` as ActionId } };
			await storage.saveMetadata(id as BlockId, meta);
			rev++;
		}

		const node: any = await spawn('seed-gate-spreadoff', {
			storage,
			spreadOnChurn: { enabled: false },
			arachnode: { enableRingZulu: true },
		});
		try {
			expect(node.spreadOnChurnMonitor, 'spread monitor not wired when disabled').to.equal(undefined);
			// Assert the monitor exists BEFORE polling: the rebalance wiring block swallows its own errors
			// and continues, so a wiring failure would otherwise surface as an opaque poll timeout.
			const monitor = node.rebalanceMonitor;
			expect(monitor, 'rebalance monitor wired (it is what registers the owned-block feed here)').to.exist;

			await waitForTrackedIds(monitor, ids, 'rebalance-only node');
			expect(trackedIds(monitor), 'rebalance-only node seeded exactly the pre-populated ids')
				.to.deep.equal(new Set(ids));
		} finally {
			await node.stop();
		}
	});
});
