/**
 * The node's answer to the offline queue's question (docs/offline-sync.md §When to submit: the
 * reachability gate): can the machines responsible for these blocks be reached now, or is this node
 * genuinely alone?
 *
 * Read from the key network, never from the network itself: each block's cohort is the one
 * `findCluster` assembles now. A cohort naming another machine is reachable. A cohort naming only this
 * node is reachable only when this node is its whole cohort — it knows of no member that is missing
 * (`absentCohortMembers`), it is not waiting to hear from a bootstrap peer
 * (`awaitingBootstrapContact`), and no identify exchange is in flight. That last arm covers the moment
 * the other two cannot see: a peer mid-identify is out of every cohort (a new one is not yet
 * classified; a returning partner may show a partial protocol list that reads as foreign, see
 * `membershipOf` in `packages/db-p2p/src/libp2p-key-network.ts`), and a remembered partner then also
 * sits in FRET's band, where `absentCohortMembers` does not look.
 *
 * It also tells listeners when the answer may have improved: a connection opened, or a peer was
 * identified, debounced so the identify that follows a connection is coalesced with it.
 */
import type { BlockId, ICohortReachability, IKeyNetwork, RoutingKey } from '@optimystic/db-core';
import { routingKeyForBlock } from '@optimystic/db-core';
import { createLogger, type Logger } from '../logger.js';
import { armUnrefTimer } from '../unref-timer.js';

/** The node events after which a cohort view can have widened: a connection opened, or a peer was identified (FRET classifies on it). */
export type NetworkChangeEventType = 'connection:open' | 'peer:identify';

/** Where the gate hears {@link NetworkChangeEventType}s: a libp2p node, or any `EventTarget`. */
export interface NetworkChangeEvents {
	addEventListener(type: NetworkChangeEventType, listener: () => void): void;
	removeEventListener(type: NetworkChangeEventType, listener: () => void): void;
}

export interface CohortReachabilityDeps {
	keyNetwork: Pick<IKeyNetwork, 'findCluster' | 'absentCohortMembers' | 'awaitingBootstrapContact'>;
	/** This node, `PeerId.toString()`. */
	selfId: string;
	/** Identify exchanges in flight on this node (`IdentifyProgress.inFlight`); absent → none. */
	identifying?: () => number;
	/** Absent → {@link KeyNetworkCohortReachability.onChange} subscribes nothing and never wakes. */
	events?: NetworkChangeEvents;
	/** How long after the last network event the listeners are woken; default {@link DEFAULT_WAKE_DEBOUNCE_MS}. */
	wakeDebounceMs?: number;
}

/**
 * The drain's debounce mechanism at a tenth of its 5 s: a drain pass pushes block copies, a wake
 * costs one gate check. Long enough to coalesce `connection:open` with the `peer:identify` that
 * follows it, after which FRET has classified the peer.
 */
export const DEFAULT_WAKE_DEBOUNCE_MS = 500;

/** Why the gate reads a block's cohort unreachable. */
export type UnreachableReason =
	/** `findCluster` (or a self-only arm's lookup) threw. */
	| 'lookup-failed'
	/** No member at all, self included: this node serves nothing near the key, or the lookup found nobody. */
	| 'no-cohort'
	/** Self-only, but a serving member this node remembers belongs in the cohort. */
	| 'absent-members'
	/** Self-only, but a configured bootstrap peer has not been heard from. */
	| 'awaiting-bootstrap'
	/** Self-only, but an identify exchange is in flight, so the view may be about to widen. */
	| 'identifying';

type BlockVerdict = { readonly open: true } | { readonly open: false; readonly reason: UnreachableReason; readonly blockId: BlockId };

const OPEN: BlockVerdict = { open: true };

/** The gate a node exposes: `onChange` is always present. */
export type NodeCohortReachability = ICohortReachability & Required<Pick<ICohortReachability, 'onChange'>>;

export class KeyNetworkCohortReachability implements NodeCohortReachability {
	private readonly log: Logger;
	private readonly wakeDebounceMs: number;
	/** One entry per `onChange` call, so a listener subscribed twice is two subscriptions. */
	private readonly listeners = new Set<{ readonly listener: () => void }>();
	private readonly onNetworkChange = (): void => this.scheduleWake();
	/** The event source while subscribed to it: from the first listener until the last unsubscribes, or {@link stop}. */
	private subscribedTo: NetworkChangeEvents | undefined;
	private cancelWake: (() => void) | undefined;
	private stopped = false;
	/** The previous call's answer, so the log marks each change rather than each call. */
	private lastAnswer: boolean | undefined;

	constructor(private readonly deps: CohortReachabilityDeps) {
		this.log = createLogger('cohort-reachability', deps.selfId);
		this.wakeDebounceMs = deps.wakeDebounceMs ?? DEFAULT_WAKE_DEBOUNCE_MS;
	}

	/**
	 * True when every distinct block's cohort is reachable or this node is alone in it: a collection's
	 * header and its log tail may resolve to different cohorts, and both must pass. Never throws.
	 *
	 * NOTE: after a restart with persisted network state a partner restored into FRET's table reads
	 * `serves` and sits in the cohort, so this answers reachable while the partner is in fact offline,
	 * until FRET's liveness drops it (then `absent-members`). Harmless: the submission runs on a cohort
	 * of two, fails on a promise shortfall and the queue waits — the cohort is not solo, so no lone
	 * commit is possible.
	 */
	async reachable(blockIds: readonly BlockId[]): Promise<boolean> {
		const verdicts = await Promise.all([...new Set(blockIds)].map(blockId => this.judge(blockId)));
		const closed = verdicts.find(verdict => !verdict.open);
		this.noteAnswer(closed);
		return closed === undefined;
	}

	/**
	 * Call `listener`, debounced, after a connection opens or a peer is identified. The first listener
	 * subscribes to the node's events and the last unsubscribe releases them. After {@link stop} it
	 * subscribes nothing.
	 *
	 * NOTE: the debounce restarts on every event, so events arriving closer together than
	 * `wakeDebounceMs` postpone the wake for as long as they keep coming; the queue's own re-check
	 * timer still runs meanwhile. If a queue is ever seen waiting on a busy node whose cohort is
	 * reachable, fire at most one debounce interval after the first event of a burst.
	 */
	onChange(listener: () => void): () => void {
		if (this.stopped) return () => undefined;
		const subscription = { listener };
		this.listeners.add(subscription);
		this.subscribeEvents();
		return () => {
			if (this.listeners.delete(subscription) && this.listeners.size === 0) this.releaseEvents();
		};
	}

	/** Node teardown: drops every listener, removes the event listeners and clears the timer. */
	stop(): void {
		this.stopped = true;
		this.listeners.clear();
		this.releaseEvents();
	}

	private async judge(blockId: BlockId): Promise<BlockVerdict> {
		try {
			return await this.judgeCohort(blockId);
		} catch (err) {
			this.log('reachability:lookup-failed block=%s - %o', blockId, err);
			return { open: false, reason: 'lookup-failed', blockId };
		}
	}

	private async judgeCohort(blockId: BlockId): Promise<BlockVerdict> {
		const key = routingKeyForBlock(blockId);
		const cohort = Object.keys(await this.deps.keyNetwork.findCluster(key));
		// NOTE: FRET keeps a long-lived peer live for up to `maxDeadGraceMs` (5 min by default) after it
		// departs, so through that grace a gone partner still makes this arm answer reachable and the
		// drain meets shortfalls, with backoff. If drains are seen spinning on shortfalls during that
		// grace, also require a live connection to that member.
		if (cohort.some(peerId => peerId !== this.deps.selfId)) return OPEN;
		if (cohort.length === 0) return { open: false, reason: 'no-cohort', blockId };
		const reason = await this.whyNotAlone(key);
		return reason === undefined ? OPEN : { open: false, reason, blockId };
	}

	/** For a self-only view: what says it may not be the whole cohort, or `undefined` when this node is genuinely alone. */
	private async whyNotAlone(key: RoutingKey): Promise<UnreachableReason | undefined> {
		const absent = await this.deps.keyNetwork.absentCohortMembers?.(key) ?? [];
		if (absent.length > 0) return 'absent-members';
		if (await this.deps.keyNetwork.awaitingBootstrapContact?.() === true) return 'awaiting-bootstrap';
		if ((this.deps.identifying?.() ?? 0) > 0) return 'identifying';
		return undefined;
	}

	/** One line per change of answer: the queue asks on every re-check and a live read on every refresh. */
	private noteAnswer(closed: BlockVerdict | undefined): void {
		const answer = closed === undefined;
		if (answer === this.lastAnswer) return;
		this.lastAnswer = answer;
		if (closed !== undefined && !closed.open) this.log('reachability:closed reason=%s block=%s', closed.reason, closed.blockId);
		else this.log('reachability:open');
	}

	private subscribeEvents(): void {
		const events = this.deps.events;
		if (this.subscribedTo !== undefined || events === undefined) return;
		this.subscribedTo = events;
		events.addEventListener('connection:open', this.onNetworkChange);
		events.addEventListener('peer:identify', this.onNetworkChange);
	}

	private releaseEvents(): void {
		this.cancelWake?.();
		this.cancelWake = undefined;
		const events = this.subscribedTo;
		if (events === undefined) return;
		this.subscribedTo = undefined;
		events.removeEventListener('connection:open', this.onNetworkChange);
		events.removeEventListener('peer:identify', this.onNetworkChange);
	}

	/** Only reconnection-shaped events wake: a departure can only close the gate, which the asker's next re-check reads. */
	private scheduleWake(): void {
		this.cancelWake?.();
		this.cancelWake = armUnrefTimer(() => {
			this.cancelWake = undefined;
			this.wakeListeners();
		}, this.wakeDebounceMs);
	}

	private wakeListeners(): void {
		for (const { listener } of [...this.listeners]) {
			try {
				listener();
			} catch (err) {
				this.log.error('reachability:listener-threw - %o', err);
			}
		}
	}
}
