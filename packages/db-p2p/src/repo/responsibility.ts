import type { BlockId } from "@optimystic/db-core";

/**
 * How long one node's answer to "is this node in the block's cohort?" is reused before it is looked up
 * again. Shared by the two places that ask it — `CoordinatorRepo`'s write-path responsibility check and
 * `RepoService`'s redirect check — as a VALUE, never as a cache: they sit on either side of the served-repo
 * boundary and each keeps its own memo. With one TTL, the two can disagree about a block only inside the
 * same minute after its cohort changed, and in that window the coordinator's refusal is the backstop.
 */
export const RESPONSIBILITY_TTL_MS = 60_000;

/**
 * Why a node refused a request on responsibility grounds.
 *  - `not-responsible`: the cohort lookup answered, and this node is not in the cohort for these blocks.
 *    The request was sent to the wrong machine; the writer re-picks inside the cohort.
 *  - `undetermined`: the cohort lookup THREW, so this node cannot tell whether it is responsible. A routing
 *    fault on this node, not a misrouted request — and not a licence to accept: accepting there is what
 *    let a write commit on a phone that consulted nobody (GitHub #19).
 */
export type ResponsibilityRefusalKind = 'not-responsible' | 'undetermined';

/**
 * A write refused because this node is not, or cannot tell whether it is, responsible for the blocks it
 * names. Typed so a caller matches on {@link kind} and {@link blockIds} rather than on message text.
 *
 * Local only: over the repo protocol a thrown error aborts the stream, so a remote writer sees a failed
 * batch, not this class. Either way the writer's transactor excludes the peer and re-picks, which is the
 * whole remedy for both kinds.
 */
export class ResponsibilityRefusalError extends Error {
	constructor(
		readonly kind: ResponsibilityRefusalKind,
		/** Every block the refusal is about — all of them, so one log line names the whole misroute. */
		readonly blockIds: readonly BlockId[],
		/** Extra context for the message; never parsed. */
		detail?: string
	) {
		super(responsibilityRefusalMessage(kind, blockIds, detail));
		this.name = 'ResponsibilityRefusalError';
	}
}

function responsibilityRefusalMessage(kind: ResponsibilityRefusalKind, blockIds: readonly BlockId[], detail: string | undefined): string {
	const head = kind === 'not-responsible'
		? `Not responsible for block(s): ${blockIds.join(', ')}`
		: `Cannot determine responsibility for block(s): ${blockIds.join(', ')}`;
	return detail === undefined ? head : `${head} (${detail})`;
}
