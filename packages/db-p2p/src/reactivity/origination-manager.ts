/**
 * Reactivity — notification origination manager (db-p2p, wires to the cohort-topic substrate).
 *
 * Installs the substrate's {@link CohortTopicService.onLocalCommit} origination hook so a commit landing
 * on a node that is a tail-cohort member for the collection's reactivity topic emits a signed
 * {@link NotificationV1} (`docs/reactivity.md` §Notification origination). The local-change-notifier
 * bridge ([local-change-notifier-bridge]) supplies the {@link CollectionChangeEvent} + pass-through
 * {@link CommitCert}; this manager calls db-core's {@link buildNotificationV1} (which reuses the commit
 * cert's threshold signature **unchanged** — reactivity never re-signs) and hands the result to the
 * injected {@link emit} transport, which fans it out to direct subscribers and child cohorts.
 *
 * The cluster keys its commit votes by **peer-id string**; the cohort-topic membership verifier compares
 * signers as the member-id **bytes** (UTF-8 of the peer-id string, base64url on the wire). So this
 * manager supplies `encodeSigner = s ⇒ bytesToB64url(peerIdToBytes(s))`, the inverse the subscriber's
 * {@link createNotificationVerifier} default (`b64urlToBytes`) consumes — closing the encoding loop end
 * to end.
 *
 * It also watches for the log moving to a new tail block ({@link ReactivityOriginationManager.observeTailCommit}),
 * which the change bridge feeds every tail-bearing commit — not only the ones this node announces — so a
 * machine that is in the old tail's group but not the new one still sees its root rotate.
 */

import {
	buildNotificationV1,
	bytesToB64url,
	b64urlToBytes,
	reactivityCollectionTopicId,
	BlockFillTracker,
	type BlockFillTrackerInit,
	type CohortTopicService,
	type CollectionChangeEvent,
	type CommitCert,
	type NotificationV1,
	type RotationHintV1,
} from "@optimystic/db-core";
import { peerIdToBytes } from "../cohort-topic/peer-codec.js";
import { selfAppliedTail } from "../cohort-topic/change-bridge.js";
import { reactivityCollectionIdBytes, reactivityTailBytes } from "./topic-bytes.js";
import type { RootRotation } from "./forwarder-host.js";
import { createLogger } from "../logger.js";

const log = createLogger("reactivity-origination");

/** Per-collection origination context the manager resolves at emit time. */
export interface OriginationCollectionContext {
	/**
	 * The collection id's bytes; the notification names its collection by their base64url. The node supplies
	 * `reactivityCollectionIdBytes(event.collectionId)` — the SAME bytes a subscriber registers under and
	 * matches against (`reactivity/topic-bytes.ts`). Absent ⇒ `event.collectionId` goes on the notification
	 * unencoded, correct only for a caller whose collection ids are already base64url (the mock harness).
	 */
	readonly collectionId?: Uint8Array;
	/** Current tail block id the reactivity topic is anchored on (raw bytes). */
	readonly tailId: Uint8Array;
	/** Per-collection delta budget (bytes); `0` ⇒ omit `delta` (Edge / collection declines deltas). */
	readonly deltaMaxBytes: number;
	/** Optional bounded delta to attach (raw bytes). */
	readonly delta?: Uint8Array;
	/** Optional tail-rotation pre-announce (rotation ticket supplies it). */
	readonly rotationHint?: RotationHintV1;
}

/**
 * The origination context a live node resolves for one committed change, or `undefined` for a tail-less
 * event (a read-driven promotion never originates; the bridge's tail-applied gate also returns before this).
 *
 * Both ids go on the notification in the pinned encodings of `reactivity/topic-bytes.ts`, the SAME ones a
 * subscriber derives its topic from and registers under — a different encoding on either side and
 * origination silently never reaches it. `rotationHint` stays absent on a live node: the successor tail id is not knowable at the filling
 * commit (random block ids; gated on `6.5-block-id-derivation`), so the observable rotation signal is a
 * commit naming a later tail, which the manager reports through `markRotated` (`observeTailCommit`).
 */
export function liveOriginationContext(event: CollectionChangeEvent, deltaMaxBytes: number): OriginationCollectionContext | undefined {
	if (event.tailId === undefined) {
		return undefined;
	}
	return {
		collectionId: reactivityCollectionIdBytes(event.collectionId),
		tailId: reactivityTailBytes(event.tailId),
		deltaMaxBytes,
	};
}

/** Construction inputs for a {@link ReactivityOriginationManager}. */
export interface ReactivityOriginationManagerOptions {
	/** The cohort-topic substrate whose `onLocalCommit` hook this manager installs. */
	readonly service: CohortTopicService;
	/**
	 * Resolve the per-collection origination context (tail id, delta budget) for a change event. Returns
	 * `undefined` to skip origination for this collection (e.g. this node is not the tail primary for it).
	 */
	readonly resolveContext: (event: CollectionChangeEvent) => OriginationCollectionContext | undefined;
	/** Fan the built notification out to direct subscribers and child cohorts (the reactivity transport). */
	readonly emit: (notification: NotificationV1) => void;
	/**
	 * Start the **outgoing** root's drain when {@link ReactivityOriginationManager.observeTailCommit} sees a
	 * commit naming a tail other than the one this node last announced for the collection (the authoritative,
	 * observable live-node rotation signal — the pre-announce `rotationHint{ newTailId }` cannot be built on a
	 * live node because the successor tail id is not knowable at the filling commit; see `docs/reactivity.md`
	 * §Tail rotation and the `6.5-block-id-derivation` gate). The node binds this to
	 * {@link import("./forwarder-host.js").ReactivityForwarderHost.markRotated} so the old root's recover serve
	 * begins redirecting. `oldTail` is the **previous** tail in the reactivity tail encoding
	 * (`reactivityTailBytes`) — the bytes the forwarder host keys that root's state by; the redirect carries the
	 * collection's topic (`reactivityCollectionTopicId` over `reactivityCollectionIdBytes(event.collectionId)`,
	 * the topic a subscriber registers under), which a rotation leaves unchanged. Absent ⇒ rotation observation
	 * is inert.
	 */
	readonly markRotated?: (oldTail: Uint8Array, redirect: RootRotation, now: number) => void;
	/**
	 * Per-collection {@link BlockFillTracker} tuning for the anticipatory **warm-up** signal. The warm-up is
	 * best-effort and **signal-only** on a live node (the next `tailId` is not knowable, so no successor coord
	 * is fabricated — the bias is logged, never acted on; `docs/reactivity.md` §Anticipatory warm-up). Defaults
	 * to the db-core block-fill defaults.
	 */
	readonly blockFill?: BlockFillTrackerInit;
	/** Wall clock (unix ms) stamped on each notification. Default `Date.now`. */
	readonly clock?: () => number;
}

/** Installs and drives the reactivity origination hook on a {@link CohortTopicService}. */
export class ReactivityOriginationManager {
	private readonly service: CohortTopicService;
	private readonly resolveContext: (event: CollectionChangeEvent) => OriginationCollectionContext | undefined;
	private readonly emit: (notification: NotificationV1) => void;
	private readonly markRotated?: (oldTail: Uint8Array, redirect: RootRotation, now: number) => void;
	private readonly blockFill?: BlockFillTrackerInit;
	private readonly clock: () => number;

	/**
	 * Per collection, the tail this node last applied a commit for — the root it last announced at — as the
	 * base64url of `reactivityTailBytes(tail)`, with the highest revision it applied there. The baseline
	 * {@link observeTailCommit} detects a rotation against.
	 *
	 * NOTE: an entry is dropped only when its rotation is marked, so a node that leaves a tail's group before the
	 * rollover keeps it (as `fillTrackers` keeps one per collection). If that shows in memory, age out entries with
	 * no tail-bearing commit for longer than `T_drain`.
	 */
	private readonly lastAnnouncedTail = new Map<string, { readonly tail: string; readonly rev: number }>();
	/** Per-collection block-fill tracker driving the anticipatory warm-up signal (signal-only on a live node). */
	private readonly fillTrackers = new Map<string, BlockFillTracker>();

	constructor(options: ReactivityOriginationManagerOptions) {
		this.service = options.service;
		this.resolveContext = options.resolveContext;
		this.emit = options.emit;
		this.markRotated = options.markRotated;
		this.blockFill = options.blockFill;
		this.clock = options.clock ?? ((): number => Date.now());
	}

	/** Install the origination hook (overwrites any prior `onLocalCommit`). */
	install(): void {
		this.service.onLocalCommit = (event, commitCert): void => this.originate(event, commitCert);
	}

	/** Build + emit the notification for one committed change; isolates throws so commit is never broken. */
	private originate(event: CollectionChangeEvent, commitCert: CommitCert): void {
		try {
			const ctx = this.resolveContext(event);
			if (ctx === undefined) {
				return; // not the origination point for this collection (tail-less / non-member)
			}
			// Block-fill warm-up BEFORE emit, fully isolated so it never blocks the notification — the
			// delivery-critical path.
			this.trackBlockFill(event);
			const notification = buildNotificationV1(event, commitCert, {
				collectionId: ctx.collectionId === undefined ? undefined : bytesToB64url(ctx.collectionId),
				tailId: bytesToB64url(ctx.tailId),
				timestamp: this.clock(),
				deltaMaxBytes: ctx.deltaMaxBytes,
				delta: ctx.delta,
				rotationHint: ctx.rotationHint,
				encodeSigner: (s) => bytesToB64url(peerIdToBytes(s)),
			});
			this.emit(notification);
		} catch (err) {
			log("origination failed for collection=%s rev=%d: %o", event.collectionId, event.rev, err);
		}
	}

	/**
	 * Watch one commit for the log moving past the tail this node last announced at. The change bridge calls
	 * this for **every** commit event that names a tail, ahead of and independently of its origination gate,
	 * because the machines that announced at the old tail — its storage group — and the ones that will announce
	 * at the new tail are mostly different machines once the network is wider than one group. A machine only in
	 * the old group never applies a commit naming the new tail, but it does apply the rollover commit's rewrite
	 * of the old tail block's `nextId`, and that event names the new tail.
	 *
	 * - An event naming a tail other than the baseline: the root at the baseline has rotated, so fire
	 *   {@link markRotated} for it (effective at this event's revision) and forget the baseline.
	 * - An event whose tail this node applied: it is in that tail's group, so that tail becomes the baseline.
	 * - Anything else — the same tail without having applied it (a data-block sweep landing on a member of the
	 *   tail's group) — leaves the baseline alone; forgetting it there would lose what the rollover is measured
	 *   against.
	 * - An event at or below the baseline's revision that names another tail is an older commit landing late
	 *   (a sweep round delayed past the rollover), not a move, and is ignored: marking it would drain the live
	 *   root and redirect its recover requests to the tail the log already left.
	 *
	 * A tail-less event (replica push, read-driven promotion) is ignored. Isolated: logs, never throws.
	 *
	 * **Encoding contract.** Tails are compared and reported as `reactivityTailBytes(event.tailId)` — the bytes a
	 * notification's `tailId` encodes and the forwarder host keys a root's state by. A mismatch would silently
	 * never redirect.
	 */
	observeTailCommit(event: CollectionChangeEvent): void {
		try {
			if (event.tailId === undefined) {
				return;
			}
			const key = event.collectionId;
			const tail = bytesToB64url(reactivityTailBytes(event.tailId));
			const last = this.lastAnnouncedTail.get(key);
			if (last !== undefined && last.tail !== tail) {
				if (event.rev <= last.rev) {
					return;
				}
				const topicId = bytesToB64url(reactivityCollectionTopicId(reactivityCollectionIdBytes(event.collectionId)));
				this.markRotated?.(b64urlToBytes(last.tail), { newTailId: tail, effectiveAtRevision: event.rev, topicId }, this.clock());
				this.lastAnnouncedTail.delete(key);
			}
			if (selfAppliedTail(event) && (last?.tail !== tail || event.rev > last.rev)) {
				this.lastAnnouncedTail.set(key, { tail, rev: event.rev });
			}
		} catch (err) {
			log("tail observation failed for collection=%s rev=%d (isolated): %o", event.collectionId, event.rev, err);
		}
	}

	/**
	 * Feed the per-collection {@link BlockFillTracker} one commit. The `warmup` signal is **best-effort and
	 * signal-only** on a live node: the next `tailId` is not knowable (block ids are random until
	 * `6.5-block-id-derivation`), so the anticipatory pre-dial bias is logged, never fabricated into a
	 * successor coord (`docs/reactivity.md` §Anticipatory warm-up). The `filling` signal cannot pre-announce a
	 * hint on a live node for the same reason — it is logged only. Isolated so a fault here never blocks the
	 * notification emit.
	 */
	private trackBlockFill(event: CollectionChangeEvent): void {
		try {
			const key = event.collectionId;
			let tracker = this.fillTrackers.get(key);
			if (tracker === undefined) {
				tracker = new BlockFillTracker(this.blockFill);
				this.fillTrackers.set(key, tracker);
			}
			const signal = tracker.onCommit();
			if (signal.kind === "warmup") {
				log("block-fill warm-up for collection=%s (%d committed, %d remaining) — anticipatory pre-dial is signal-only on a live node (successor tail not knowable; gated on 6.5-block-id-derivation)", key, signal.count, signal.remaining);
			} else if (signal.kind === "filling") {
				log("block-fill filling commit for collection=%s (%d committed) — no live pre-announce (successor tail id not knowable; rotation observed on the next commit naming a new tail)", key, signal.count);
			}
		} catch (err) {
			log("block-fill warm-up observation failed for collection=%s rev=%d (isolated): %o", event.collectionId, event.rev, err);
		}
	}
}
