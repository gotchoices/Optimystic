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
 */

import {
	buildNotificationV1,
	bytesToB64url,
	b64urlToBytes,
	reactivityTopicId,
	BlockFillTracker,
	type BlockFillTrackerInit,
	type CohortTopicService,
	type CollectionChangeEvent,
	type CommitCert,
	type NotificationV1,
	type RotationHintV1,
} from "@optimystic/db-core";
import { peerIdToBytes } from "../cohort-topic/peer-codec.js";
import { createLogger } from "../logger.js";

const log = createLogger("reactivity-origination");

/** Per-collection origination context the manager resolves at emit time. */
export interface OriginationCollectionContext {
	/** Current tail block id the reactivity topic is anchored on (raw bytes). */
	readonly tailId: Uint8Array;
	/** Per-collection delta budget (bytes); `0` ⇒ omit `delta` (Edge / collection declines deltas). */
	readonly deltaMaxBytes: number;
	/** Optional bounded delta to attach (raw bytes). */
	readonly delta?: Uint8Array;
	/** Optional tail-rotation pre-announce (rotation ticket supplies it). */
	readonly rotationHint?: RotationHintV1;
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
	 * Start the **outgoing** tail's drain when this manager observes a collection's tail id **change**
	 * between commits (the authoritative, observable live-node rotation signal — the pre-announce
	 * `rotationHint{ newTailId }` cannot be built on a live node because the successor tail id is not knowable
	 * at the filling commit; see `docs/reactivity.md` §Tail rotation and the `6.5-block-id-derivation` gate).
	 * The node binds this to {@link import("./forwarder-host.js").ReactivityForwarderHost.markRotated} so the
	 * old cohort's recover serve begins redirecting. `oldTopicId` is the **previous** tail's reactivity topic
	 * id (`reactivityTopicId` over the resolved tail bytes — the SAME encoding a subscriber subscribes under).
	 * Absent ⇒ origination is unchanged (rotation observation is inert), preserving existing callers/tests.
	 */
	readonly markRotated?: (oldTopicId: Uint8Array, redirect: { newTailId: string; effectiveAtRevision: number }, now: number) => void;
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
	private readonly markRotated?: (oldTopicId: Uint8Array, redirect: { newTailId: string; effectiveAtRevision: number }, now: number) => void;
	private readonly blockFill?: BlockFillTrackerInit;
	private readonly clock: () => number;

	/** Last-seen reactivity tail anchor (base64url of the resolved tail bytes) per collection — the rotation signal. */
	private readonly lastSeenTail = new Map<string, string>();
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
			// Observe the tail (rotation detection + block-fill warm-up) BEFORE emit, fully isolated so neither
			// ever blocks the notification — the delivery-critical path.
			this.observeTail(event, ctx);
			const notification = buildNotificationV1(event, commitCert, {
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
	 * Track the collection's reactivity tail and drive the rotation + warm-up signals. Isolated so a fault
	 * here never blocks the notification emit. Only reached for commits this node originates (a defined `ctx`),
	 * so a tail-less (read-driven) commit never records or clears the last-seen tail (the early-return holds).
	 */
	private observeTail(event: CollectionChangeEvent, ctx: OriginationCollectionContext): void {
		try {
			this.trackBlockFill(event);
			this.detectTailRotation(event, ctx);
		} catch (err) {
			log("rotation/warm-up observation failed for collection=%s rev=%d (isolated): %o", event.collectionId, event.rev, err);
		}
	}

	/**
	 * Feed the per-collection {@link BlockFillTracker} one commit. The `warmup` signal is **best-effort and
	 * signal-only** on a live node: the next `tailId` is not knowable (block ids are random until
	 * `6.5-block-id-derivation`), so the anticipatory pre-dial bias is logged, never fabricated into a
	 * successor coord (`docs/reactivity.md` §Anticipatory warm-up). The `filling` signal cannot pre-announce a
	 * hint on a live node for the same reason — it is logged only.
	 */
	private trackBlockFill(event: CollectionChangeEvent): void {
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
			log("block-fill filling commit for collection=%s (%d committed) — no live pre-announce (successor tail id not knowable; rotation observed on the next commit's tail-id change)", key, signal.count);
		}
	}

	/**
	 * Detect a tail rotation by comparing the resolved tail anchor against the last-seen one for the
	 * collection. The first commit records the baseline (no rotation). On a **change**, the previous tail's
	 * reactivity topic has rotated to this one: fire {@link markRotated} for the OLD topic so the old cohort's
	 * recover serve begins redirecting to the new tree.
	 *
	 * **Encoding contract.** `ctx.tailId` is the reactivity tail anchor bytes the node resolved
	 * (`reactivityTailBytes(event.tailId)` in production — the SAME utf8 encoding origination's membership gate
	 * and a subscriber's `reactivityTopicId(reactivityTailBytes(tail))` use, NOT the double-hashing
	 * `blockIdToBytes`). So `oldTopicId = reactivityTopicId(oldAnchorBytes)` is byte-identical to the topic a
	 * subscriber subscribed under — a mismatch would silently never redirect.
	 */
	private detectTailRotation(event: CollectionChangeEvent, ctx: OriginationCollectionContext): void {
		const key = event.collectionId;
		const newTailB64 = bytesToB64url(ctx.tailId);
		const lastTailB64 = this.lastSeenTail.get(key);
		if (lastTailB64 !== undefined && lastTailB64 !== newTailB64) {
			const oldTopicId = reactivityTopicId(b64urlToBytes(lastTailB64));
			this.markRotated?.(oldTopicId, { newTailId: newTailB64, effectiveAtRevision: event.rev }, this.clock());
		}
		this.lastSeenTail.set(key, newTailB64);
	}
}
