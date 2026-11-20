import { walkBlobPieces, type BlobDigest, type BlobRef, type PieceId, type PieceSource } from '@optimystic/db-core';
import { createLogger } from '../logger.js';
import { BlobRecordFormatError } from './blob-record.js';
import type { BlobRecordStore } from './blob-record-store.js';
import { localPieceSource } from './local-piece-source.js';
import type { IPieceStore } from './piece-store.js';
import type { SweepGate } from './sweep-gate.js';

const log = createLogger('blob:store');

/**
 * The ids of pieces a put has stored, or is about to store, before the record naming them is
 * written: reference-counted, so two puts sharing a piece each hold it. A put adds an id before it
 * stores the piece, inside the same shared hold of the gate, and releases its ids only after its
 * record write has resolved, or when it fails.
 */
export class InProgressPieces {
	private readonly counts = new Map<PieceId, number>();

	add(id: PieceId): void {
		this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
	}

	release(ids: Iterable<PieceId>): void {
		for (const id of ids) {
			const count = this.counts.get(id);
			if (count === undefined) {
				continue;
			}
			if (count <= 1) {
				this.counts.delete(id);
			} else {
				this.counts.set(id, count - 1);
			}
		}
	}

	ids(): Iterable<PieceId> {
		return this.counts.keys();
	}
}

export type BlobSweepResult =
	| { readonly kind: 'swept'; readonly deleted: number; readonly kept: number; readonly failed: number }
	| { readonly kind: 'aborted'; readonly reason: 'record-unreadable' | 'tree-unreadable'; readonly ref: BlobRef };

type SweptResult = Extract<BlobSweepResult, { kind: 'swept' }>;
type AbortedResult = Extract<BlobSweepResult, { kind: 'aborted' }>;

/** An aborted sweep, with what made the record or tree unreadable, for its log line. */
interface SweepAbort {
	readonly result: AbortedResult;
	readonly detail: string;
}

export interface PieceSweeperDeps {
	readonly pieces: IPieceStore;
	readonly records: BlobRecordStore;
	readonly gate: SweepGate;
	readonly inProgress: InProgressPieces;
	readonly digest: BlobDigest;
	/** Refs a read or fetch is running on (`LocalBlobService.inUseRefs`); their present pieces are kept
	 *  whether or not they have a record. */
	readonly inUseRefs: () => Iterable<BlobRef>;
}

/**
 * Deletes every stored piece in no held blob's tree (docs/blobs.md §Holds), closed against the
 * five things that can make a piece live while it decides:
 *
 * - a put that has stored pieces but not yet written its record: its ids are in `inProgress` when
 *   the deletes are decided, because an id is added before its piece is stored and released only
 *   after the record naming it is written — and a released id's record was written either before
 *   the sweep started (so the records pass read it) or after (so it is in `changed`);
 * - a record written or changed after the records pass read it: `noteRecordChange` puts it in
 *   `changed`, and it is walked again under the exclusive gate, where no record can change;
 * - a put storing a piece the sweep has just decided to delete: it waits on the gate while the
 *   deletes run, then finds the piece absent and writes it;
 * - a fetch storing a list piece over a child already present as an orphan
 *   (`BlobFetchStore.storePiece`): the fetch holds the blob before it stores anything and stores a
 *   list piece before the pieces it names, so only such a child can be missed — skipped by the
 *   records pass's walk while its parent was absent, and never stored again by the fetch, which
 *   finds it present. Every fetched piece notes its blob in `changed` inside the same shared hold
 *   as its `put`, so the decide step, which runs after every shared holder has finished, walks the
 *   blob again with the parent present and keeps the child. A parent stored after the decide step
 *   finds the child deleted, and the fetch's next plan asks for it. A fetch's ids need no
 *   `inProgress`: its record exists before its first piece;
 * - a read or fetch in flight on a blob whose last hold has gone, so it has no record and the
 *   records pass never reaches it: `inUseRefs` names it, and the decide step walks it with no record
 *   required. The window a read beginning during the delete phase leaves open is the pre-existing
 *   exposure of reading an unheld blob (`NodeBlobService.storedPiece`).
 */
export class PieceSweeper {
	private readonly pieces: IPieceStore;
	private readonly records: BlobRecordStore;
	private readonly gate: SweepGate;
	private readonly inProgress: InProgressPieces;
	private readonly digest: BlobDigest;
	private readonly inUseRefs: () => Iterable<BlobRef>;
	private readonly source: PieceSource;
	/** The refs whose records changed since the running sweep started; absent while none runs. */
	private changed: Set<BlobRef> | undefined;
	private running: Promise<BlobSweepResult> | undefined;

	constructor(deps: PieceSweeperDeps) {
		this.pieces = deps.pieces;
		this.records = deps.records;
		this.gate = deps.gate;
		this.inProgress = deps.inProgress;
		this.digest = deps.digest;
		this.inUseRefs = deps.inUseRefs;
		this.source = localPieceSource(deps.pieces);
	}

	/**
	 * Called by every record change, and by every piece a fetch stores under a held ref, inside its
	 * shared hold, before the write.
	 */
	noteRecordChange(ref: BlobRef): void {
		this.changed?.add(ref);
	}

	/** Single-flight: a call while a sweep runs returns that sweep's promise. */
	run(): Promise<BlobSweepResult> {
		this.running ??= this.sweep().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}

	/** Resolves once no sweep runs (at once when none does), whatever the running one's outcome. */
	async idle(): Promise<void> {
		await this.running?.then(noop, noop);
	}

	private async sweep(): Promise<BlobSweepResult> {
		try {
			// Taking the gate means every record change already running has finished, so the records
			// pass reads it; every later change lands in `changed`.
			await this.gate.exclusive(async () => {
				this.changed = new Set();
			});
			const candidates = await this.listCandidates();
			const live = new Set<PieceId>();
			const outcome = await this.walkHeld(await this.records.listRefs(), live)
				?? await this.gate.exclusive(() => this.decideAndDelete(candidates, live));
			return report(outcome);
		} finally {
			this.changed = undefined;
		}
	}

	// NOTE: holds every stored piece id in memory, about 60 bytes each; page the listing if a node
	// ever holds tens of millions of pieces.
	private async listCandidates(): Promise<PieceId[]> {
		const candidates: PieceId[] = [];
		for await (const id of this.pieces.list()) {
			candidates.push(id);
		}
		return candidates;
	}

	// NOTE: puts and record changes wait while this runs, bounded by the re-walks of records changed
	// during the sweep, the walks of the refs in use, and the deletes — not by the walk of every held
	// blob.
	private async decideAndDelete(candidates: readonly PieceId[], live: Set<PieceId>): Promise<SweptResult | SweepAbort> {
		// Inside the exclusive gate because this is the latest point at which the sweep can read
		// anything, so every use taken before the deletes begin is seen.
		const unreadable = await this.walkHeld(this.changed ?? [], live) ?? await this.walkInUse(live);
		if (unreadable !== undefined) {
			return unreadable;
		}
		for (const id of this.inProgress.ids()) {
			live.add(id);
		}
		return this.deleteUnheld(candidates, live);
	}

	private async walkHeld(refs: Iterable<BlobRef>, live: Set<PieceId>): Promise<SweepAbort | undefined> {
		for (const ref of refs) {
			const abort = await this.walkRecord(ref, live);
			if (abort !== undefined) {
				return abort;
			}
		}
		return undefined;
	}

	/**
	 * Keeps every present piece of the trees something is reading or fetching, record or no record:
	 * these are the refs `walkRecord` would return at once for, which is exactly the blob whose last
	 * hold has just gone while a read of it runs. A ref that also has a record is walked twice, which
	 * adds and removes nothing and costs one tree walk of a blob somebody is reading right now.
	 */
	private async walkInUse(live: Set<PieceId>): Promise<SweepAbort | undefined> {
		for (const ref of this.inUseRefs()) {
			const abort = await this.walkTree(ref, live);
			if (abort !== undefined) {
				return abort;
			}
		}
		return undefined;
	}

	// NOTE: every sweep reads every held blob's list pieces (one list piece per 174 data pieces).
	// NOTE: accepted tradeoff — one blob whose tree cannot be read (disk damage under a held blob)
	// stops every sweep until it is unpinned, which keeps data rather than guessing at what that tree
	// covered. And a list piece that is missing leaves the pieces under it unwalked, so they are
	// deleted; a fetch stores list pieces before the pieces under them and notes its blob with every
	// piece (`BlobFetchStore.storePiece`), which keeps this from deleting a fetch's progress.
	/** Adds every present piece of a held blob's tree to `live`; an abort when its record or tree cannot be read. A store fault reading the record propagates. */
	private async walkRecord(ref: BlobRef, live: Set<PieceId>): Promise<SweepAbort | undefined> {
		try {
			if (await this.records.get(ref) === undefined) {
				return undefined;
			}
		} catch (error) {
			if (error instanceof BlobRecordFormatError) {
				return abort('record-unreadable', ref, error);
			}
			throw error;
		}
		return this.walkTree(ref, live);
	}

	/** Adds every present piece of `ref`'s tree to `live`; an abort when the tree cannot be read. */
	private async walkTree(ref: BlobRef, live: Set<PieceId>): Promise<SweepAbort | undefined> {
		try {
			for await (const entry of walkBlobPieces(ref, this.source, { digest: this.digest })) {
				if (entry.present) {
					live.add(entry.id);
				}
			}
		} catch (error) {
			return abort('tree-unreadable', ref, error);
		}
		return undefined;
	}

	private async deleteUnheld(candidates: readonly PieceId[], live: ReadonlySet<PieceId>): Promise<SweptResult> {
		let deleted = 0;
		let kept = 0;
		let failed = 0;
		for (const id of candidates) {
			if (live.has(id)) {
				kept++;
				continue;
			}
			try {
				await this.pieces.delete(id);
				deleted++;
			} catch (error) {
				failed++;
				log('sweep:delete-failed piece=%s error=%s', id, describe(error));
			}
		}
		// No flush: a delete a crash undoes leaves an orphan for the next sweep.
		return { kind: 'swept', deleted, kept, failed };
	}
}

function abort(reason: AbortedResult['reason'], ref: BlobRef, error: unknown): SweepAbort {
	return { result: { kind: 'aborted', reason, ref }, detail: describe(error) };
}

/** Logs the sweep's outcome and returns the result its callers see. */
function report(outcome: SweptResult | SweepAbort): BlobSweepResult {
	if ('result' in outcome) {
		const { reason, ref } = outcome.result;
		log('sweep:aborted reason=%s ref=%s error=%s', reason, ref, outcome.detail);
		return outcome.result;
	}
	log('sweep:done deleted=%d kept=%d failed=%d', outcome.deleted, outcome.kept, outcome.failed);
	return outcome;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function noop(): void {
	// Waiting for a sweep to end, not for what it found.
}
