/**
 * Ticket: a-failed-attempt-must-discharge-its-own-pend.
 *
 * The invariant under test: when a write attempt fails, the pending records that attempt created
 * are gone by the time the failure reaches the caller — or the caller is TOLD they are not. A brief
 * transport fault must cost a retry, never the write.
 *
 * Why it matters: a pending record's only removers are a client cancel, a divergence-shaped commit
 * refusal, and a forward write of the SAME action id (docs/repository.md, "a pending record's
 * lifetime is bounded by its writer"). `TransactorSource.transact` does issue that cancel on both of
 * its abort paths, but the cancel used to be sent once over the same broken connection and its
 * failure was never noticed: `processBatches` records each batch's outcome and swallows the
 * rejection, and `NetworkTransactor.cancel` had none of the completeness checks `pend` and `commit`
 * run after it. A cancel in which every peer's RPC failed returned normally, and every caller read
 * "returned" as "discharged". The abandoned record then made `ClusterMember.validatePendOperations`
 * vote reject on every later pend touching the block, so the retry collided with its own
 * predecessor, permanently.
 *
 * THE RETRY LOOPS HERE MINT A FRESH ACTION ID PER ATTEMPT, and that is load-bearing — do not
 * "simplify" them into reusing one id. An application-level retry opens a new transaction, so it
 * gets a new action id, which is none of the three removers above. A loop that reuses one id (the
 * `Collection.syncInternal` shape) is carved out by `validatePendOperations`' self-exclusion and can
 * never reproduce the collision; such a test would pass vacuously.
 *
 * The arms:
 *  - A: commit AND cancel are down for a bounded window. The reported chain. The write must survive.
 *  - B: only commit is down; the cancel transport is clean. This is the control that proves a cancel
 *    which actually RUNS is the whole repair — it passed before the fix and must keep passing.
 *  - C: the first attempt's pend reaches the server and loses only its reply. The record exists, so
 *    the next attempt collides with it unless the losing pend discharges before it returns.
 *  - D: the cancel transport is down for good. `NetworkTransactor.cancel` must THROW and name what
 *    is still held, rather than returning as if it had discharged.
 */

import { expect } from 'chai';
import { TransactorSource } from '@optimystic/db-core';
import type { BlockHeader, BlockId, IBlock, Transforms, IRepo, ActionId, BlockActionState, ITransactor, StaleFailure } from '@optimystic/db-core';
import { createMesh, buildNetworkTransactor, type Mesh, type MeshNode } from '../src/testing/mesh-harness.js';

const COLLECTION = 'reset-pend-collection' as BlockId;
const TAIL = 'T' as BlockId;

const makeHeader = (id: string): BlockHeader => ({ id: id as BlockId, type: 'test', collectionId: COLLECTION });
const makeBlock = (id: string): IBlock => ({ header: makeHeader(id), entries: [] } as unknown as IBlock);
const insertsFor = (...ids: string[]): Transforms => ({ inserts: Object.fromEntries(ids.map(id => [id, makeBlock(id)])), updates: {}, deletes: [] });
const updatesFor = (tag: string, ...ids: string[]): Transforms => ({ inserts: {}, updates: Object.fromEntries(ids.map(id => [id, [['entries', 0, 0, [tag]]]])), deletes: [] }) as unknown as Transforms;

/** One member's local view of a block — read straight off its StorageRepo, no cluster consult. */
const memberState = async (node: MeshNode, id: BlockId): Promise<BlockActionState> => {
	const result = await node.storageRepo.get({ blockIds: [id] });
	return result[id]!.state;
};

/** No member anywhere still holds a pending record for any of `actionIds`. */
const assertNoStrandedRecords = async (mesh: Mesh, actionIds: ActionId[], blockId: BlockId): Promise<void> => {
	for (const [i, node] of mesh.nodes.entries()) {
		const state = await memberState(node, blockId);
		for (const actionId of actionIds) {
			if (state.latest?.actionId === actionId) continue;	// it committed here; nothing to discharge
			expect(state.pendings ?? [], `node ${i} block ${blockId}: a failed attempt must not strand ${actionId}`)
				.to.not.include(actionId);
		}
	}
};

type RpcKind = 'pend' | 'cancel' | 'commit';

interface Gate {
	transactor: ITransactor;
	/** Break `kinds` at the client transport for `windowMs`, timed from the first call it catches. */
	breakFor: (kinds: RpcKind[], windowMs: number) => void;
	/** Break `kinds` with no end — the genuinely dead transport. */
	breakForever: (kinds: RpcKind[]) => void;
	heal: () => void;
	/** Let this action's pend REACH the server and lose only its reply. */
	loseReplyForPend: (actionId: ActionId) => void;
	injectedFailures: () => number;
}

/**
 * A NetworkTransactor over the mesh whose per-peer client repo can be taken down per RPC kind for a
 * bounded window — the shape of a stream reset, which is time-shaped rather than peer-shaped: every
 * peer is equally unreachable for the length of the fault. Everything not gated passes straight
 * through, so all the production code around the injection is what is under test.
 */
const buildGatedTransactor = (mesh: Mesh): Gate => {
	let broken = new Set<RpcKind>();
	let windowMs = 0;
	/** 0 = armed but not yet tripped; otherwise the wall-clock instant the fault heals. */
	let brokenUntil = 0;
	const repliesLost = new Set<string>();
	let injected = 0;
	/**
	 * The window starts at the FIRST gated call, not when the arm arms it. Arming starts the clock
	 * against everything that happens to run first — an ungated pend, mesh setup — so on a loaded
	 * machine the window could expire before the gated RPC was ever reached and the arm would assert
	 * against an injector that never fired. Starting on first contact keeps the fault time-shaped
	 * (once tripped it is down for every peer for `windowMs`) without that dependence.
	 */
	const isDown = (kind: RpcKind): boolean => {
		if (!broken.has(kind)) return false;
		if (brokenUntil === 0) brokenUntil = Date.now() + windowMs;
		return Date.now() < brokenUntil;
	};
	const reset = (): never => { injected++; throw new Error('The stream has been reset'); };

	const transactor = buildNetworkTransactor(mesh, {
		wrapRepo: (inner: IRepo): IRepo => ({
			get: (g, o) => inner.get(g, o),
			pend: async (r, o) => {
				if (isDown('pend')) return reset();
				if (repliesLost.has(r.actionId)) {
					// The work LANDS; only the reply is lost. That is what leaves a real pending record
					// behind for the caller's own next attempt to collide with — a pend that never
					// reached the server would leave nothing and prove nothing.
					await inner.pend(r, o).catch(() => undefined);
					return reset();
				}
				return inner.pend(r, o);
			},
			cancel: (r, o) => isDown('cancel') ? reset() : inner.cancel(r, o),
			commit: (r, o) => isDown('commit') ? reset() : inner.commit(r, o)
		})
	});

	return {
		transactor,
		breakFor: (kinds, ms) => { broken = new Set(kinds); windowMs = ms; brokenUntil = 0; },
		breakForever: (kinds) => { broken = new Set(kinds); windowMs = Number.POSITIVE_INFINITY; brokenUntil = 0; },
		heal: () => { broken = new Set(); windowMs = 0; brokenUntil = 0; },
		loseReplyForPend: (actionId) => { repliesLost.add(actionId); },
		injectedFailures: () => injected
	};
};

interface Attempt {
	actionId: ActionId;
	outcome: 'committed' | 'refused' | 'threw';
	detail?: string;
}

/**
 * The application-level retry shape: a fresh transaction — and therefore a fresh action id — per
 * attempt, driving the production caller (`TransactorSource.transact`) so its cancel sites are
 * inside the test. Stops at the first attempt that commits.
 *
 * `delayMs` is the caller's own backoff between attempts and defaults to ZERO on purpose: an
 * immediate retry is the shape that exposes a cancel which had not landed yet when its pend
 * returned. Only an arm whose failure path is itself instantaneous needs a delay, or every attempt
 * lands inside the same fault window and the arm measures the injector instead of the fix.
 */
const writeWithRetries = async (source: TransactorSource<IBlock>, rev: number, label: string, maxAttempts: number, delayMs = 0): Promise<Attempt[]> => {
	const attempts: Attempt[] = [];
	for (let i = 1; i <= maxAttempts; i++) {
		if (i > 1 && delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
		const actionId = `${label}-${i}` as ActionId;
		try {
			const failure: undefined | StaleFailure = await source.transact(updatesFor(`${label}-${i}`, TAIL), actionId, rev, TAIL, TAIL);
			if (!failure) {
				attempts.push({ actionId, outcome: 'committed' });
				return attempts;
			}
			attempts.push({ actionId, outcome: 'refused', detail: failure.reason ?? '' });
		} catch (e) {
			attempts.push({ actionId, outcome: 'threw', detail: (e as Error).message });
		}
	}
	return attempts;
};

const describeAttempts = (attempts: Attempt[]): string =>
	attempts.map(a => `${a.actionId}:${a.outcome}${a.detail ? `(${a.detail})` : ''}`).join(' | ');

describe('A failed attempt discharges its own pend — a brief reset costs a retry, not the write', function () {
	this.timeout(30_000);

	let mesh: Mesh;
	let gate: Gate;
	let source: TransactorSource<IBlock>;

	beforeEach(async () => {
		mesh = await createMesh(3, {
			responsibilityK: 3,
			clusterSize: 3,
			superMajorityThreshold: 0.67
		});
		gate = buildGatedTransactor(mesh);
		source = new TransactorSource<IBlock>(COLLECTION, gate.transactor, undefined);

		// Seed T at rev 1 over a clean transport, so every arm starts from a committed block.
		const seedPend = await gate.transactor.pend({ actionId: 'seed' as ActionId, transforms: insertsFor(TAIL), rev: 1, policy: 'c' });
		expect(seedPend.success, 'seed pend must succeed').to.equal(true);
		const seedCommit = await gate.transactor.commit({ actionId: 'seed' as ActionId, blockIds: [TAIL], tailId: TAIL, rev: 1 });
		expect(seedCommit.success, 'seed commit must succeed').to.equal(true);
	});

	it('A: a reset that takes down commit AND cancel together costs one attempt, not the write', async () => {
		// The reported chain: the commit fails over a broken connection, and the cancel that should
		// undo it is sent over the SAME broken connection. Before the fix the cancel was one shot whose
		// failure went unreported, and every later attempt was rejected by the first attempt's own
		// stranded record — the write failed for good. 150 ms is long enough to swallow the first
		// cancel round and short enough that the retry loop rides it out.
		gate.breakFor(['commit', 'cancel'], 150);
		const attempts = await writeWithRetries(source, 2, 'armA', 4);
		gate.heal();

		expect(gate.injectedFailures(), 'the fault must actually have fired').to.be.at.least(1);
		const committed = attempts.filter(a => a.outcome === 'committed');
		expect(committed.length, `the write must survive the reset — attempts: ${describeAttempts(attempts)}`).to.equal(1);
		expect(attempts[0]!.outcome, 'the attempt that met the fault must not have committed').to.not.equal('committed');

		// No later attempt may be refused for colliding with an earlier attempt of its OWN retry loop.
		for (const a of attempts.filter(x => x.outcome === 'refused')) {
			expect(a.detail ?? '', `attempt ${a.actionId} was refused by a predecessor's record — attempts: ${describeAttempts(attempts)}`)
				.to.not.match(/pending conflict/i);
		}

		// The durable state: the winner is committed, and nothing is left holding a record.
		const winner = committed[0]!.actionId;
		for (const [i, node] of mesh.nodes.entries()) {
			const state = await memberState(node, TAIL);
			expect(state.latest, `node ${i} must have advanced under ${winner}`).to.deep.include({ actionId: winner, rev: 2 });
		}
		await assertNoStrandedRecords(mesh, attempts.map(a => a.actionId), TAIL);
	});

	it('B (control): a reset on commit alone, with a working cancel transport, has always been survivable', async () => {
		// This arm passed BEFORE the fix and is here to keep the diagnosis honest: the repair is not
		// "retry harder", it is "the cancel has to actually run". If A ever regresses while B still
		// passes, the cancel path is the thing that broke.
		gate.breakFor(['commit'], 150);
		// This arm needs a caller backoff where the others do not: nothing on its failure path waits
		// (the cancel transport is clean, so the cancel lands on its first round), so with an
		// immediate retry every attempt would fall inside the same 150 ms window.
		const attempts = await writeWithRetries(source, 2, 'armB', 4, 250);
		gate.heal();

		expect(gate.injectedFailures(), 'the fault must actually have fired').to.be.at.least(1);
		expect(attempts.filter(a => a.outcome === 'committed').length, `attempts: ${describeAttempts(attempts)}`).to.equal(1);
		await assertNoStrandedRecords(mesh, attempts.map(a => a.actionId), TAIL);
	});

	it('C: a pend whose reply is lost discharges before it returns, so the next attempt is not spent on its own record', async () => {
		// The second, independent defect: pend's failure path used to fire its cancel as an unawaited
		// background microtask, so pend returned BEFORE the cancel landed. The attempt that followed
		// met the still-standing record and was refused — self-healing, but one attempt out of the
		// caller's budget every time. Only the FIRST attempt loses its reply here, so a correct
		// implementation commits on attempt 2 and a racing one needs attempt 3.
		gate.loseReplyForPend('armC-1' as ActionId);
		const attempts = await writeWithRetries(source, 2, 'armC', 4);

		expect(gate.injectedFailures(), 'the lost reply must actually have fired').to.be.at.least(1);
		expect(attempts[0]!.outcome, 'the attempt whose reply was lost must fail').to.not.equal('committed');
		expect(attempts.length, `attempt 2 must land — a wasted attempt means the cancel was not awaited. attempts: ${describeAttempts(attempts)}`).to.equal(2);
		expect(attempts[1]!.outcome, `attempts: ${describeAttempts(attempts)}`).to.equal('committed');
		await assertNoStrandedRecords(mesh, attempts.map(a => a.actionId), TAIL);
	});

	it('D: a cancel that reached nobody throws, naming the action and the blocks still held', async () => {
		// The core defect in isolation. `processBatches` never rethrows, so without a completeness
		// check `cancel` returned normally having discharged nothing at all.
		const pend = await gate.transactor.pend({ actionId: 'armD' as ActionId, transforms: updatesFor('armD', TAIL), rev: 2, policy: 'c' });
		expect(pend.success, 'the pend to be cancelled must succeed').to.equal(true);
		for (const [i, node] of mesh.nodes.entries()) {
			const state = await memberState(node, TAIL);
			expect(state.pendings ?? [], `node ${i} must hold the record before the cancel`).to.include('armD');
		}

		gate.breakForever(['cancel']);
		let thrown: Error | undefined;
		try {
			await gate.transactor.cancel({ actionId: 'armD' as ActionId, blockIds: [TAIL] });
		} catch (e) {
			thrown = e as Error;
		}
		gate.heal();

		expect(thrown, 'a cancel that reached nobody must not return as if it had discharged').to.be.instanceOf(Error);
		expect(thrown!.message, 'the failure must name the action').to.include('armD');
		expect(thrown!.message, 'the failure must name the block still held').to.include(TAIL);

		// The throw is honest: the records really are still standing.
		for (const [i, node] of mesh.nodes.entries()) {
			const state = await memberState(node, TAIL);
			expect(state.pendings ?? [], `node ${i} must still hold the record the cancel could not reach`).to.include('armD');
		}

		// And once the transport is back, a cancel discharges normally and the block writes again.
		await gate.transactor.cancel({ actionId: 'armD' as ActionId, blockIds: [TAIL] });
		await assertNoStrandedRecords(mesh, ['armD' as ActionId], TAIL);
		const after = await source.transact(updatesFor('armD-after', TAIL), 'armD-after' as ActionId, 2, TAIL, TAIL);
		expect(after, 'after a successful cancel the block must write cleanly').to.equal(undefined);
	});
});
