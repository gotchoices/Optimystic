import type { PromiseShortfall, ShortfallFailure, SoloRefusalReason } from "./struct.js";

/**
 * A pend the cohort could not accept because too few of its members answered the promise round: the
 * approvals fell short of the bar with no member refusing the write as a lost race or a held block,
 * and too few rejecting it for a rejection. Nobody judged the write; the cohort was not all there.
 * Not retryable by a write path — every coordinator of the cohort meets the same silent members, so a
 * re-read and re-pend fails the same way until they answer again. Nothing was saved: the members that
 * approved release their reservation when the writer cancels.
 *
 * ONE class for every place it is raised, as `TransactionExpiredError` is. The cluster coordinator
 * (db-p2p `ClusterCoordinator`) raises it; the coordinating repo returns its facts as a
 * {@link ShortfallFailure} ({@link toFailure}), which is what lets a remote writer receive them at
 * all; and each write path (`Collection.sync`, `TransactionCoordinator.commit`) raises it again from
 * that refusal.
 *
 * The message is the sentence the coordinator has always thrown, byte for byte: a downstream
 * repository matches it to retry a silent cohort (backlog
 * `debt-a-downstream-repo-classifies-retries-by-parsing-our-error-text`). Test for this class, or for
 * the refusal with `isShortfallFailure`, rather than for the text.
 */
export class PromiseShortfallError extends Error {
	/** Approve votes the round received. */
	readonly approvals: number;
	/** Reject votes the round received — fewer than would make the round a rejection. */
	readonly rejections: number;
	/** How many members the cohort the round ran on has. */
	readonly peerCount: number;
	/** The approvals the round needed. */
	readonly needed: number;
	/** Peer-id strings of the cohort members that cast no promise vote at all. */
	readonly silentPeers: readonly string[];
	/** Why a lone coordinator refused to write alone, when that is what this shortfall is
	 * ({@link PromiseShortfall.soloRefused}); absent when a consensus round fell short. */
	readonly soloRefused?: SoloRefusalReason;

	constructor(shortfall: PromiseShortfall) {
		// NOTE: `shortfall` off the wire is trusted as shaped (`isShortfallFailure` checks only presence),
		// so a malformed coordinator answer throws a TypeError here (no `silentPeers` array) instead of
		// this error. Either still ends the write; if hostile coordinators become a concern, validate the
		// shape where the refusal is received, as for `TransactionExpiredError`.
		super(`Failed to get super-majority: ${shortfall.approvals}/${shortfall.peerCount} approvals (needed ${shortfall.needed}, ${shortfall.rejections} rejections)`);
		this.name = 'PromiseShortfallError';
		this.approvals = shortfall.approvals;
		this.rejections = shortfall.rejections;
		this.peerCount = shortfall.peerCount;
		this.needed = shortfall.needed;
		this.silentPeers = [...shortfall.silentPeers];
		if (shortfall.soloRefused !== undefined) this.soloRefused = shortfall.soloRefused;
	}

	/** The refusal a coordinating repo returns for this error, so it crosses the repo protocol as an
	 *  answer rather than as a reset stream. */
	toFailure(): ShortfallFailure {
		return {
			success: false,
			conflict: false,
			reason: this.message,
			shortfall: {
				approvals: this.approvals,
				rejections: this.rejections,
				peerCount: this.peerCount,
				needed: this.needed,
				silentPeers: [...this.silentPeers],
				...(this.soloRefused === undefined ? {} : { soloRefused: this.soloRefused }),
			},
		};
	}
}
