/**
 * Test helper: a delegating transactor whose COMMIT-SIDE calls (`pend` / `commit`)
 * can be parked behind a gate the test controls, modelling an unresponsive commit
 * cohort. `get` always passes straight through — the stall models a cohort that
 * will not acknowledge a commit, not a dead network — so committed reads that
 * fault blocks keep working while the writer is parked.
 *
 * Built for the `committed-read-snapshot-declaration` stall proofs
 * (committed-read-stall.spec.ts): the harness Quereus ships (`installCommitStall`)
 * parks at the ENTRY of a registered `VirtualTableConnection.commit`, i.e. before
 * this plugin's publish window begins. This gate parks INSIDE it — at the
 * transactor calls the publish actually makes — so a stall can be placed
 * mid-publish (e.g. between tree 2 and tree 3 of the legacy multi-tree sweep).
 *
 * Usage:
 *   const gate = new CommitGate();
 *   const gated = gateTransactor(inner, gate, { gateOn: 'commit', skipCalls: 1 });
 *   plugin.collectionFactory.registerTransactor('local:test', gated);
 *   ...
 *   gate.arm();
 *   const writer = db.exec('insert ...');       // un-awaited
 *   await gate.entered;                          // writer provably parked
 *   ... run committed reads ...
 *   gate.release();                              // or gate.releaseWithError(err)
 *   await writer;
 */
import type {
	ITransactor,
	BlockGets,
	GetBlockResults,
	ActionBlocks,
	BlockActionStatus,
	PendRequest,
	PendResult,
	CommitRequest,
	CommitResult,
} from '@optimystic/db-core';

export class CommitGate {
	private armed = false;
	private gatedCallsSeen = 0;
	private enteredResolve!: () => void;
	private barrierResolve!: () => void;
	private barrierReject!: (err: Error) => void;
	private released = false;
	/** Resolves when a gated call has actually ENTERED the stall (is parked). */
	readonly entered: Promise<void>;
	private readonly barrier: Promise<void>;

	constructor() {
		this.entered = new Promise<void>(resolve => {
			this.enteredResolve = resolve;
		});
		this.barrier = new Promise<void>((resolve, reject) => {
			this.barrierResolve = resolve;
			this.barrierReject = reject;
		});
		// A release-with-error rejects the shared barrier; every parked (and later)
		// call observes it. Mark handled so an un-entered gate can't surface as an
		// unhandled rejection.
		this.barrier.catch(() => { });
	}

	/** Arm the gate: the next gated call (after any configured skips) parks. */
	arm(): void {
		this.armed = true;
	}

	/** True while armed and not yet released. */
	get isArmed(): boolean {
		return this.armed && !this.released;
	}

	/** True once at least one gated call has parked. */
	get isEntered(): boolean {
		return this.gatedCallsSeen > 0;
	}

	/** Release the gate; the parked call (and all later ones) proceed. Idempotent. */
	release(): void {
		if (this.released) return;
		this.released = true;
		this.armed = false;
		this.barrierResolve();
	}

	/** Release the gate INTO A FAILURE: the parked call (and all later ones) reject
	 * with `err` instead of proceeding — a stalled commit that then fails. Idempotent
	 * with {@link release} (first call wins). */
	releaseWithError(err: Error): void {
		if (this.released) return;
		this.released = true;
		this.armed = false;
		this.barrierReject(err);
	}

	/** @internal Called by the gated transactor. Parks while armed and unreleased.
	 * Only calls parked at release time observe a release-with-error; calls arriving
	 * AFTER a release (of either kind) pass through untouched — the cohort has
	 * recovered, and later commits must be able to succeed (e.g. the clean commit
	 * that clears the degraded latch after a partial-commit test). */
	async pass(): Promise<void> {
		if (!this.armed || this.released) {
			return;
		}
		this.gatedCallsSeen++;
		this.enteredResolve();
		await this.barrier;
	}
}

export interface GateTransactorOptions {
	/** Which commit-side calls the gate covers. Default `'both'` (pend AND commit park).
	 * `'commit'` lets pends through, parking only the final commit call — useful for
	 * counting one gated call per tree in the legacy sweep. */
	gateOn?: 'pend' | 'commit' | 'both';
	/** Number of gated calls (of the covered kind, while armed) to let THROUGH before
	 * parking — places the stall mid-publish (e.g. `skipCalls: 1` with `gateOn:
	 * 'commit'` lets tree 1 of a legacy sweep flush and parks tree 2). Default 0. */
	skipCalls?: number;
}

/** Wrap `inner` so its commit-side calls await `gate` (see {@link CommitGate}). */
export function gateTransactor(
	inner: ITransactor,
	gate: CommitGate,
	options?: GateTransactorOptions,
): ITransactor {
	const gateOn = options?.gateOn ?? 'both';
	const skipCalls = options?.skipCalls ?? 0;
	let armedCallsSeen = 0;

	const maybeGate = async (kind: 'pend' | 'commit'): Promise<void> => {
		if (gateOn !== 'both' && gateOn !== kind) return;
		// Count only calls made while the gate is armed, so seeding traffic before
		// arm() never consumes the skip budget.
		if (gate.isArmed) {
			armedCallsSeen++;
			if (armedCallsSeen <= skipCalls) return;
		}
		await gate.pass();
	};

	return {
		async get(blockGets: BlockGets): Promise<GetBlockResults> {
			return inner.get(blockGets);
		},
		async getStatus(refs: ActionBlocks[]): Promise<BlockActionStatus[]> {
			return inner.getStatus(refs);
		},
		async pend(request: PendRequest): Promise<PendResult> {
			await maybeGate('pend');
			return inner.pend(request);
		},
		async commit(request: CommitRequest): Promise<CommitResult> {
			await maybeGate('commit');
			return inner.commit(request);
		},
		async cancel(ref: ActionBlocks): Promise<void> {
			return inner.cancel(ref);
		},
	};
}
