/** Which operation of a network transaction the aggregate came from. */
export type TransactorPhase = 'get' | 'pend' | 'commit' | 'cancel';

/**
 * Some of the peers a `NetworkTransactor` operation sent to did not complete it, so the operation
 * failed as a whole. One class for all four of the aggregates the transactor composes —
 * `get`, `pend`, `commitBlocks` and `dischargeCancel` — with {@link phase} naming which one, so a
 * consumer can tell them apart from a field instead of from the message.
 *
 * **The messages are a downstream contract.** The sentence `Some peers did not complete:` on the
 * `get`, `pend` and `commit` phases, its *absence* on `cancel`, and the disjoint `[block:` /
 * `[blocks:` tokens in the per-peer detail are what a downstream repository's retry classifier
 * (sereus `control-write-retry.ts`, outside this tree) tests to decide which of our failures are
 * safe to re-present. Nothing in this repository reads them, so nothing here would turn red if they
 * changed — keep all four byte-identical, and point a new consumer at {@link phase} instead.
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

	constructor(phase: TransactorPhase, message: string, cause?: Error) {
		super(message);
		this.name = 'PeersIncompleteError';
		this.phase = phase;
		// Both shapes, for every phase. `cause` is the one that is read: `classifyCommitFailure`
		// deliberately does not walk it, and a commit-phase shortfall arrives nested there. The
		// `AggregateError`-shaped `errors` array has no reader today — db-p2p's `printError` nests an
		// aggregate's `errors` only for a real `AggregateError` or one whose `name` is literally
		// 'AggregateError', which this is not — but two of the four sites set it and two did not, and
		// setting it everywhere costs nothing and spares a reader working out which phase carries which.
		this.cause = cause;
		(this as unknown as AggregateError).errors = cause ? [cause] : [];
	}
}
