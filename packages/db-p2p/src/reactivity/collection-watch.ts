/**
 * Reactivity — node-level collection watch service (`docs/reactivity.md` §Subscription, §Tail rotation).
 *
 * The one call an application makes to be woken when a collection changes anywhere on the network:
 * {@link ReactivityCollectionWatch.watch}. Behind it the service builds a
 * {@link ReactivitySubscriptionManager} under the collection's current log tail, routes socket-delivered
 * notifications to it through the node's {@link ReactivitySubscriberRegistry}, keeps the cohort registration
 * renewed, and moves the subscription when the log starts a new tail block.
 *
 * **One subscription per collection.** Every watch of one collection on this node shares one subscription,
 * which closes with its last handle. Sharing is also what keeps the node's rotation scheduler correct: it
 * de-duplicates by successor topic, and two subscriptions of one collection would share successor topics.
 *
 * **Nothing here is trusted to arrive.** A notification can be lost, a registration can fail, a tail can
 * move with nobody told (a subscriber registered under the old tail's topic is not sent the new tail's
 * notifications), and a commit may never be announced at all. So each subscription also runs a tick, at the
 * renewal cadence, that reads the collection's committed tail and compares it with what it last saw (see
 * {@link ReactivityCollectionWatch.tick}). Every failure above then costs at most one tick of delay.
 *
 * **What a watcher is promised.** Open the watch before the read it is meant to keep fresh: a commit that
 * read did not see wakes the watcher. The service cannot know what a caller has read, so the first committed
 * tail it reads for a collection wakes that collection's watchers once, whether or not anything changed.
 *
 * **Work on one subscription is serial.** The first attach, each tick, each escalation's re-read and each
 * scheduled move run one at a time per subscription, so two moves never interleave. Delivery is not part of
 * that queue: a notification reaches {@link CollectionWatchRequest.onChange} while a move is in flight.
 */

import {
	bytesToB64url,
	pingIntervalMs,
	reactivityTopicId,
	subscriberTtlForProfile,
	type BlockId,
	type CohortTopicService,
	type NodeProfile,
	type NotificationV1,
	type ReRegistrationPlan,
	type StickyCohortHintCache,
} from "@optimystic/db-core";
import { ReactivitySubscriptionManager, type RotationNotice } from "./subscription-manager.js";
import { setUnrefTimer, type RotationTimerCancel } from "./rotation-rereg-scheduler.js";
import { reactivityCollectionIdBytes, reactivityTailBytes } from "./topic-bytes.js";
import type { ReactivitySubscriberRegistry } from "./subscriber-registry.js";
import type { Libp2pReactivityRecoverTransport, RecoverRequestSigners } from "./recover-transport.js";
import { createLogger } from "../logger.js";

const log = createLogger("reactivity-collection-watch");

/** What a watcher knows about a collection's committed log: the tail block and the latest revision. */
export interface CollectionTail {
	readonly tailId: BlockId;
	readonly revision: number;
}

/** One watch of one collection. */
export interface CollectionWatchRequest {
	/** The collection id exactly as blocks carry it (`header.collectionId`, e.g. `app/users`). */
	readonly collectionId: string;
	/**
	 * Read the collection's committed tail now; `undefined` when the collection has never committed.
	 * `knownTailId` is the tail block the service's previous read found, for a reader that reads in one
	 * request when told it (`Collection.readCommittedTail` takes it as its third argument).
	 */
	readonly readTail: (knownTailId?: BlockId) => Promise<CollectionTail | undefined>;
	/**
	 * Called once per detected change, and once when the service first reads a committed tail for the
	 * collection (see the module doc). Coarse: no payload, never awaited, a throw is logged.
	 */
	readonly onChange: () => void;
}

/** A live watch. {@link close} is idempotent; the shared subscription closes with its last handle. */
export interface CollectionWatchHandle {
	close(): Promise<void>;
}

/** Construction inputs for a {@link ReactivityCollectionWatch}. */
export interface ReactivityCollectionWatchOptions {
	/** Participant-facing cohort-topic substrate API (register / renew / withdraw). */
	readonly service: CohortTopicService;
	/** The node's profile: sets the registration TTL, and so the tick interval (TTL / 3). */
	readonly profile: NodeProfile;
	/** The node's `topicId → handlers` table socket-delivered notifications are routed through. */
	readonly subscribers: ReactivitySubscriberRegistry;
	/**
	 * Arm the jittered timer for a rotation a manager surfaced; the node binds the rotation scheduler's
	 * `schedule`. When the timer fires the scheduler calls {@link ReactivityCollectionWatch.reRegister}.
	 */
	readonly scheduleRotation: (notice: RotationNotice) => void;
	/** Recover RPC transport + request signers. Both or neither; absent ⇒ a gap is recovered by the tick alone. */
	readonly recover?: Pick<Libp2pReactivityRecoverTransport, "backfillTransport" | "resumeTransport">;
	readonly recoverSigners?: RecoverRequestSigners;
	/** The node's sticky cohort-hint cache, shared with the recover transport so both see one cache. */
	readonly cohortHintCache?: StickyCohortHintCache;
	/** The coordinate this node registers under at the cohort-topic tier, base64url (signed into a resume). */
	readonly subscriberCoord?: string;
	/** Schedule a one-shot timer; returns a cancel handle. Defaults to an **unref'd** `setTimeout`. */
	readonly setTimer?: (fn: () => void, delayMs: number) => RotationTimerCancel;
	/** Clock (Unix ms) handed to each manager. Defaults to `Date.now`. */
	readonly now?: () => number;
}

/** One watcher of a collection: its change callback and its way to read the committed tail. */
type Listener = Pick<CollectionWatchRequest, "readTail" | "onChange">;

/** A manager under one tail's topic, with the registry entry that routes that topic's notifications to it. */
interface Attachment {
	readonly topicKey: string;
	readonly manager: ReactivitySubscriptionManager;
	readonly unregisterHandler: () => void;
}

/** The one subscription all of this node's watchers of a collection share. */
interface Subscription {
	readonly collectionId: string;
	readonly collectionIdBytes: Uint8Array;
	readonly listeners: Set<Listener>;
	/** The attachment the cohort holds a registration for, which renewals go to; absent until one succeeds. */
	attached?: Attachment;
	/** An attachment whose registration is in flight; its handler is already routing notifications. */
	arriving?: Attachment;
	/** Highest revision the listeners have been woken for; `0` until a committed tail has been read. */
	lastSeenRevision: number;
	/** The tail block the last successful tail read found, handed back to the next read. */
	lastTailId?: BlockId;
	closed: boolean;
	cancelTick?: RotationTimerCancel;
	/** Tail of the serial work queue. */
	work: Promise<void>;
	/** A re-read is queued and has not started; a second escalation need not queue another. */
	reAnchorQueued: boolean;
}

/** The node's collection watch service. See the module doc. */
export class ReactivityCollectionWatch {
	private readonly options: ReactivityCollectionWatchOptions;
	private readonly setTimer: (fn: () => void, delayMs: number) => RotationTimerCancel;
	private readonly now: () => number;
	private readonly tickIntervalMs: number;

	private readonly subscriptions = new Map<string, Subscription>();
	/** Successor topic (base64url) → the subscription a scheduled rotation timer will move there. */
	private readonly rotationTargets = new Map<string, Subscription>();
	private stopped = false;

	constructor(options: ReactivityCollectionWatchOptions) {
		this.options = options;
		this.setTimer = options.setTimer ?? setUnrefTimer;
		this.now = options.now ?? ((): number => Date.now());
		this.tickIntervalMs = pingIntervalMs(subscriberTtlForProfile(options.profile));
	}

	/** Collections with a live subscription. Diagnostic / test seam. */
	get watchedCount(): number {
		return this.subscriptions.size;
	}

	/** Whether `collectionId`'s subscription holds a cohort registration right now. Diagnostic / test seam. */
	isAttached(collectionId: string): boolean {
		return this.subscriptions.get(collectionId)?.attached !== undefined;
	}

	/**
	 * Watch a collection. Returns at once and never throws for network reasons: reading the tail, registering
	 * with the cohort and everything after run in the background, and a failure there is retried by the tick.
	 * The caller opens the watch first and reads afterwards (see the module doc). After {@link stop} the
	 * returned handle is inert.
	 */
	watch(req: CollectionWatchRequest): CollectionWatchHandle {
		if (this.stopped) {
			log("watch of collection=%s refused: the service has stopped", req.collectionId);
			return { close: (): Promise<void> => Promise.resolve() };
		}
		const listener: Listener = { readTail: req.readTail, onChange: req.onChange };
		const existing = this.subscriptions.get(req.collectionId);
		const sub = existing ?? this.openSubscription(req.collectionId);
		sub.listeners.add(listener);
		if (existing === undefined) {
			void this.enqueue(sub, () => this.checkTail(sub));
			this.armTick(sub);
		}
		return {
			close: (): Promise<void> => {
				// A handle closed twice, or after stop(), finds its listener already gone.
				if (sub.listeners.delete(listener) && sub.listeners.size === 0) {
					this.closeSubscription(sub);
				}
				return Promise.resolve();
			},
		};
	}

	/**
	 * The rotation scheduler's move: its timer for the successor topic `plan.newTopicId` fired. A successor
	 * no subscription is waiting on (it closed meanwhile) is a logged no-op.
	 *
	 * NOTE: a timer for a successor the log has already left (OLD→A→B inside the re-registration jitter, the
	 * tick having moved the subscription to B) moves it back to A; the tail read that follows the move returns
	 * it to B, at the cost of two registrations. If rotations ever come that fast, drop a plan whose
	 * subscription is no longer attached under the manager that surfaced it.
	 */
	reRegister(plan: ReRegistrationPlan): Promise<void> {
		const topicKey = bytesToB64url(plan.newTopicId);
		const sub = this.rotationTargets.get(topicKey);
		this.rotationTargets.delete(topicKey);
		if (sub === undefined || sub.closed) {
			log("rotation re-registration fired for successor topic=%s but no open subscription is waiting on it", topicKey);
			return Promise.resolve();
		}
		return this.enqueue(sub, () => this.moveThenRecheck(sub, plan.newTailId, plan.lastRevision));
	}

	/** Node teardown: close every subscription and refuse new watches. No tick fires afterwards. */
	stop(): Promise<void> {
		this.stopped = true;
		for (const sub of [...this.subscriptions.values()]) {
			this.closeSubscription(sub);
		}
		return Promise.resolve();
	}

	private openSubscription(collectionId: string): Subscription {
		const sub: Subscription = {
			collectionId,
			collectionIdBytes: reactivityCollectionIdBytes(collectionId),
			listeners: new Set(),
			lastSeenRevision: 0,
			closed: false,
			work: Promise.resolve(),
			reAnchorQueued: false,
		};
		this.subscriptions.set(collectionId, sub);
		return sub;
	}

	/**
	 * Release everything a subscription holds locally and tell the cohort. Synchronous, so a close during an
	 * in-flight registration leaves no handler routing notifications; {@link moveTo} withdraws that
	 * registration when it lands.
	 */
	private closeSubscription(sub: Subscription): void {
		if (sub.closed) {
			return;
		}
		sub.closed = true;
		sub.cancelTick?.();
		this.subscriptions.delete(sub.collectionId);
		for (const [topicKey, target] of this.rotationTargets) {
			if (target === sub) {
				this.rotationTargets.delete(topicKey);
			}
		}
		sub.listeners.clear();
		sub.arriving?.unregisterHandler();
		if (sub.attached !== undefined) {
			sub.attached.unregisterHandler();
			this.withdraw(sub, sub.attached.manager);
			sub.attached = undefined;
		}
	}

	/**
	 * Run `step` after this subscription's earlier work. A closed subscription runs nothing; a throw is logged.
	 *
	 * NOTE: a step that never settles stalls everything queued behind it, the tick's tail check included. The
	 * calls a step awaits are bounded today: the register walk and the renewal ping by libp2p's dial and
	 * stream timeouts, a `Collection.readCommittedTail` reader by the transactor's read deadlines. If a host
	 * ever passes a `readTail` with no deadline of its own, bound it here.
	 */
	private enqueue(sub: Subscription, step: () => Promise<void>): Promise<void> {
		const run = sub.work.then(async () => {
			if (sub.closed) {
				return;
			}
			try {
				await step();
			} catch (err) {
				log("background work failed for collection=%s (retried by the next tick): %o", sub.collectionId, err);
			}
		});
		sub.work = run;
		return run;
	}

	private armTick(sub: Subscription): void {
		// NOTE: every tick reads the collection's tail, whether or not anything changed: one read per watched
		// collection per tick (30 s Core, 20 s Edge), which is one request for a reader that hands
		// `Collection.readCommittedTail` the tail id `readTail` is given and two otherwise. If that shows up in traffic,
		// lengthen the interval the read runs at (keeping renewal at TTL / 3), or skip the read on a tick since
		// which a notification arrived.
		sub.cancelTick = this.setTimer(() => {
			void this.enqueue(sub, () => this.tick(sub)).then(() => {
				if (!sub.closed) {
					this.armTick(sub);
				}
			});
		}, this.tickIntervalMs);
	}

	/**
	 * Keep the registration alive, then check the collection's tail: wake the listeners if its revision is
	 * above the last one they were woken for, and attach to its topic if the subscription is not already
	 * there — which is also how a registration that failed is retried.
	 */
	private async tick(sub: Subscription): Promise<void> {
		await this.renew(sub);
		await this.checkTail(sub);
	}

	private async renew(sub: Subscription): Promise<void> {
		// NOTE: a renewal the cohort answers "unknown registration" resolves like any other, so a registration
		// the cohort has lost is not re-made until the tail moves, and until then the tick alone wakes the
		// watchers (backlog `bug-a-participant-told-its-registration-is-unknown-never-registers-again`).
		try {
			await sub.attached?.manager.renew();
		} catch (err) {
			log("renewal failed for collection=%s: %o", sub.collectionId, err);
		}
	}

	/**
	 * Read the tail, wake the listeners if it is news, and attach to its topic. A subscription's first read
	 * goes through here too and so wakes its listeners: a caller that read the collection before this read
	 * may have missed a commit this read can see, and nothing later would report that commit.
	 */
	private async checkTail(sub: Subscription): Promise<void> {
		const tail = await this.readTail(sub);
		if (tail === undefined) {
			return; // never committed, or unreadable right now: the next tick reads again
		}
		this.wakeIfNewer(sub, tail.revision);
		await this.moveThenRecheck(sub, reactivityTailBytes(tail.tailId), tail.revision);
	}

	/**
	 * Move to a tail's topic and, if a registration landed, look at the tail once more: a commit made while
	 * the registration was in flight was announced to a topic the cohort did not yet hold this subscriber
	 * under, so nothing else would report it before the next tick.
	 */
	private async moveThenRecheck(sub: Subscription, tailBytes: Uint8Array, lastRevision: number): Promise<void> {
		if (!(await this.moveTo(sub, tailBytes, lastRevision))) {
			return;
		}
		const tail = await this.readTail(sub);
		if (tail === undefined) {
			return;
		}
		this.wakeIfNewer(sub, tail.revision);
		await this.moveTo(sub, reactivityTailBytes(tail.tailId), tail.revision);
	}

	/** Any live listener's reader will do. A failed read is logged and reads as "no news". */
	private async readTail(sub: Subscription): Promise<CollectionTail | undefined> {
		const [listener] = sub.listeners;
		if (listener === undefined) {
			return undefined;
		}
		try {
			const tail = await listener.readTail(sub.lastTailId);
			if (sub.closed) {
				return undefined;
			}
			sub.lastTailId = tail?.tailId ?? sub.lastTailId;
			return tail;
		} catch (err) {
			log("tail read failed for collection=%s (no news this round): %o", sub.collectionId, err);
			return undefined;
		}
	}

	/**
	 * Put the subscription on the topic of the tail whose bytes are `tailBytes`, the first attach included.
	 * `lastRevision` is a revision known to be committed (read from the log, or delivered).
	 *
	 * The new topic's handler is registered before the cohort is asked to register the subscriber and before
	 * the old topic's handler is dropped, so a notification is routed to a manager at every moment of the
	 * move. A registration that fails removes the new handler and leaves the old attachment as it was.
	 *
	 * @returns true iff a registration landed (the subscription is now attached under the new topic).
	 */
	private async moveTo(sub: Subscription, tailBytes: Uint8Array, lastRevision: number): Promise<boolean> {
		const topicId = reactivityTopicId(tailBytes);
		const topicKey = bytesToB64url(topicId);
		const previous = sub.attached;
		if (previous?.topicKey === topicKey) {
			// Already there (a tick's re-anchor and a scheduled timer can both name one successor). The revision
			// is still news to the manager: without it, a gap the cohort could not backfill would re-request a
			// backfill on every later notification.
			previous.manager.rebaseline(lastRevision);
			return false;
		}
		const manager = this.buildManager(sub, tailBytes, topicId, Math.max(lastRevision, previous?.manager.lastRevision ?? 0));
		const arriving: Attachment = {
			topicKey,
			manager,
			unregisterHandler: this.options.subscribers.register(topicId, (n) => manager.onNotification(n)),
		};
		sub.arriving = arriving;
		try {
			await manager.register();
		} catch (err) {
			arriving.unregisterHandler();
			// NOTE: accepted tradeoff — a topic nobody has registered under before normally defers its first
			// registration (`CohortBackoffError`, "retry after 1000ms") while its members exchange the willingness
			// that admits one, so the first attach to each new tail lands on the next tick (30 s Core), not now.
			// Retrying on the cohort's delay was measured and is slower: retries at 1 s, 3 s and 7 s were all
			// deferred too, and the attach then landed at 60 s instead of 30 s. A cohort allows one peer four
			// register frames per topic per minute and a walk on a new topic sends two, so early retries spend
			// the allowance before the cohort is ready. Revisit if the cohort's answer starts naming a delay that
			// reflects when it will be ready (backlog
			// `feat-a-new-topic-admits-its-first-registration-without-a-second-ask`).
			log("registration under topic=%s failed for collection=%s (retried by the next tick): %o", topicKey, sub.collectionId, err);
			return false;
		} finally {
			sub.arriving = undefined;
		}
		if (sub.closed) {
			// The close already dropped the handler; the registration that just landed is all that is left.
			this.withdraw(sub, manager);
			return false;
		}
		sub.attached = arriving;
		if (previous !== undefined) {
			previous.unregisterHandler();
			this.withdraw(sub, previous.manager);
		}
		return true;
	}

	private buildManager(sub: Subscription, tailBytes: Uint8Array, topicId: Uint8Array, lastKnownRev: number): ReactivitySubscriptionManager {
		const { recover, recoverSigners } = this.options;
		const collectionIdB64 = bytesToB64url(sub.collectionIdBytes);
		// The manager could not replay what its listeners missed, so wake them, then find out where the log is.
		const wakeThenReAnchor = (): void => {
			this.notify(sub);
			this.reAnchor(sub);
		};
		return new ReactivitySubscriptionManager({
			service: this.options.service,
			collectionId: sub.collectionIdBytes,
			tailIdAtAttach: tailBytes,
			lastKnownRev,
			profile: this.options.profile,
			// A wake carries no payload, so there is nothing a delta would be used for.
			deltaMaxBytes: 0,
			cohortHintCache: this.options.cohortHintCache,
			subscriberCoord: this.options.subscriberCoord,
			clock: this.now,
			deliver: (n): void => this.onDelivered(sub, n),
			onRotation: (notice): void => this.onRotation(sub, notice),
			onChainRead: wakeThenReAnchor,
			onBackfillUnderflow: wakeThenReAnchor,
			onCheckpointDigest: wakeThenReAnchor,
			onTailRotated: (): void => this.reAnchor(sub),
			...(recover !== undefined && recoverSigners !== undefined
				? {
					backfillTransport: recover.backfillTransport(topicId, collectionIdB64),
					signBackfill: recoverSigners.signBackfill,
					resumeTransport: recover.resumeTransport(topicId, collectionIdB64),
					signResume: recoverSigners.signResume,
				}
				: {}),
		});
	}

	private onDelivered(sub: Subscription, n: NotificationV1): void {
		sub.lastSeenRevision = Math.max(sub.lastSeenRevision, n.revision);
		this.notify(sub);
	}

	private onRotation(sub: Subscription, notice: RotationNotice): void {
		if (sub.closed) {
			return;
		}
		this.rotationTargets.set(bytesToB64url(notice.plan.newTopicId), sub);
		this.options.scheduleRotation(notice);
	}

	/** Queue one re-read of the tail (wake if newer, move if it names another topic). */
	private reAnchor(sub: Subscription): void {
		if (sub.closed || sub.reAnchorQueued) {
			return;
		}
		sub.reAnchorQueued = true;
		void this.enqueue(sub, () => {
			sub.reAnchorQueued = false;
			return this.checkTail(sub);
		});
	}

	private wakeIfNewer(sub: Subscription, revision: number): void {
		if (revision > sub.lastSeenRevision) {
			sub.lastSeenRevision = revision;
			this.notify(sub);
		}
	}

	private notify(sub: Subscription): void {
		// Snapshot: a listener that closes its handle from inside onChange would otherwise mutate the live set.
		for (const listener of [...sub.listeners]) {
			try {
				listener.onChange();
			} catch (err) {
				log("onChange threw (isolated) for collection=%s: %o", sub.collectionId, err);
			}
		}
	}

	private withdraw(sub: Subscription, manager: ReactivitySubscriptionManager): void {
		void manager.withdraw().catch((err: unknown) => {
			log("withdraw failed for collection=%s (the cohort frees the registration when its TTL expires): %o", sub.collectionId, err);
		});
	}
}
