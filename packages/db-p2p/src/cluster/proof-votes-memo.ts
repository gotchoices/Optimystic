/**
 * Total length, in characters, of the keys a proof-votes memo retains. Proofs measure about 1 KB
 * (one signer) to 4.6 KB (ten signers, two blocks) as JSON, so this holds a few hundred of them —
 * far more than the handful of distinct proofs a quiet node's repair consults keep meeting.
 */
export const PROOF_VOTES_MEMO_CHARS = 1024 * 1024;

/**
 * A key longer than this is never retained. A proof's size is chosen by whoever sends it (a padded
 * message can approach the 8 MiB frame), and without a per-entry cap one large proof would flush
 * every other entry out of {@link PROOF_VOTES_MEMO_CHARS}.
 */
export const PROOF_VOTES_MEMO_ENTRY_CHARS = 64 * 1024;

export type VerdictMemoLimits = {
	/** Budget for the summed lengths of the retained keys; least recently used goes first. */
	readonly totalChars: number;
	/** A verdict whose key is longer than this is computed and returned but not retained. */
	readonly entryChars: number;
};

/**
 * Remembers verdicts of a pure computation by a string key that determines the computation's
 * result. Two things are saved:
 *
 * - **In flight:** while a computation for a key is pending, another call with the same key awaits
 *   the same promise instead of starting a second one.
 * - **Retained:** a settled verdict is remembered only when the caller's `retain` says so, bounded
 *   by the summed length of the retained keys (see {@link VerdictMemoLimits}). A hit makes the entry
 *   the most recently used.
 *
 * Holds no crypto and knows nothing of proofs, so its rules are testable with a fake computation;
 * `commit-proof.ts` is its user.
 *
 * NOTE: a peer holding enough keys to mint valid self-certified proofs can fill the budget with
 * passing verdicts and push honest proofs out, which costs those proofs a full re-verification and
 * nothing else. If that ever shows up in profiles, bound retention per serving peer.
 */
export class VerdictMemo<V> {
	private readonly retained = new Map<string, V>();
	private readonly inFlight = new Map<string, Promise<V>>();
	private retainedChars = 0;

	constructor(private readonly limits: VerdictMemoLimits = {
		totalChars: PROOF_VOTES_MEMO_CHARS,
		entryChars: PROOF_VOTES_MEMO_ENTRY_CHARS
	}) {
		if (!(limits.entryChars <= limits.totalChars)) {
			throw new Error('VerdictMemo entryChars must not exceed totalChars');
		}
	}

	/**
	 * The verdict for `key`: a retained one, the one being computed for it now, or a new computation
	 * by `compute`, retained afterwards when `retain(verdict)` is true. A rejection of `compute`
	 * reaches every caller waiting on it and retains nothing.
	 */
	judge(key: string, compute: () => Promise<V>, retain: (verdict: V) => boolean): Promise<V> {
		if (this.retained.has(key)) {
			return Promise.resolve(this.refresh(key));
		}
		const pending = this.inFlight.get(key);
		if (pending !== undefined) {
			return pending;
		}
		// `compute` starts on a microtask, so the `finally` below cannot remove the entry before it is
		// set, even when `compute` throws synchronously.
		const computation = Promise.resolve()
			.then(compute)
			.then(verdict => {
				if (retain(verdict)) {
					this.keep(key, verdict);
				}
				return verdict;
			})
			.finally(() => {
				this.inFlight.delete(key);
			});
		this.inFlight.set(key, computation);
		return computation;
	}

	/** Move a retained entry to the most recently used end and return its verdict. */
	private refresh(key: string): V {
		const verdict = this.retained.get(key) as V;
		this.retained.delete(key);
		this.retained.set(key, verdict);
		return verdict;
	}

	private keep(key: string, verdict: V): void {
		if (key.length > this.limits.entryChars) {
			return;
		}
		if (this.retained.delete(key)) {
			this.retainedChars -= key.length;
		}
		this.retained.set(key, verdict);
		this.retainedChars += key.length;
		this.evictToBudget();
	}

	/** Evict least recently used entries until the retained keys fit the budget. The newest entry is
	 *  never evicted by this: it alone is at most `entryChars`, which is at most `totalChars`. */
	private evictToBudget(): void {
		for (const key of this.retained.keys()) {
			if (this.retainedChars <= this.limits.totalChars) {
				return;
			}
			this.retained.delete(key);
			this.retainedChars -= key.length;
		}
	}
}
