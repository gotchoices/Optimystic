/**
 * Reactivity — forwarder **host** orchestrator (`docs/reactivity.md` §Propagation, §Slow-subscriber
 * backpressure, §Per-cohort policy).
 *
 * This is the piece that turns the in-process forward *decision* (db-core's {@link ReactivityForwarder})
 * into live fan-out over the {@link ReactivityNotifyTransport}. For one {@link NotificationV1} — whether
 * locally originated (the change-bridge's `emit` seam binds to {@link ReactivityForwarderHost.ingest}) or
 * inbound off a dial ({@link ReactivityForwarderHost.onInbound}) — it:
 *
 *  1. lazily instantiates the per-collection {@link PushState} + forwarder behind the Edge policy gate
 *     ({@link mayServeAsReactivityForwarder}: an Edge node never forwards) and only once the topic has demand —
 *     at least one direct subscriber — so a collection nobody watches costs no replay ring and no gossip;
 *  2. runs the db-core receive path (verify → dedupe → buffer) and stops on `"duplicate"` / `"untrusted"`;
 *  3. on `"forward"`, fans the **unmodified** frame out to every direct subscriber (through the
 *     per-subscriber bounded queue, so a slow/dead subscriber's drops never stall the rest) and every
 *     child cohort.
 *
 * It owns the per-subscriber dequeue→dial delivery loop, the bounded-queue backpressure interaction,
 * subscriber-queue eviction (the memory bound — a departed subscriber's queue is reclaimed lazily each
 * fan-out round), and per-root serialization so the replay ring + dedupe set never interleave across two
 * concurrent notifications for the same collection.
 *
 * **Per-root state.** Everything this host keeps for a topic — the served {@link PushState}, the ingest
 * serialization chain, the rotation drain gate — is kept per **root**: per tail block the notification was
 * announced at, keyed by that tail (`NotificationV1.tailId`, the base64url of `reactivityTailBytes(tail)`).
 * While a topic is derived from its tail the two keys partition state identically; keying by the root is what
 * keeps two roots of one topic apart once a topic outlives its tail.
 *
 * **Subscriber-id space.** `selfPeerId`, the {@link ReactivityForwarderHostDeps.directSubscribers} output,
 * the {@link CohortRef.primary} child targets, and every {@link ReactivityNotifyTransport.send} target are
 * the **same** string space (it is also the `perSubscriberQueue` key). This host is agnostic to the concrete
 * encoding so long as it is consistent across all four seams; the **transport** pins which space —
 * {@link import("./notify-transport.js").Libp2pReactivityNotifyTransport.send} calls `peerIdFromString`, so
 * the space is the **canonical peer-id string** (NOT base64url-of-member-bytes — that would silently fail
 * `peerIdFromString` and never dial). The {@link reactivityDirectSubscribers} adapter and the node-wiring
 * layer ([reactivity-notification-transport]) therefore both emit peer-id strings.
 *
 * This module deliberately touches neither the libp2p node assembly ([reactivity-notification-transport])
 * nor gossip ([reactivity-pushstate-gossip]); it depends only on the transport interface + db-core logic,
 * so it is unit-testable with a fake transport.
 */

import {
	reactivityTopicId,
	b64urlToBytes,
	bytesToB64url,
	createReactivityForwarder,
	mayServeAsReactivityForwarder,
	requireForwarderPushState,
	decodeSubscribeAppPayload,
	TailDrainGate,
	type NotificationV1,
	type PeerRef,
	type NodeProfile,
	type PushState,
	type PushStateInit,
	type CohortRef,
	type NotificationVerifier,
	type ReactivityForwarder,
	type RegistrationRecord,
	type RotationRedirectV1,
} from "@optimystic/db-core";
import type { ReactivityNotifyTransport } from "./notify-transport.js";
import { bytesToPeerIdString } from "../cohort-topic/peer-codec.js";
import { createLogger } from "../logger.js";

const log = createLogger("reactivity-forwarder-host");

/**
 * The reactivity topic id a notification belongs to: `H(tailId ‖ "reactivity")` over the notification's
 * tail anchor. Kept in one place so it matches origination's `reactivityTailBytes` encoding and the
 * subscriber/forwarder verifier's coord derivation byte-for-byte (both decode `tailId` as base64url first).
 */
export function reactivityNotificationTopicId(n: NotificationV1): Uint8Array {
	return reactivityTopicId(b64urlToBytes(n.tailId));
}

/** Where a notification belongs: the root it was announced at (its tail) and the topic it is announced on. */
interface NotificationRoute {
	/** The root's tail bytes (`reactivityTailBytes(tail)`), which the root's cohort coordinate is derived from. */
	readonly rootTail: Uint8Array;
	/** {@link rootTail} as base64url — the key every per-root map is kept under. */
	readonly rootKey: string;
	readonly topicId: Uint8Array;
}

/** Route a notification; throws on an undecodable `tailId`. */
function routeOf(n: NotificationV1): NotificationRoute {
	const rootTail = b64urlToBytes(n.tailId);
	return { rootTail, rootKey: rootKeyOf(rootTail), topicId: reactivityNotificationTopicId(n) };
}

/** The key a root's state is kept under: the base64url of its tail bytes (a notification's `tailId`). */
function rootKeyOf(tail: Uint8Array): string {
	return bytesToB64url(tail);
}

/** The minimal cohort read the {@link reactivityDirectSubscribers} adapter needs (a {@link CoordEngine} satisfies it). */
export interface ReactivityRecordSource {
	/** This cohort's locally-known direct registration records for `topicId`. */
	records(topicId: Uint8Array): readonly RegistrationRecord[];
}

/**
 * The direct-subscriber **peer-id strings** for a reactivity topic, read from a cohort's
 * {@link RegistrationRecord} set: a record carries a subscriber iff its opaque `appState` decodes to a
 * reactivity {@link import("@optimystic/db-core").SubscribeAppPayloadV1}. `record.participantId` is the
 * subscriber's dialable member id (db-core's `service` pins `participantId = self`), carried as
 * `peerIdToBytes(peerId) = utf8(peerIdString)`; this decodes it back to the canonical peer-id string via
 * {@link bytesToPeerIdString} so the value is both the `transport.send` dial target (which calls
 * `peerIdFromString`) and the `perSubscriberQueue` key. **The whole host runs in this peer-id-string space**
 * — `selfPeerId`, `resolveChildPrimary`, and every `send` target must agree, or a base64url-vs-peer-id
 * mismatch is a silent no-dial. A record whose `appState` is absent or decodes to a non-reactivity payload
 * (e.g. a matchmaking registration sharing the cohort store) is skipped.
 */
export function reactivityDirectSubscribers(source: ReactivityRecordSource, topicId: Uint8Array): string[] {
	const out: string[] = [];
	for (const record of source.records(topicId)) {
		if (record.appState === undefined) {
			continue;
		}
		try {
			decodeSubscribeAppPayload(record.appState); // throws on a non-reactivity / malformed payload
		} catch {
			continue; // not a reactivity subscriber — leave the record to its own application
		}
		out.push(bytesToPeerIdString(record.participantId));
	}
	return out;
}

/** Construction inputs for a {@link ReactivityForwarderHost}. */
export interface ReactivityForwarderHostDeps {
	/** One-way notification transport (unicast send + inbound subscribe); fan-out dials each target through it. */
	readonly transport: ReactivityNotifyTransport;
	/** This node's member id, base64url — never dialed; a co-located subscriber is delivered in-process. */
	readonly selfPeerId: string;
	/** Node profile; gates {@link PushState} instantiation (Edge ⇒ subscriber-only, never forwards). */
	readonly profile: NodeProfile;
	/** Build the per-collection {@link PushStateInit} on the first ingest of a served topic that has a subscriber. */
	readonly pushStateInit: (topicId: Uint8Array, n: NotificationV1) => PushStateInit;
	/** The notification verifier for a topic (a db-core `createNotificationVerifier` over the host's service verifier, T3). */
	readonly verifierFor: (topicId: Uint8Array) => NotificationVerifier;
	/**
	 * Direct-subscriber member ids for `topicId` at the root whose tail bytes are `rootTail` — e.g.
	 * {@link reactivityDirectSubscribers} over the engine serving that root. The root, not the topic alone, names
	 * the cohort: a topic can have a root per tail block, and only that root's subscribers are its to fan out to.
	 */
	readonly directSubscribers: (topicId: Uint8Array, rootTail: Uint8Array) => string[];
	/** Resolve a child cohort's dialable primary when {@link CohortRef.primary} is absent (e.g. a FRET resolver). */
	readonly resolveChildPrimary?: (ref: CohortRef) => string | undefined;
	/**
	 * Route an inbound notification to a co-located subscription manager, when this node also subscribes the
	 * topic. **Must be idempotent on `(collectionId, revision)`**: on the {@link ReactivityForwarderHost.onInbound}
	 * path a node that is both a cohort member *and* a subscriber invokes this **twice** for the same
	 * notification — once in the subscriber role (directly) and once in the forwarder role (when `self` is in
	 * {@link directSubscribers}, via `fanOut`'s self-delivery). The db-core subscriber's `(collectionId,
	 * revision)` dedupe (`createReactivitySubscriber`) collapses the second call to a no-op, so a correctly
	 * wired manager delivers exactly once; a sink without that dedupe would double-deliver.
	 */
	readonly deliverLocal?: (topicId: Uint8Array, n: NotificationV1) => void;
	/** Wall clock (unix ms) stamped on `receive`. Default `Date.now`. */
	readonly clock?: () => number;
}

/** A root this node forwards for: its live {@link PushState} and the forwarder driving the receive path over it. */
interface ServedRoot {
	readonly pushState: PushState;
	readonly forwarder: ReactivityForwarder;
}

/**
 * The reactivity fan-out orchestrator. Build one per node; it serves every reactivity topic the node is a
 * cohort member for, lazily instantiating per-collection state on the first ingest that finds a subscriber. Bind
 * {@link ReactivityForwarderHost.ingest} to the origination `emit` seam and
 * {@link ReactivityForwarderHost.onInbound} to the transport's inbound subscribe.
 */
export class ReactivityForwarderHost {
	private readonly transport: ReactivityNotifyTransport;
	private readonly selfPeerId: string;
	private readonly profile: NodeProfile;
	private readonly pushStateInit: (topicId: Uint8Array, n: NotificationV1) => PushStateInit;
	private readonly verifierFor: (topicId: Uint8Array) => NotificationVerifier;
	private readonly directSubscribers: (topicId: Uint8Array, rootTail: Uint8Array) => string[];
	private readonly resolveChildPrimary?: (ref: CohortRef) => string | undefined;
	private readonly deliverLocal?: (topicId: Uint8Array, n: NotificationV1) => void;
	private readonly clock: () => number;

	/**
	 * Per-root served state, keyed by the root's tail (base64url). `ServedRoot` ⇒ forwards; `null` ⇒ resolved
	 * subscriber-only (Edge); absent ⇒ unresolved, or no demand yet (see {@link hasDemand}).
	 *
	 * NOTE: a `ServedRoot` outlives its last subscriber — it is reclaimed only once a tail rotation's drain window
	 * has closed ({@link releaseDrainedRoots}). If memory ever shows it, evict on a {@link hasDemand} check at ingest.
	 * A root this node never sees a later tail for is never released at all: when one coordinator covers every
	 * block, the rollover's other blocks commit on the new tail's cohort, so a machine in the old tail's group but
	 * outside that cohort may never observe the rollover. If that shows in memory, release a served root that has
	 * had no ingest for longer than `T_drain`.
	 */
	private readonly served = new Map<string, ServedRoot | null>();
	/** Per-root serialization tail: an ingest chains onto its root's prior ingest so the ring/dedupe never interleave. */
	private readonly ingestTails = new Map<string, Promise<void>>();
	/**
	 * Per **old-root** drain gate: set by {@link markRotated} when this node observes the collection's log move
	 * past a tail, keyed by that outgoing tail (base64url). For `T_drain` after the rotation
	 * {@link rotationRedirectFor} answers a recover request reaching the outgoing root with the gate's
	 * {@link RotationRedirectV1} ("this moved — go to the new tree"); once the window closes the entry is
	 * evicted along with the root's served `PushState`.
	 */
	private readonly rotationGates = new Map<string, TailDrainGate>();

	constructor(deps: ReactivityForwarderHostDeps) {
		this.transport = deps.transport;
		this.selfPeerId = deps.selfPeerId;
		this.profile = deps.profile;
		this.pushStateInit = deps.pushStateInit;
		this.verifierFor = deps.verifierFor;
		this.directSubscribers = deps.directSubscribers;
		this.resolveChildPrimary = deps.resolveChildPrimary;
		this.deliverLocal = deps.deliverLocal;
		this.clock = deps.clock ?? ((): number => Date.now());
	}

	/**
	 * Local origination emit **and** the inbound forwarder path: receive → forward → fan-out for one
	 * notification, at the root its `tailId` names and on the topic {@link reactivityNotificationTopicId}
	 * derives. Ingests at one root run strictly in sequence (verify is async and the replay ring + dedupe set
	 * must not interleave); ingests at different roots proceed concurrently. Never rejects — a fan-out fault can
	 * never surface as a commit failure on the origination seam.
	 */
	ingest(n: NotificationV1): Promise<void> {
		let route: NotificationRoute;
		try {
			route = routeOf(n);
		} catch (err) {
			log("ingest: undecodable tailId on rev=%d (dropped): %o", n.revision, err);
			return Promise.resolve();
		}
		const key = route.rootKey;
		const prev = this.ingestTails.get(key) ?? Promise.resolve();
		// Run regardless of the prior ingest's outcome; `ingestSerialized` isolates its own throws, so the
		// chain never accumulates a rejection that would leak out of a later `ingest`.
		const next = prev.then(
			() => this.ingestSerialized(route, n),
			() => this.ingestSerialized(route, n),
		);
		this.ingestTails.set(key, next);
		// Drop the tail once it settles with nothing chained behind it: every collection this node originates for
		// passes through here, one root per log tail block, so a kept entry would grow with the commit count.
		void next.then(() => {
			if (this.ingestTails.get(key) === next) {
				this.ingestTails.delete(key);
			}
		});
		return next;
	}

	/** One serialized ingest: resolve served state, run receive, fan out on `"forward"`. Isolates all throws. */
	private async ingestSerialized(route: NotificationRoute, n: NotificationV1): Promise<void> {
		try {
			const served = this.resolveServed(route, n);
			if (served === undefined) {
				return; // Edge, or nobody subscribed: nothing to forward (local delivery rides onInbound → deliverLocal).
			}
			const decision = await served.forwarder.receive(n, this.clock());
			if (decision !== "forward") {
				return; // "duplicate" (already buffered) or "untrusted" (dropped before any state mutation).
			}
			this.fanOut(route, served.pushState, n);
		} catch (err) {
			log("ingest failed for root=%s rev=%d (isolated): %o", route.rootKey, n.revision, err);
		}
	}

	/**
	 * Inbound notify dial: run the **subscriber** role (in-process delivery to a co-located manager) and the
	 * **forwarder** role (receive + fan-out) as applicable. A node that is both a cohort member and a
	 * subscriber does both — the forwarder dedupe + the subscriber's `(collectionId, revision)` dedupe keep
	 * it idempotent. Never rejects.
	 */
	async onInbound(_from: PeerRef, n: NotificationV1): Promise<void> {
		let topicId: Uint8Array;
		try {
			topicId = reactivityNotificationTopicId(n);
		} catch (err) {
			log("onInbound: undecodable tailId on rev=%d (dropped): %o", n.revision, err);
			return;
		}
		// Subscriber role first: deliver in-process to a co-located subscription manager, if any.
		this.deliverInProcess(topicId, n);
		// Forwarder role: ingest self-gates (Edge, or no subscriber here ⇒ no PushState, no fan-out).
		await this.ingest(n);
	}

	/**
	 * The live {@link PushState} this node serves for the root whose tail bytes are `tail`
	 * (`reactivityTailBytes(tail)`), or `undefined` (Edge, no demand, or not yet ingested).
	 */
	pushStateForRoot(tail: Uint8Array): PushState | undefined {
		const served = this.served.get(rootKeyOf(tail));
		return served === undefined || served === null ? undefined : served.pushState;
	}

	/**
	 * Every live forwarder {@link PushState} this node currently serves: the topics it has ingested at least
	 * one notification for while they had a subscriber, and instantiated state behind the Edge gate
	 * (subscriber-only `null`s, topics without demand and not-yet-ingested topics are skipped). The
	 * push-state-gossip driver iterates these each round to broadcast convergence state to each collection's
	 * cohort, so a member that missed an origin dial still ends up holding the replay entry.
	 */
	livePushStates(): PushState[] {
		const out: PushState[] = [];
		for (const served of this.served.values()) {
			if (served !== null) {
				out.push(served.pushState);
			}
		}
		return out;
	}

	/**
	 * The live {@link PushState} this node serves for `collectionId` (base64url), or `undefined` if none.
	 * The served map is keyed by **root tail**, but a backfill request carries only a collectionId and a
	 * resume that lost its tail must still resolve the collection's current tail — so this scans for the
	 * served root whose `PushState.collectionId` matches. Across a tail-rotation **drain window** a
	 * collection can briefly have two served roots (the outgoing and incoming tail); the one with the
	 * highest `lastRevision` is the current tail, so that is the one returned. (The precise drain-window
	 * redirect choreography is `reactivity-tail-rotation-transport`'s; this picks the current tail.)
	 */
	pushStateForCollection(collectionId: string): PushState | undefined {
		let best: PushState | undefined;
		for (const served of this.served.values()) {
			if (served === null || served.pushState.collectionId !== collectionId) {
				continue;
			}
			if (best === undefined || served.pushState.lastRevision > best.lastRevision) {
				best = served.pushState;
			}
		}
		return best;
	}

	/**
	 * Record that the root at the tail whose bytes are `oldTail` has **rotated** to a successor tail, starting a
	 * {@link TailDrainGate} so the outgoing root bounces recover requests to the new tree for `T_drain`
	 * (`docs/reactivity.md` §Tail rotation step 2). db-core derives the redirect's `newTopicId` internally via
	 * `reactivityTopicId(newTailId)`. The trigger is origination seeing a commit that names a later tail
	 * (`ReactivityOriginationManager.observeTailCommit`); this seam is called directly in unit tests.
	 *
	 * **Idempotent / chained.** A second `markRotated` for the **same** successor is a no-op; a `markRotated`
	 * to a **later** successor (higher `effectiveAtRevision`) replaces the gate — so a chained OLD→A→B rotation
	 * advances the redirect to the most recent successor and restarts its drain window from `now`. An earlier
	 * (or equal) successor leaves the existing gate untouched.
	 */
	markRotated(oldTail: Uint8Array, redirect: { newTailId: string; effectiveAtRevision: number }, now: number): void {
		this.releaseDrainedRoots(now);
		const key = rootKeyOf(oldTail);
		const existing = this.rotationGates.get(key);
		if (existing !== undefined && redirect.effectiveAtRevision <= existing.rotationRedirect.effectiveAtRevision) {
			return; // same or earlier successor — the gate already points at this-or-a-later tail.
		}
		this.rotationGates.set(key, new TailDrainGate({
			rotatedAt: now,
			newTailId: redirect.newTailId,
			effectiveAtRevision: redirect.effectiveAtRevision,
		}));
	}

	/**
	 * The drain-window redirect for a recover request that reached the outgoing root at the tail whose bytes are
	 * `oldTail`, or `undefined` if that root never rotated / its drain window has elapsed. While the gate is
	 * draining (`isDraining(now)`) returns its {@link RotationRedirectV1}; once `T_drain` closes, evicts the gate
	 * **and** the root's served `PushState` (the old tail originates nothing further — this also reclaims the
	 * `served` / `ingestTails` maps the 12.31 review flagged as un-evicted on rotation) and returns `undefined`,
	 * so this member declines the next request and the subscriber's transport tries the next cohort member
	 * (re-walking / chain-reading only once every member declines).
	 */
	rotationRedirectFor(oldTail: Uint8Array, now: number): RotationRedirectV1 | undefined {
		const key = rootKeyOf(oldTail);
		const gate = this.rotationGates.get(key);
		if (gate === undefined) {
			return undefined;
		}
		if (gate.isDraining(now)) {
			return gate.rotationRedirect;
		}
		this.releaseDrainedRoot(key);
		return undefined;
	}

	/**
	 * Release every outgoing root whose drain window has closed. Run on each {@link markRotated}: the origination
	 * manager marks a rotation for every collection this node announced for, watched or not, and a recover
	 * request — the only other release point — never reaches the old root of a collection nobody watches, so
	 * without this sweep the gates (and any served state behind them) would accumulate one per filled log block.
	 */
	private releaseDrainedRoots(now: number): void {
		for (const [key, gate] of [...this.rotationGates]) {
			if (!gate.isDraining(now)) {
				this.releaseDrainedRoot(key);
			}
		}
	}

	/** The outgoing root is done: drop its gate and reclaim its served state so the per-root maps don't leak across rotations. */
	private releaseDrainedRoot(key: string): void {
		this.rotationGates.delete(key);
		this.served.delete(key);
		this.ingestTails.delete(key);
	}

	/**
	 * Fan the unmodified frame out: reconcile (GC) departed-subscriber queues, enqueue per-subscriber
	 * (drop-oldest under pressure), drain each queue and deliver (self in-process, others dialed, per-target
	 * isolated), then dial each resolved child cohort. One slow/dead target never blocks the loop for the rest.
	 */
	private fanOut(route: NotificationRoute, pushState: PushState, n: NotificationV1): void {
		const subscriberIds = this.directSubscribers(route.topicId, route.rootTail);

		// Memory bound: drop any per-subscriber queue whose id left the live set (departed / TTL-expired /
		// withdrawn). The map can never grow past the live subscriber set + the current round (lazy GC, so it
		// shrinks at most one fan-out round late) — this satisfies the `subscribers × queue_max × size` bound.
		this.reconcileQueues(pushState, subscriberIds);

		// Enqueue onto each subscriber's bounded queue (a slow subscriber's drop-oldest isolates to its queue).
		pushState.enqueueForSubscribers(subscriberIds, n);

		// Drain + deliver per subscriber, isolated: one dead subscriber's dial never stalls the others.
		for (const subId of subscriberIds) {
			const queue = pushState.perSubscriberQueue.peekQueue(subId);
			if (queue === undefined) {
				continue;
			}
			for (const m of queue.drain()) {
				this.deliverTo(route.topicId, subId, m);
			}
		}

		// Child cohorts get the unmodified frame (forwarders never re-sign). No-op until the parent/child link
		// lands ([cohort-topic-parent-child-link]) populates `childCohorts`.
		for (const ref of pushState.childCohorts) {
			const target = ref.primary ?? this.resolveChildPrimary?.(ref);
			if (target !== undefined && target !== this.selfPeerId) {
				this.dispatch(target, n);
			}
		}
	}

	/** Reclaim the queues of subscribers no longer in the live set (lazy, one round late). */
	private reconcileQueues(pushState: PushState, subscriberIds: readonly string[]): void {
		const live = new Set(subscriberIds);
		// Snapshot the keys: `remove` mutates the backing map, which would invalidate a live iterator.
		for (const id of [...pushState.perSubscriberQueue.subscribers()]) {
			if (!live.has(id)) {
				pushState.perSubscriberQueue.remove(id);
			}
		}
	}

	/** Deliver one notification to one subscriber: self in-process, everyone else over the transport. */
	private deliverTo(topicId: Uint8Array, subId: string, n: NotificationV1): void {
		if (subId === this.selfPeerId) {
			this.deliverInProcess(topicId, n);
		} else {
			this.dispatch(subId, n);
		}
	}

	/** Route to a co-located subscription manager, isolating a throwing subscriber from the rest of the fan-out. */
	private deliverInProcess(topicId: Uint8Array, n: NotificationV1): void {
		if (this.deliverLocal === undefined) {
			return;
		}
		try {
			this.deliverLocal(topicId, n);
		} catch (err) {
			log("local delivery threw (isolated) for rev=%d: %o", n.revision, err);
		}
	}

	/** Fire one unicast send, isolated: a synchronous throw or a rejection is swallowed, never the loop's concern. */
	private dispatch(target: string, n: NotificationV1): void {
		let pending: Promise<void>;
		try {
			pending = this.transport.send(target, n);
		} catch (err) {
			log("notify send to %s threw synchronously (isolated): %o", target, err);
			return;
		}
		void pending.catch((err: unknown) => {
			log("notify send to %s rejected (isolated): %o", target, err);
		});
	}

	/**
	 * Resolve the served state for a root, instantiating it once behind the Edge gate and the demand check.
	 * `undefined` ⇒ nothing to forward. A no-demand answer is deliberately not remembered, so the first ingest
	 * after a subscriber registers builds the state.
	 */
	private resolveServed(route: NotificationRoute, n: NotificationV1): ServedRoot | undefined {
		const existing = this.served.get(route.rootKey);
		if (existing !== undefined) {
			return existing ?? undefined; // a `ServedRoot`, or a remembered Edge `null`
		}
		if (!mayServeAsReactivityForwarder(this.profile)) {
			this.served.set(route.rootKey, null); // Edge node: remember it never forwards at this root.
			return undefined;
		}
		if (!this.hasDemand(route)) {
			return undefined;
		}
		const pushState = requireForwarderPushState(this.profile, this.pushStateInit(route.topicId, n));
		const served: ServedRoot = {
			pushState,
			forwarder: createReactivityForwarder({ state: pushState, verifier: this.verifierFor(route.topicId) }),
		};
		this.served.set(route.rootKey, served);
		return served;
	}

	/**
	 * Whether anyone downstream wants the root's notifications: at least one direct subscriber. Child cohorts
	 * join as a second clause once the parent/child link ([cohort-topic-parent-child-link]) supplies them
	 * ahead of any {@link PushState}. Costs what one fan-out's subscriber read costs (in the node wiring, one
	 * lookup of the engine at the root's coordinate and a scan of its records), once per ingest at a root without
	 * state — cheap enough not to cache.
	 */
	private hasDemand(route: NotificationRoute): boolean {
		return this.directSubscribers(route.topicId, route.rootTail).length > 0;
	}
}
