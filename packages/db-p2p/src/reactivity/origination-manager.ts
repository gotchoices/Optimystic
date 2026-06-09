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
	/** Wall clock (unix ms) stamped on each notification. Default `Date.now`. */
	readonly clock?: () => number;
}

/** Installs and drives the reactivity origination hook on a {@link CohortTopicService}. */
export class ReactivityOriginationManager {
	private readonly service: CohortTopicService;
	private readonly resolveContext: (event: CollectionChangeEvent) => OriginationCollectionContext | undefined;
	private readonly emit: (notification: NotificationV1) => void;
	private readonly clock: () => number;

	constructor(options: ReactivityOriginationManagerOptions) {
		this.service = options.service;
		this.resolveContext = options.resolveContext;
		this.emit = options.emit;
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
				return; // not the origination point for this collection
			}
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
}
