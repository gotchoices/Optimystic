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
import { hashKey } from 'p2p-fret';
import { createLogger } from '../logger.js';
import { isServingHolder } from '../storage/arachnode-partition.js';
import type { ArachnodeInfo } from '../storage/arachnode-fret-adapter.js';
import { admittedBy, type NetworkMembershipGate } from '../network-membership-gate.js';
import { armUnrefTimer } from '../unref-timer.js';
import { READ_ABANDONED, type AnnounceLimiter } from './announce-limiter.js';
import type { BlobFetcher } from './blob-fetcher.js';
import type { BlobAnnounceAnswer } from './blob-protocol.js';
import type { BlobProtocolClient } from './blob-protocol-client.js';
import type { LocalBlobService } from './local-blob-service.js';
import type { BlobReferenceCheck, ReferenceVerdict } from './reference-check.js';
import type { StoragePressure } from '../storage/storage-pressure.js';

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
	/**
	 * How full this node is (`packages/db-p2p/docs/storage.md` §10). Read by BOTH paths that would take
	 * a new `responsible` hold, so the two cannot disagree about whether this node takes one: a node at
	 * `refusing` answers an announcement `out-of-space` ({@link BlobAnnounceReceiver.decide}) and takes
	 * no hold on a blob its own read brought here ({@link BlobAnnounceReceiver.keepAfterRead}).
	 *
	 * Absent — a receiver built without a pressure reading — refuses nothing, which is also what a node
	 * that cannot measure itself does.
	 */
	storagePressure?: Pick<StoragePressure, 'refusingNewData'>;
	/**
	 * This node's own Arachnode advertisement, read fresh per decision
	 * (`ArachnodeFretAdapter.getMyArachnodeInfo`). The slice it names BOUNDS which blobs this node
	 * takes a `responsible` hold on: a blob outside it is answered `'not-responsible'`, and a blob a
	 * read brought here is not kept. Without that, a node that narrowed its ring and handed its
	 * outside-the-slice blobs over would be announced them again by the members that took them and
	 * pull every one straight back (`shedNarrowedBlobs` in
	 * `packages/db-p2p/src/blob/ring-shed-pass.ts` is the other half of this).
	 *
	 * Read through `isServingHolder`, so a node mid-shift still accepts for the range it is still
	 * serving and refuses nothing it has not yet handed over. Absent — no Arachnode, no FRET — or
	 * answering `undefined` means the whole keyspace, which is what ring 0 is.
	 */
	myArachnode?: () => ArachnodeInfo | undefined;
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
	 * Keeps a blob a read brought here under a `responsible` hold when this node is a responsible
	 * holder for it (in its cohort, and inside the slice this node serves), has room, and committed
	 * state references it (docs/blobs.md §Placement, copying and durability, "Readers repair"). Fire
	 * and forget: it returns at once and never throws.
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

	/** The decision, in the order docs/blobs.md §Who may fetch and who may store sets out: nothing is read before it must be, and the storage refusal sits above the one read this makes. */
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
		// NOTE: a node that has narrowed past this blob but not yet handed it over answers
		// `not-responsible` for one it still holds WHOLE and still serves, so the announcer stops
		// counting it as a holder before it has actually released — which makes a writer's durability
		// class conservative for as long as the handover takes, and permanently so where every member
		// has narrowed past the key (docs/arachnode-ring-handoff.md § Phase C states that outcome). The
		// safe direction: the writer keeps its own copy. If writers are ever seen holding owed copies
		// for this reason, answer `whole` for a blob already held whole before testing the slice — not
		// a new rule, just this check moved below the local `stat` it would then need.
		if (!await this.responsibleFor(ref)) {
			return 'not-responsible';
		}
		// After the cohort check on purpose: an honest peer whose cohort view differs from ours spends no allowance.
		if (!this.deps.limiter.admit(announcer)) {
			log('announce:limited peer=%s ref=%s', announcer, ref);
			return 'unreferenced';
		}
		// Before the reference read on purpose: that read is the expensive part of answering an
		// announcement — it holds one of the node's four reference-read slots — and a node that is not
		// going to take the blob either way should not spend a slot establishing that it is referenced.
		// Deliberately NOT a satisfying answer to the announcer (`SATISFYING_ANSWERS` in
		// `cohort-reaction.ts`): being full is a condition that clears, so the announcer asks again.
		if (this.deps.storagePressure?.refusingNewData() === true) {
			log('announce:out-of-space peer=%s ref=%s', announcer, ref);
			return 'out-of-space';
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

	/**
	 * Whether this node is a responsible holder for `ref`: the slice it serves covers the blob's
	 * routing key AND its own view of the blob's cohort includes it. Both halves are needed — the
	 * cohort is what assigns a blob to a node, the slice is what bounds how much of its cohorts' work
	 * a node keeps — and they are asked in that order because the slice is local arithmetic while the
	 * cohort costs a peer-store sweep.
	 */
	private async responsibleFor(ref: BlobRef): Promise<boolean> {
		return await this.servesSlice(ref) && await this.inCohort(ref);
	}

	/** Whether the slice this node serves covers `ref`; see {@link BlobAnnounceReceiverDeps.myArachnode}. */
	private async servesSlice(ref: BlobRef): Promise<boolean> {
		const info = this.deps.myArachnode?.();
		if (info === undefined) {
			return true;
		}
		const covers = isServingHolder(info, await hashKey(routingKeyForBlob(ref)));
		if (!covers) {
			log('announce:outside-slice ref=%s ring=%d', ref, info.ringDepth);
		}
		return covers;
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
			// The same responsibility test the announcement path makes, slice included: a node that
			// answers an announcement for this blob `not-responsible` must not re-adopt it because its
			// own read brought it here — that is how a shed blob comes straight back.
			if (!await this.responsibleFor(ref)) {
				return;
			}
			if (await this.deps.local.responsibleScope(ref) !== undefined) {
				return;	// already responsible: nothing to verify and nothing to write
			}
			// The same door the announcement path closes, and for the same reason: a `responsible` hold is a
			// promise to keep bytes the network's other copies may be released against, and a node that
			// refuses to take this very blob when a PEER offers it must not take it because it happened to
			// read it. It is also the one path that would make a full node fuller without writing a byte —
			// the hold moves bytes out of the read cache's reach, so the cache enforcement the same
			// `refusing` sample triggers could no longer free them. The fetch's `cached` hold is left exactly
			// as it is, so the blob is still served and still evictable. Before the reference read, as in
			// `decided`: a node that will not take the hold should spend no read slot proving it could.
			if (this.deps.storagePressure?.refusingNewData() === true) {
				log('read:out-of-space ref=%s (no responsible hold taken)', ref);
				return;
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
