/**
 * The receiving half of `announce` (docs/blobs.md §Placement, copying and durability): a peer says a
 * committed row in some scope references a blob, and this node decides for itself whether to take it —
 * reading committed state through its own transactor, never trusting the announcement for anything but
 * where to look. It also keeps what a read brought here when this node is responsible for it ("Readers
 * repair"), and restarts the pulls a restart interrupted.
 *
 * Imports here are pure or type-only: this module is reachable from the react-native entry (`src/rn.ts`).
 */

import { peerIdFromString } from '@libp2p/peer-id';
import { routingKeyForBlob, type BlobRef, type BlobScope, type BlobStat, type IKeyNetwork } from '@optimystic/db-core';
import { createLogger } from '../logger.js';
import { admittedBy, type NetworkMembershipGate } from '../network-membership-gate.js';
import { armUnrefTimer } from '../unref-timer.js';
import { READ_ABANDONED, type AnnounceLimiter } from './announce-limiter.js';
import type { BlobFetcher } from './blob-fetcher.js';
import type { BlobAnnounceAnswer } from './blob-protocol.js';
import type { BlobProtocolClient } from './blob-protocol-client.js';
import type { LocalBlobService } from './local-blob-service.js';
import type { BlobReferenceCheck, ReferenceVerdict } from './reference-check.js';

const log = createLogger('blob:protocol');

/** Whether this node takes blobs it is merely responsible for (docs/blobs.md §Placement, copying and durability). */
export type BlobHoldPolicy = 'eager' | 'on-demand';

export interface BlobAnnounceReceiverDeps {
	selfId: string;
	hold: BlobHoldPolicy;
	keyNetwork: Pick<IKeyNetwork, 'findCluster'>;
	membership?: NetworkMembershipGate;
	limiter: AnnounceLimiter;
	references: Pick<BlobReferenceCheck, 'inScope' | 'anywhere'>;
	local: Pick<LocalBlobService, 'stat' | 'holdResponsible' | 'responsibleScope' | 'responsibleRefs'>;
	fetcher: Pick<BlobFetcher, 'start'>;
	client: Pick<BlobProtocolClient, 'held'>;
	/** How long `decide` may spend reading committed state before it answers `unreferenced`: half the node's `responseTimeoutMs`. */
	answerWithinMs: number;
	/** Default Date.now. */
	now?: () => number;
	/** Default armUnrefTimer. */
	setTimer?: (fn: () => void, ms: number) => () => void;
}

/**
 * A reference read that did not answer inside the budget, in place of a verdict: `started` says whether
 * it had begun (and so still holds its read slot) or was still queued and was dropped unrun.
 */
interface RanLate {
	readonly ranLate: true;
	readonly started: boolean;
}

/**
 * One node's answer to the announcements it receives. The decision is made from committed state and
 * this node's own view of the blob's cohort; the announcement contributes a scope to look in and a
 * peer to ask for pieces first.
 */
export class BlobAnnounceReceiver {
	private readonly deps: BlobAnnounceReceiverDeps;
	private readonly now: () => number;
	private readonly setTimer: (fn: () => void, ms: number) => () => void;
	/** One pull per reference, with the announcers awaiting its `held`. */
	private readonly inFlight = new Map<BlobRef, Set<string>>();
	/** References whose reader repair is running, so a second read starts no second repair. */
	private readonly repairing = new Set<BlobRef>();
	private stopped = false;

	constructor(deps: BlobAnnounceReceiverDeps) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
		this.setTimer = deps.setTimer ?? armUnrefTimer;
	}

	/**
	 * The answer to one `announce`. Rejects only on a local store fault writing the hold, which
	 * `BlobProtocolService` turns into a reset stream: the announcer sees it and asks again.
	 */
	async decide(announcer: string, ref: BlobRef, scope: BlobScope): Promise<BlobAnnounceAnswer> {
		const startedAt = this.now();
		const answer = await this.decided(announcer, ref, scope, startedAt);
		log('announce:answer peer=%s ref=%s answer=%s ms=%d', announcer, ref, answer, this.now() - startedAt);
		return answer;
	}

	/**
	 * Keeps a blob a read brought here under a `responsible` hold when this node is in its cohort and
	 * committed state references it (docs/blobs.md §Placement, copying and durability, "Readers
	 * repair"). Fire and forget: it returns at once and never throws.
	 */
	keepAfterRead(ref: BlobRef): void {
		if (this.deps.hold === 'on-demand' || this.repairing.has(ref)) {
			return;
		}
		this.repairing.add(ref);
		void this.repair(ref).finally(() => this.repairing.delete(ref));
	}

	/**
	 * Restarts the pull of every blob this node holds `responsible` that is not whole here: the hold is
	 * flushed before `fetching` is answered, so this is what finishes a pull a restart interrupted. The
	 * fetcher asks only for the pieces that are still missing.
	 */
	async resume(): Promise<void> {
		// A node reconfigured to `on-demand` keeps the holds it took as an eager one, but takes no more
		// and pulls nothing: resuming would be the one thing an on-demand node must not do.
		if (this.deps.hold === 'on-demand') {
			return;
		}
		// NOTE: every interrupted pull is started at once. The fetcher's background `get` slots bound the
		// streams, not the number of live sessions, so a node that crashed with thousands of pulls open
		// walks thousands of local trees at once on its way up. If that is ever seen, start them in
		// batches of the fetcher's slot count.
		for (const ref of await this.deps.local.responsibleRefs()) {
			if (await this.localityOf(ref) !== 'here') {
				this.startPull(ref, undefined);
			}
		}
	}

	/** Marks the receiver stopped: a pull that ends after this sends no `held` and is logged as stopped. */
	stop(): void {
		this.stopped = true;
	}

	/** The decision, in the order docs/blobs.md §Who may fetch and who may store sets out: nothing is read before it must be. */
	private async decided(announcer: string, ref: BlobRef, scope: BlobScope, startedAt: number): Promise<BlobAnnounceAnswer> {
		if (this.deps.hold === 'on-demand') {
			return 'declined';
		}
		// The inbound stream gate, when configured, refused a non-member before a frame was read; this
		// covers a node given only a membership predicate.
		if (!admittedBy(this.deps.membership, announcer)) {
			log('announce:refused-peer peer=%s ref=%s', announcer, ref);
			return 'unreferenced';
		}
		if (!await this.inCohort(ref)) {
			return 'not-responsible';
		}
		// After the cohort check on purpose: an honest peer whose cohort view differs from ours spends no allowance.
		if (!this.deps.limiter.admit(announcer)) {
			log('announce:limited peer=%s ref=%s', announcer, ref);
			return 'unreferenced';
		}
		const verdict = await this.referenced(ref, scope, startedAt);
		if ('ranLate' in verdict) {
			log('announce:read-slow peer=%s ref=%s ms=%d started=%s', announcer, ref, this.now() - startedAt, verdict.started);
			return 'unreferenced';
		}
		if (verdict.kind !== 'listed') {
			return 'unreferenced';
		}
		// Written and flushed before the answer, so a restart after `fetching` keeps the hold and `resume`
		// finishes the pull. The fetch's own `cached` hold is left beside it (docs/blobs.md §Holds).
		await this.deps.local.holdResponsible(ref, scope);
		if (await this.localityOf(ref) === 'here') {
			return 'whole';
		}
		this.startPull(ref, announcer);
		return 'fetching';
	}

	/**
	 * Whether committed state lists `ref` in `scope`, read under the node's shared read limit and raced
	 * against what is left of the answer budget. The budget runs from the start of `decide`, so waiting
	 * for a read slot counts: both ends of the exchange abort a stream that moves no bytes for one
	 * response timeout, and nothing moves while this reads.
	 *
	 * A read that has STARTED and runs late keeps its slot until it finishes (so slow reads still bound
	 * the node's read work) and its answer is discarded. A read still waiting its turn when the budget
	 * runs out is abandoned unrun, so announcements arriving faster than reads finish cannot pile up
	 * reads for answers that have already been sent.
	 *
	 * `unreferenced` is also what the announcer gets for a read that could not be trusted, and its drain
	 * asks again either way.
	 */
	private async referenced(ref: BlobRef, scope: BlobScope, startedAt: number): Promise<ReferenceVerdict | RanLate> {
		let started = false;
		const budget = new AbortController();
		const read = this.deps.limiter
			.readSlot(() => {
				started = true;
				return this.deps.references.inScope(ref, scope);
			}, budget.signal)
			.then((answer): ReferenceVerdict | RanLate => answer === READ_ABANDONED ? { ranLate: true, started } : answer)
			.catch((error: unknown): ReferenceVerdict => {
				// `BlobReferenceCheck` answers an unreadable tree as uncertain rather than throwing, so this
				// is a fault it does not model; absence is not established either way.
				log.error('announce:read-failed ref=%s scope=%s err=%s', ref, scope, describe(error));
				return { kind: 'uncertain', reason: describe(error) };
			});
		let cancelTimer: (() => void) | undefined;
		const ranLate = new Promise<RanLate>(resolve => {
			const left = Math.max(0, this.deps.answerWithinMs - (this.now() - startedAt));
			cancelTimer = this.setTimer(() => {
				budget.abort();
				resolve({ ranLate: true, started });
			}, left);
		});
		try {
			return await Promise.race([read, ranLate]);
		} finally {
			cancelTimer?.();
		}
	}

	/** Whether this node's own view of the blob's cohort includes it; a lookup that throws leaves responsibility undetermined, which the announcer asks about again. */
	private async inCohort(ref: BlobRef): Promise<boolean> {
		try {
			return Object.keys(await this.deps.keyNetwork.findCluster(routingKeyForBlob(ref))).includes(this.deps.selfId);
		} catch (error) {
			log('announce:cohort-unresolved ref=%s err=%s', ref, describe(error));
			return false;
		}
	}

	/**
	 * What this node holds of the blob, with a local tree too malformed to walk read as `unknown`: the
	 * pull that follows walks the same tree and reports the fault as `fetch:gave-up`, so the answer is
	 * `fetching` rather than a reset stream over a store fault the announcer can do nothing about.
	 */
	private async localityOf(ref: BlobRef): Promise<BlobStat['locality']> {
		try {
			return (await this.deps.local.stat(ref)).locality;
		} catch (error) {
			log('announce:stat-failed ref=%s err=%s', ref, describe(error));
			return 'unknown';
		}
	}

	/**
	 * Starts the pull of `ref`, or joins the one running and notes `announcer` as awaiting its `held`.
	 *
	 * A second announcer joining a pull in flight is not added to that session's candidates (a session
	 * fixes its `knownHolders` at the start); if the first session gives up, that announcer's next
	 * announcement starts a fresh pull with it first. No `waitMs`: a pull fails after one round that
	 * leaves a piece unavailable, and the announcer's own drain re-announces.
	 */
	private startPull(ref: BlobRef, announcer: string | undefined): void {
		const awaiting = this.inFlight.get(ref);
		if (awaiting !== undefined) {
			if (announcer !== undefined) {
				awaiting.add(announcer);
			}
			return;
		}
		// The announcer may be a writer outside the cohort and the blob's only holder, which is why it is
		// named as a known holder; the fetcher still filters it like every other candidate.
		const session = this.deps.fetcher.start(ref, { priority: 'background', knownHolders: announcer === undefined ? [] : [announcer] });
		const waiting = new Set(announcer === undefined ? [] : [announcer]);
		this.inFlight.set(ref, waiting);
		void session.done.then(
			() => this.pullResolved(ref, waiting),
			(error: unknown) => this.pullRejected(ref, error),
		);
	}

	/** The fetch session already recorded the blob as whole; this tells the announcers that were waiting. */
	private pullResolved(ref: BlobRef, awaiting: ReadonlySet<string>): void {
		this.inFlight.delete(ref);
		if (this.stopped) {
			log('fetch:stopped ref=%s', ref);
			return;
		}
		for (const peer of awaiting) {
			if (admittedBy(this.deps.membership, peer)) {
				void this.sendHeld(ref, peer);
			}
		}
	}

	/** The hold is kept: the next announcement for the reference starts a fresh pull. */
	private pullRejected(ref: BlobRef, error: unknown): void {
		this.inFlight.delete(ref);
		if (this.stopped) {
			log('fetch:stopped ref=%s', ref);
			return;
		}
		log('fetch:gave-up ref=%s err=%s', ref, describe(error));
	}

	/** Never rejects: a `held` that does not arrive is not retried, since the announcer's drain re-announces and is then answered `whole`. */
	private async sendHeld(ref: BlobRef, peer: string): Promise<void> {
		try {
			await this.deps.client.held(peerIdFromString(peer), ref);
		} catch (error) {
			log('held:send-failed peer=%s ref=%s err=%s', peer, ref, describe(error));
		}
	}

	/** Reader repair, as `keepAfterRead` promises: never throws. */
	private async repair(ref: BlobRef): Promise<void> {
		try {
			if (!await this.inCohort(ref)) {
				return;
			}
			if (await this.deps.local.responsibleScope(ref) !== undefined) {
				return;	// already responsible: nothing to verify and nothing to write
			}
			// Under the shared read limit but against no per-peer allowance: this node asked itself.
			const verdict = await this.deps.limiter.readSlot(() => this.deps.references.anywhere(ref));
			if (verdict.kind !== 'listed') {
				return;	// the fetch's `cached` hold is left exactly as it is
			}
			await this.deps.local.holdResponsible(ref, verdict.scope);
			log('read:kept-responsible ref=%s scope=%s', ref, verdict.scope);
		} catch (error) {
			log.error('read:keep-failed ref=%s err=%s', ref, describe(error));
		}
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
