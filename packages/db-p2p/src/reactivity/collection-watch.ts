/**
 * Reactivity — node-level collection watch service (`docs/reactivity.md` §Subscription, §Tail rotation).
 *
 * The one call an application makes to be woken when a collection changes anywhere on the network:
 * {@link ReactivityCollectionWatch.watch}. Behind it the service builds one
 * {@link ReactivitySubscriptionManager} for the collection, routes socket-delivered notifications to it
 * through the node's {@link ReactivitySubscriberRegistry} under the collection's topic, keeps the cohort
 * registration renewed, and has the manager follow the log's tail when it starts a new block.
 *
 * **One subscription per collection.** Every watch of one collection on this node shares one subscription
 * — one manager and one registry handler for its whole life, both created at its first attach and released
 * at close — which closes with its last handle. Sharing is also what keeps the node's rotation scheduler
 * correct: it de-duplicates by successor tail, and two subscriptions of one collection would share
 * successor tails.
 *
 * **A tail move is a follow, not a re-attach.** The collection's topic is stable, so the handler stays
 * registered where it is; the manager's `followTail` decides what the cohort needs: a registration at the
 * root registers again under the new root key, one below the root sends nothing and only updates the key a
 * re-walk would use.
 *
 * **Nothing here is trusted to arrive.** A notification can be lost, a registration can fail, a tail can
 * move with nobody told (a subscriber registered at the old root is not sent the new root's notifications),
 * and a commit may never be announced at all. So the service also runs a tick, at the renewal cadence, that
 * reads every watched collection's committed tail and compares each with what it last saw (see
 * {@link ReactivityCollectionWatch.tick}). Every failure above then costs at most one tick of delay, when the
 * machine answering the read holds the commit.
 *
 * **One tick, one read per reader.** The tick is one timer for the whole service, not one per collection, and
 * reads the tails of every collection that reads through one {@link CollectionTailReader} in one call, so a
 * host that shares one reader across its watches (the Quereus plugin shares one per transactor) pays one read
 * per tick while idle, however many collections it watches.
 *
 * **Most ticks read only what the answering machine holds.** A tick's read asks the answering repo not to
 * consult its cohort behind the read (`skipWindowConsult`), so on a node that stores the collections an idle
 * tick sends no read request at all. One read in every {@link ReactivityCollectionWatchOptions.verifyEveryTicks}
 * ticks per subscription is an ordinary one, whose consult is what repairs a copy that missed a commit nobody
 * announced; the reads the service makes on events (the first, the re-reads after an unservable gap and after a
 * registration lands) are ordinary reads too.
 *
 * **This node's own storage is heard directly.** Given {@link ReactivityCollectionWatchOptions.localChanges}, a
 * subscription wakes its listeners whenever a change to its collection lands in this node's storage — including a
 * revision a notification already woke them for, since on a node that stores the collection the notification
 * routinely arrives before the local apply, and a watcher that re-read its local copy on the notification saw the
 * old data. The feed only wakes; following the tail stays with the tick and the notifications.
 *
 * **What a watcher is promised.** Open the watch before the read it is meant to keep fresh: a commit that
 * read did not see wakes the watcher. The service cannot know what a caller has read, so the first committed
 * tail it reads for a collection wakes that collection's watchers once, whether or not anything changed, unless a
 * notification or a local landing has already woken them for that revision since the watch opened.
 *
 * **Work on one subscription is serial.** The first attach, the applying of each tick's read, each escalation's
 * re-read and each scheduled follow run one at a time per subscription, so two follows never interleave. The
 * tick's read itself runs outside that queue, beside every other subscription's, so its answer can be overtaken
 * by a read the queue issued later; such an answer is dropped (see {@link ReactivityCollectionWatch.acceptedTail}).
 * Delivery is not part of the queue either: a notification reaches {@link CollectionWatchRequest.onChange} while a
 * follow is in flight. Nor is renewal: each tick renews every registration in one `CohortTopicService.renewMany`
 * call, so the pings bound for one cohort member travel in one request. The service runs at most one renewal
 * cycle per registration and leaves alone a registration a follow displaced while its ping was out, so a renewal
 * beside a follow neither doubles up nor fails over the registration the follow replaced.
 */

import {
	bytesToB64url,
	Collection,
	pingIntervalMs,
	reactivityCollectionTopicId,
	subscriberTtlForProfile,
	type BlockId,
	type CohortTopicService,
	type CollectionChangeEvent,
	type CommittedTailReadOptions,
	type IBlockChangeNotifier,
	type ITransactor,
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

/** Default {@link ReactivityCollectionWatchOptions.verifyEveryTicks}: one consulting tail read in ten ticks. */
export const DEFAULT_VERIFY_EVERY_TICKS = 10;

/** The options of a tick's read that is not due for verification. */
const HELD_ONLY: CommittedTailReadOptions = { skipWindowConsult: true };

/** What a watcher knows about a collection's committed log: the tail block and the latest revision. */
export interface CollectionTail {
	readonly tailId: BlockId;
	readonly revision: number;
}

/** One collection a batched tail read names, with the tail block the service's previous read found. */
export interface CollectionTailQuery {
	readonly collectionId: string;
	readonly knownTailId?: BlockId;
}

/** One collection's answer: its tail (`undefined` when it has never committed), or why its read failed. */
export type CollectionTailAnswer =
	| { readonly tail: CollectionTail | undefined }
	| { readonly error: unknown };

/**
 * Reads several collections' committed tails together. Hosts pass ONE reader per transactor to every watch:
 * the service batches the tick's reads by reader identity, so a reader built per watch still works, at one
 * read per collection. {@link committedTailReader} is the reader a host needs.
 *
 * Answer every query, by its `collectionId`; a collection left out reads as "no news" for that read. A read
 * of one collection's tail failing should be that collection's `error`, not a rejection: a rejection is no
 * news for every collection the call named.
 *
 * `options.skipWindowConsult` asks the answering repos to answer from what they hold without starting the
 * background cohort consult (`BlockGets.skipWindowConsult`); the service sets it on most ticks. A reader that
 * ignores it stays correct, and keeps paying the consult.
 */
export interface CollectionTailReader {
	readTails(queries: ReadonlyArray<CollectionTailQuery>, options?: CommittedTailReadOptions): Promise<ReadonlyMap<string, CollectionTailAnswer>>;
}

/**
 * The {@link CollectionTailReader} a host needs: `Collection.readCommittedTails` over `transactor`, which opens no
 * collection handle, so it cannot replay a table's staged actions. Build one per transactor and pass that one
 * object to every watch through it.
 */
export function committedTailReader(transactor: ITransactor): CollectionTailReader {
	return {
		readTails: async (queries, options) => {
			const answers = await Collection.readCommittedTails(transactor,
				queries.map(({ collectionId, knownTailId }) => ({ id: collectionId, knownTailId })), options);
			return new Map([...answers].map(([id, answer]): [string, CollectionTailAnswer] =>
				[id, "error" in answer ? answer : { tail: answer.tail && { tailId: answer.tail.tailId, revision: answer.tail.rev } }]));
		},
	};
}

/** One watch of one collection. */
export interface CollectionWatchRequest {
	/** The collection id exactly as blocks carry it (`header.collectionId`, e.g. `app/users`). */
	readonly collectionId: string;
	/** How this watch's collection tail is read; shared across watches so the tick can read them together. */
	readonly tails: CollectionTailReader;
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
	/** Participant-facing cohort-topic substrate API (register / renew / moveRoot / withdraw). */
	readonly service: CohortTopicService;
	/** The node's profile: sets the registration TTL, and so the tick interval (TTL / 3). */
	readonly profile: NodeProfile;
	/** The node's `topicId → handlers` table socket-delivered notifications are routed through. */
	readonly subscribers: ReactivitySubscriberRegistry;
	/**
	 * The ratio the root group's commit certificates are signed under (the node's consensus
	 * `superMajorityThreshold`); each manager verifies notifications at `ceil(|root group| × quorumRatio)`.
	 */
	readonly quorumRatio: number;
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
	/**
	 * A tick's read of a subscription's tail consults the answering repo's cohort only when the subscription has
	 * gone this many ticks since such a read of it was last applied; every other tick reads what the answering repo
	 * holds. A positive integer; `1` consults on every tick. Defaults to {@link DEFAULT_VERIFY_EVERY_TICKS}.
	 */
	readonly verifyEveryTicks?: number;
	/**
	 * This node's own storage change feed (the node passes its `StorageRepo`). Each subscription listens for its
	 * collection while open and wakes its listeners on every change that lands here. Absent ⇒ the tick and the
	 * notifications alone wake them.
	 */
	readonly localChanges?: Pick<IBlockChangeNotifier, "onCollectionChange">;
}

/** One watcher of a collection: its change callback and its way to read the committed tail. */
type Listener = Pick<CollectionWatchRequest, "tails" | "onChange">;

/** The one subscription all of this node's watchers of a collection share. */
interface Subscription {
	readonly collectionId: string;
	readonly collectionIdBytes: Uint8Array;
	readonly listeners: Set<Listener>;
	/** The collection's one manager, built at the first attach; it follows the tail for the subscription's life. */
	manager?: ReactivitySubscriptionManager;
	/** Drops the manager's handler from the registry; registered under the collection's topic before the first register. */
	unregisterHandler?: () => void;
	/** Highest revision the listeners have been woken for; `0` until a committed tail has been read. */
	lastSeenRevision: number;
	/** The tail block the last applied tail read found, handed back to the next read. */
	lastTailId?: BlockId;
	/** Stamp of the newest tail read applied; an answer stamped below it is older and is dropped. */
	appliedReadStamp: number;
	/** A tick's answer is queued here and has not been applied; later ticks skip it (its renewal too) until it has. */
	tickQueued: boolean;
	/** Ticks that have read this subscription since a consulting read of it was last applied. */
	ticksSinceVerified: number;
	/** Stops listening to this node's storage for the collection; set while open when the node has a feed. */
	unsubscribeLocal?: () => void;
	closed: boolean;
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
	private readonly verifyEveryTicks: number;

	private readonly subscriptions = new Map<string, Subscription>();
	/**
	 * Successor tail (base64url of the plan's `newTailId`) → the subscription a scheduled rotation timer will move
	 * there. Keyed by tail, the key the scheduler de-duplicates by, because a topic outlives its tail.
	 */
	private readonly rotationTargets = new Map<string, Subscription>();
	/** The service's one tick timer: armed while any subscription is open and no tick is running. */
	private cancelTick?: RotationTimerCancel;
	private tickRunning = false;
	/** Issues each tail read's stamp, batched or single, in the order the reads are issued. */
	private readStamps = 0;
	private stopped = false;

	constructor(options: ReactivityCollectionWatchOptions) {
		this.options = options;
		this.setTimer = options.setTimer ?? setUnrefTimer;
		this.now = options.now ?? ((): number => Date.now());
		this.tickIntervalMs = pingIntervalMs(subscriberTtlForProfile(options.profile));
		this.verifyEveryTicks = options.verifyEveryTicks ?? DEFAULT_VERIFY_EVERY_TICKS;
		if (!Number.isInteger(this.verifyEveryTicks) || this.verifyEveryTicks < 1) {
			throw new RangeError(`verifyEveryTicks must be a positive integer, got ${this.verifyEveryTicks}`);
		}
	}

	/** Collections with a live subscription. Diagnostic / test seam. */
	get watchedCount(): number {
		return this.subscriptions.size;
	}

	/** Whether `collectionId`'s subscription holds a cohort registration right now. Diagnostic / test seam. */
	isAttached(collectionId: string): boolean {
		return this.subscriptions.get(collectionId)?.manager?.registration !== undefined;
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
		const listener: Listener = { tails: req.tails, onChange: req.onChange };
		const existing = this.subscriptions.get(req.collectionId);
		const sub = existing ?? this.openSubscription(req.collectionId);
		sub.listeners.add(listener);
		if (existing === undefined) {
			void this.enqueue(sub, () => this.checkTail(sub));
			this.armTick();
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
	 * The rotation scheduler's move: its timer for the successor tail `plan.newTailId` fired, so the
	 * subscription follows that tail. A successor no subscription is waiting on (it closed meanwhile) is a
	 * logged no-op.
	 *
	 * NOTE: a timer for a successor the log has already left (OLD→A→B inside the re-registration jitter, the
	 * tick having followed the subscription to B) moves a registration at the root back to A; the tail read
	 * that follows the move returns it to B, at the cost of two registrations (a registration below the root
	 * only has its root key set twice). If rotations ever come that fast, drop a plan whose tail is not the
	 * one the subscription's manager last followed.
	 */
	reRegister(plan: ReRegistrationPlan): Promise<void> {
		const tailKey = bytesToB64url(plan.newTailId);
		const sub = this.rotationTargets.get(tailKey);
		this.rotationTargets.delete(tailKey);
		if (sub === undefined || sub.closed) {
			log("rotation re-registration fired for successor tail=%s but no open subscription is waiting on it", tailKey);
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
		this.disarmTick();
		return Promise.resolve();
	}

	private openSubscription(collectionId: string): Subscription {
		const sub: Subscription = {
			collectionId,
			collectionIdBytes: reactivityCollectionIdBytes(collectionId),
			listeners: new Set(),
			lastSeenRevision: 0,
			appliedReadStamp: 0,
			tickQueued: false,
			// The first read (`checkTail`) consults, so the count starts there.
			ticksSinceVerified: 0,
			closed: false,
			work: Promise.resolve(),
			reAnchorQueued: false,
		};
		sub.unsubscribeLocal = this.options.localChanges?.onCollectionChange(collectionId, (event) => this.onLocalChange(sub, event));
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
		this.subscriptions.delete(sub.collectionId);
		if (this.subscriptions.size === 0) {
			this.disarmTick();
		}
		for (const [tailKey, target] of this.rotationTargets) {
			if (target === sub) {
				this.rotationTargets.delete(tailKey);
			}
		}
		sub.listeners.clear();
		sub.unsubscribeLocal?.();
		sub.unsubscribeLocal = undefined;
		sub.unregisterHandler?.();
		sub.unregisterHandler = undefined;
		if (sub.manager?.registration !== undefined) {
			this.withdraw(sub, sub.manager);
		}
	}

	/**
	 * Run `step` after this subscription's earlier work. A closed subscription runs nothing; a throw is logged.
	 *
	 * NOTE: a step that never settles stalls everything queued behind it, the applying of the tick's tail read
	 * included. The calls a step awaits are bounded today: the register walk and the renewal ping by libp2p's
	 * dial and stream timeouts, a `Collection.readCommittedTails` reader by the transactor's read deadlines. If a
	 * host ever passes a reader with no deadline of its own, bound it here and in {@link readGroup}.
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

	/**
	 * Arm the service's one tick, unless it is armed already, a tick is running (it re-arms when its reads
	 * settle), the service has stopped, or nothing is watched.
	 *
	 * NOTE: a tick costs one {@link CollectionTailReader.readTails} per reader, naming every collection that reads
	 * through it — one `transactor.get` while no tail moved — plus one renewal request per distinct primary the
	 * registrations ping (none for those whose primary is this node). On a node that holds the collections that read
	 * is local and, on all but one tick in {@link verifyEveryTicks}, sends nothing; the verifying tick's read starts
	 * one background consult request per cohort peer per 32 blocks (`MAX_CONSULT_BATCH_BLOCKS` in
	 * `protocol-limits.ts`) at two blocks per collection, so past 16 watched collections that consult takes a second
	 * request per peer. If hosts watch hundreds of collections, read only the tail blocks on the tick (a log that
	 * rolls over moves the old tail's revision and `nextId`, so the header is not needed to notice) to halve the
	 * blocks. The next tick also waits for every read of this one, so a reader whose read never settles stops the
	 * tick for every collection; the transactor's read deadlines bound that today.
	 */
	private armTick(): void {
		if (this.stopped || this.cancelTick !== undefined || this.tickRunning || this.subscriptions.size === 0) {
			return;
		}
		this.cancelTick = this.setTimer(() => {
			this.cancelTick = undefined;
			this.tickRunning = true;
			void this.tick().finally(() => {
				this.tickRunning = false;
				this.armTick();
			});
		}, this.tickIntervalMs);
	}

	private disarmTick(): void {
		this.cancelTick?.();
		this.cancelTick = undefined;
	}

	/**
	 * Keep every registration alive, then check every collection's tail: one read per reader, each answer applied on
	 * its subscription's queue — wake the listeners if the revision is above the last one they were woken for, and
	 * follow the tail if the registration is not where its root is, which is also how a registration that failed is
	 * retried. Settles when the reads have, not when the follows or the renewals have, so one subscription's slow
	 * registration walk does not hold back every other collection's next tick. A subscription whose earlier tick's
	 * answer is still queued sits this tick out, so a queue slower than the tick interval does not grow by a tick's
	 * steps each interval.
	 */
	private async tick(): Promise<void> {
		const groups = this.byReader([...this.subscriptions.values()].filter((sub) => !sub.tickQueued));
		const ticked = [...groups.values()].flat();
		for (const sub of ticked) {
			sub.tickQueued = true;
			sub.ticksSinceVerified++;
		}
		this.renewAll(ticked);
		await Promise.all([...groups].map(([reader, group]) => this.readGroup(reader, group)));
	}

	/** One renewal cycle for every registration `subs` hold, in one call, so pings to one cohort member share a request. Not awaited by the tick. */
	private renewAll(subs: ReadonlyArray<Subscription>): void {
		const handles = subs.flatMap((sub) => sub.manager?.registration ?? []);
		if (handles.length === 0) {
			return;
		}
		void this.options.service.renewMany(handles).catch((err: unknown) => {
			log("a renewal cycle failed this tick (of %d registration(s) renewed; the next tick renews again): %o", handles.length, err);
		});
	}

	/** `subs` grouped by the reader each reads through. */
	private byReader(subs: ReadonlyArray<Subscription>): Map<CollectionTailReader, Subscription[]> {
		const groups = new Map<CollectionTailReader, Subscription[]>();
		for (const sub of subs) {
			const reader = this.readerOf(sub);
			if (reader === undefined) {
				continue;
			}
			const group = groups.get(reader);
			if (group !== undefined) {
				group.push(sub);
			} else {
				groups.set(reader, [sub]);
			}
		}
		return groups;
	}

	/**
	 * The tick's one read of every tail in `group`, through the reader they share. A rejected read is no news for the
	 * whole group. The read consults the answering repos' cohorts when any subscription in the group is due for
	 * verification, and otherwise reads only what they hold.
	 */
	private async readGroup(reader: CollectionTailReader, group: ReadonlyArray<Subscription>): Promise<void> {
		const verified = group.some((sub) => sub.ticksSinceVerified >= this.verifyEveryTicks);
		const stamp = this.nextReadStamp();
		let answers: ReadonlyMap<string, CollectionTailAnswer> | undefined;
		try {
			answers = await reader.readTails(group.map((sub) => this.queryFor(sub)), verified ? undefined : HELD_ONLY);
		} catch (err) {
			log("tick tail read failed for %d collection(s) (no news this tick): %o", group.length, err);
		}
		for (const sub of group) {
			void this.enqueue(sub, async () => {
				sub.tickQueued = false;
				if (answers !== undefined) {
					await this.followAnswer(sub, stamp, answers.get(sub.collectionId), verified);
				}
			});
		}
	}

	/**
	 * Read the tail on its own, wake the listeners if it is news, and follow it. A subscription's first read goes
	 * through here too and so wakes its listeners: a caller that read the collection before this read may have missed
	 * a commit this read can see, and nothing later would report that commit.
	 */
	private async checkTail(sub: Subscription): Promise<void> {
		const tail = await this.readTail(sub);
		if (tail !== undefined) {
			await this.follow(sub, tail);
		}
	}

	/** Apply the answer a read stamped `stamp` found, as {@link acceptedTail} decides. */
	private async followAnswer(sub: Subscription, stamp: number, answer: CollectionTailAnswer | undefined, verified: boolean): Promise<void> {
		const tail = this.acceptedTail(sub, stamp, answer, verified);
		if (tail !== undefined) {
			await this.follow(sub, tail);
		}
	}

	private async follow(sub: Subscription, tail: CollectionTail): Promise<void> {
		this.wakeIfNewer(sub, tail.revision);
		await this.moveThenRecheck(sub, reactivityTailBytes(tail.tailId), tail.revision);
	}

	/**
	 * Follow a tail and, if a registration landed, look at the tail once more: a commit made while the
	 * registration was in flight was announced by a root that did not yet hold this subscriber, so nothing
	 * else would report it before the next tick.
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

	/**
	 * `sub`'s tail, read on its own through its reader and accepted as {@link acceptedTail} decides. A consulting
	 * read: each of these follows a reason to doubt what the node holds, and they are rare.
	 */
	private async readTail(sub: Subscription): Promise<CollectionTail | undefined> {
		const reader = this.readerOf(sub);
		if (reader === undefined) {
			return undefined;
		}
		const stamp = this.nextReadStamp();
		const answer = await reader.readTails([this.queryFor(sub)]).then(
			(answers) => answers.get(sub.collectionId),
			(error: unknown): CollectionTailAnswer => ({ error }),
		);
		return sub.closed ? undefined : this.acceptedTail(sub, stamp, answer, true);
	}

	/**
	 * The tail the read stamped `stamp` found for `sub`, now applied — or `undefined`, no news: the collection has
	 * never committed, the read failed or left the collection out (logged), or a read issued after this one was
	 * applied first. The tick's read runs outside the subscription's queue, so a re-anchor or a rotation follow's
	 * re-read can overtake it, and applying the older answer then would follow a tail the log has already left.
	 * Every read, batched or single, is applied through here. An applied consulting (`verified`) read restarts the
	 * subscription's count toward its next one; one that failed leaves it due on the next tick.
	 */
	private acceptedTail(sub: Subscription, stamp: number, answer: CollectionTailAnswer | undefined, verified: boolean): CollectionTail | undefined {
		if (stamp < sub.appliedReadStamp) {
			log("tail read for collection=%s dropped: a read issued after it was applied first", sub.collectionId);
			return undefined;
		}
		if (answer === undefined || "error" in answer) {
			log("tail read failed for collection=%s (no news this round): %o", sub.collectionId, answer?.error ?? "the reader returned no answer for it");
			return undefined;
		}
		sub.appliedReadStamp = stamp;
		sub.lastTailId = answer.tail?.tailId ?? sub.lastTailId;
		if (verified) {
			sub.ticksSinceVerified = 0;
		}
		return answer.tail;
	}

	/** The reader `sub` reads through: its first live listener's. */
	private readerOf(sub: Subscription): CollectionTailReader | undefined {
		const [listener] = sub.listeners;
		return listener?.tails;
	}

	private queryFor(sub: Subscription): CollectionTailQuery {
		return { collectionId: sub.collectionId, knownTailId: sub.lastTailId };
	}

	private nextReadStamp(): number {
		return ++this.readStamps;
	}

	/**
	 * Follow the tail whose bytes are `tailBytes`, the first attach included. `lastRevision` is a revision
	 * known to be committed (read from the log, or delivered); the manager's contiguity head is moved to it
	 * before the follow, so a notification arriving mid-registration for the next revision is delivered rather
	 * than read as a gap. Without that, a gap the cohort could not backfill would re-request a backfill on every
	 * later notification.
	 *
	 * The first attach builds the manager and registers its handler under the collection's topic before the
	 * cohort is asked to register the subscriber, so a notification is routed from the first moment; the
	 * handler then stays for the subscription's life. A registration that fails leaves the manager as it was
	 * (an existing registration keeps renewing at its root) and the next tick follows again.
	 *
	 * @returns true iff a registration landed (the first one, or a re-registration at a moved root).
	 */
	private async moveTo(sub: Subscription, tailBytes: Uint8Array, lastRevision: number): Promise<boolean> {
		const manager = sub.manager ?? this.attachManager(sub, tailBytes, lastRevision);
		manager.rebaseline(lastRevision);
		let landed: boolean;
		try {
			landed = await manager.followTail(tailBytes);
		} catch (err) {
			// NOTE: accepted tradeoff — a failed registration is retried by the next tick (30 s Core), not sooner.
			// A root nobody has registered under before admits its first registration on the request that asks:
			// the member it lands on holds it while the other members answer with their willingness. So a
			// `CohortBackoffError` here means too few of them answered inside that wait (2 s), or the cohort
			// declined for a reason of its own. Retrying on the delay the cohort names (1000 ms) is not an
			// improvement: a cohort allows one peer four register frames per topic per minute and a walk on a
			// new root sends two, so early retries spend the allowance, and when the retries were measured
			// against a cohort that was not ready the attach landed later, not sooner. Revisit if the cohort's
			// answer starts naming a delay that reflects when it will be ready.
			log("registration at tail=%s failed for collection=%s (retried by the next tick): %o", bytesToB64url(tailBytes), sub.collectionId, err);
			return false;
		}
		if (sub.closed) {
			// The close already dropped the handler and withdrew the registration it knew of; one that landed
			// after it is all that is left.
			if (landed) {
				this.withdraw(sub, manager);
			}
			return false;
		}
		return landed;
	}

	/** Build the collection's one manager and route the collection's topic to it, ahead of its first registration. */
	private attachManager(sub: Subscription, tailBytes: Uint8Array, lastKnownRev: number): ReactivitySubscriptionManager {
		const manager = this.buildManager(sub, tailBytes, lastKnownRev);
		sub.manager = manager;
		sub.unregisterHandler = this.options.subscribers.register(reactivityCollectionTopicId(sub.collectionIdBytes), (n) => manager.onNotification(n));
		return manager;
	}

	private buildManager(sub: Subscription, tailBytes: Uint8Array, lastKnownRev: number): ReactivitySubscriptionManager {
		const { recover, recoverSigners } = this.options;
		const collectionIdB64 = bytesToB64url(sub.collectionIdBytes);
		// The manager could not replay what its listeners missed, so wake them, then find out where the log is.
		const wakeThenReAnchor = (): void => {
			this.notify(sub);
			this.reAnchor(sub);
		};
		// The recover transports target the root group of the tail the manager has followed most recently, read
		// per request, so a backfill or resume after a rotation reaches the group that holds the data.
		let manager: ReactivitySubscriptionManager;
		const currentTail = (): Uint8Array => manager.tail;
		manager = new ReactivitySubscriptionManager({
			service: this.options.service,
			collectionId: sub.collectionIdBytes,
			tail: tailBytes,
			lastKnownRev,
			profile: this.options.profile,
			quorumRatio: this.options.quorumRatio,
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
					backfillTransport: recover.backfillTransport(currentTail, collectionIdB64),
					signBackfill: recoverSigners.signBackfill,
					resumeTransport: recover.resumeTransport(currentTail, collectionIdB64),
					signResume: recoverSigners.signResume,
				}
				: {}),
		});
		return manager;
	}

	/** A notification wakes the listeners only for a revision nothing has woken them for yet, a local landing included. */
	private onDelivered(sub: Subscription, n: NotificationV1): void {
		this.wakeIfNewer(sub, n.revision);
	}

	/**
	 * A change to the collection landed in this node's storage: wake the listeners whatever its revision. One already
	 * woken for still wakes, because a notification or a tail read answered elsewhere can announce a revision before
	 * this node's copy shows it; a lower one still wakes, because the change is still new to this node's copy (a held
	 * event released after a later commit's, or non-tail blocks of a commit landing after a later tail).
	 */
	private onLocalChange(sub: Subscription, event: CollectionChangeEvent): void {
		if (sub.closed) {
			return;
		}
		sub.lastSeenRevision = Math.max(sub.lastSeenRevision, event.rev);
		this.notify(sub);
	}

	private onRotation(sub: Subscription, notice: RotationNotice): void {
		if (sub.closed) {
			return;
		}
		this.rotationTargets.set(bytesToB64url(notice.plan.newTailId), sub);
		this.options.scheduleRotation(notice);
	}

	/** Queue one re-read of the tail (wake if newer, follow if it names another tail). */
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
