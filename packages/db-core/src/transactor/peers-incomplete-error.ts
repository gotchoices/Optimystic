import type { BlockId } from "../blocks/structs.js";
import type { ActionId } from "../collection/action.js";

/** Which operation of a network transaction the aggregate came from. */
export type TransactorPhase = 'get' | 'pend' | 'commit' | 'cancel';

/**
 * Some of the peers a `NetworkTransactor` operation sent to did not complete it, so the operation
 * failed as a whole. One class for all four of the aggregates the transactor composes —
 * `get`, `pend`, `commitBlocks` and `dischargeCancel` — with {@link phase} naming which one, so a
 * consumer can tell them apart from a field instead of from the message.
 *
 * **The messages are a downstream contract, so this class composes them.** A downstream
 * repository's retry classifier (sereus `control-write-retry.ts`, outside this tree) decides which
 * of our failures are safe to re-present by pairing the sentence `Some peers did not complete:`
 * with the `[block:` token in the per-peer detail. `'get'` and `'pend'` carry both and are the
 * retry-safe pair; `'commit'` carries the sentence but renders `[blocks:` (plural), which is what
 * keeps it out of that bucket; `'cancel'` renders `[block:` but has a sentence of its own, so for it
 * the *absence* of the shared sentence is the whole discriminator. That is why
 * {@link peersDidNotComplete} does not accept `'cancel'` — giving an undischarged cancel the shared
 * sentence would classify it as retry-safe, and a type error is a better guard than a comment.
 * Nothing in this repository reads any of this text, so nothing here would turn red if it changed:
 * keep all four byte-identical, and point a new consumer at {@link phase} instead. The callers still
 * render their own `details`, where the `[block:` / `[blocks:` tokens live.
 *
 * **`phase: 'get'` is a protocol fault, not unreachability.** That aggregate is raised only when
 * some coordinator responded and left a requested block out of its answer. A read that failed
 * because nobody answered is a `BlockUnavailableError` with reason `peers-unreachable`, a different
 * error entirely — so a consumer that reads `'get'` as "the cohort is away" would be wrong.
 *
 * **Local only.** The writer's own transactor throws this; it never crosses the repo protocol, so
 * unlike `PromiseShortfallError` it needs no wire type and no `toFailure`.
 *
 * NOTE: the per-peer detail stays prose on purpose. Nobody needs the per-batch statuses as data
 * today, and the four renderers do not share a status vocabulary (`response` / `no-response` /
 * `in-flight` at `get`, `non-success` at `pend` and `commitBlocks`, `responded` at
 * `dischargeCancel`), so structuring them means first agreeing on one. If a consumer ever needs the
 * peers as data, unify the vocabulary then rather than exporting four shapes.
 */
export class PeersIncompleteError extends Error {
	/** Which transactor operation composed this aggregate. */
	readonly phase: TransactorPhase;
	/**
	 * The root cause again, in the `AggregateError`-shaped array, beside the `cause` that is actually
	 * read (`classifyCommitFailure` deliberately does not walk it, and a commit-phase shortfall
	 * arrives nested there). It has no reader today — db-p2p's `printError` nests an aggregate's
	 * `errors` only for a real `AggregateError` or one whose `name` is literally 'AggregateError',
	 * which this is not — but two of the four sites set it before this class existed, so every phase
	 * sets it now rather than leaving a consumer to work out which phase carries which.
	 */
	readonly errors: readonly Error[];

	private constructor(phase: TransactorPhase, message: string, cause?: Error) {
		super(message);
		this.name = 'PeersIncompleteError';
		this.phase = phase;
		this.cause = cause;
		this.errors = cause ? [cause] : [];
	}

	/**
	 * The read, pend and commit aggregate: the shared sentence over the caller's per-peer `details`.
	 * `'cancel'` is not accepted — see the message contract above.
	 */
	static peersDidNotComplete(phase: Exclude<TransactorPhase, 'cancel'>, details: string, cause?: Error): PeersIncompleteError {
		return new PeersIncompleteError(phase, `Some peers did not complete: ${details}${rootSuffix(cause)}`, cause);
	}

	/** The cancel aggregate: its own sentence, naming the blocks still held, then the peers. */
	static cancelNotDischarged(actionId: ActionId, outstanding: readonly BlockId[], details: string, cause?: Error): PeersIncompleteError {
		return new PeersIncompleteError('cancel',
			`Cancel of action ${actionId} did not discharge ${outstanding.length} block(s): ${outstanding.join(', ')}`
			+ (details ? `; peers: ${details}` : '')
			+ rootSuffix(cause), cause);
	}
}

/** `; root: <message>`, the tail every phase's message carries when a root cause was found. */
function rootSuffix(cause?: Error): string {
	return cause ? `; root: ${cause.message}` : '';
}
