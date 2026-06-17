/**
 * Reactivity — `PushState` intra-cohort gossip driver (`docs/reactivity.md` §Replay window,
 * §Forwarder-cohort state).
 *
 * The forwarder-cohort replay ring + dedupe window are the substrate that makes the doc's "**any** cohort
 * member — not just the primary — can serve a replay/backfill" property real: a member that missed an
 * origin dial still ends up holding the entry, so a backfill (12.4) survives a primary failover. The
 * db-core {@link PushState} already owns the codec ({@link encodePushStateGossipV1} /
 * {@link decodePushStateGossipV1}, {@link PushState.serializeGossip} / {@link PushState.mergeGossip}); this
 * driver is the **replication** layer that actually broadcasts and merges that state over libp2p on a
 * periodic cadence — the backstop to the live fan-out ({@link import("./forwarder-host.js")}).
 *
 * **Transport reuse.** Rather than stand up a new transport, this rides the cohort gossip transport's
 * {@link import("../cohort-topic/cohort-gossip-transport.js").FretCohortGossipTransport.broadcastOver}
 * seam — the same one the promote-notice broadcast reuses — so the cohort peer resolution, self-exclusion,
 * and per-peer failure swallowing are shared. Frames ride the dedicated
 * {@link PROTOCOL_REACTIVITY_PUSH_STATE_GOSSIP} (one-way), fanned to the FRET-assembled cohort around each
 * served collection's cohort coord. Inbound frames arrive on this node's `push-state-gossip` protocol
 * handler (registered by the node-wiring ticket) and route to {@link ReactivityPushStateGossipDriver.deliver}.
 *
 * **Cadence.** Its own unref'd timer (parallel to the cohort host's single `setInterval`), reusing
 * {@link DEFAULT_GOSSIP_INTERVAL_MS} and the host's re-entrancy / `stopped` / `unref` discipline verbatim.
 * Reactivity collections are not 1:1 with the host's per-`CoordEngine` tick and the forwarder host owns the
 * live {@link PushState} set, so a separate timer is the clean seam now; a future consolidation could fold
 * this into the host tick via a hook, but a separate unref'd timer cannot pin an idle process.
 *
 * This module touches neither the libp2p node assembly nor FRET cohort assembly — it depends only on the
 * `broadcastOver` seam + db-core codec, so it is unit-testable with a fake transport and real `PushState`s.
 */

import {
	encodePushStateGossipV1,
	decodePushStateGossipV1,
	type PushState,
	type PushStateGossipV1,
	type RingCoord,
} from "@optimystic/db-core";
import type { FretCohortGossipTransport } from "../cohort-topic/cohort-gossip-transport.js";
import { DEFAULT_GOSSIP_INTERVAL_MS } from "../cohort-topic/cohort-gossip-driver.js";
import { DEFAULT_STREAM_MAX_BYTES } from "../cohort-topic/stream-util.js";
import { PROTOCOL_REACTIVITY_PUSH_STATE_GOSSIP } from "./protocols.js";
import { createLogger } from "../logger.js";

const log = createLogger("reactivity-push-state-gossip");

/** Encode a probe frame with no size ceiling so the driver can measure its true length before bounding. */
const NO_FRAME_LIMIT = Number.MAX_SAFE_INTEGER;

/** A live forwarder collection to gossip: its {@link PushState} and the cohort coord to broadcast to. */
export interface ReactivityGossipCollection {
	readonly pushState: PushState;
	readonly cohortCoord: RingCoord;
}

/** A truncation event: a collection's serialized replay ring exceeded the frame bound and was clipped. */
export interface PushStateGossipTruncation {
	readonly collectionId: string;
	readonly topicId: string;
	/** Most-recent replay entries kept in the broadcast frame. */
	readonly kept: number;
	/** Replay entries the ring actually held this round. */
	readonly total: number;
	/** Bytes of the broadcast (clipped) frame. */
	readonly frameBytes: number;
	/** The configured per-frame ceiling. */
	readonly maxBytes: number;
}

/** Construction inputs for a {@link ReactivityPushStateGossipDriver}. */
export interface ReactivityPushStateGossipDriverDeps {
	/** Reuse the node's cohort gossip transport (`broadcastOver`) — no new transport. */
	readonly gossipTransport: Pick<FretCohortGossipTransport, "broadcastOver">;
	/** The live forwarder collections to gossip each round, with the cohort coord to broadcast to. */
	readonly liveCollections: () => Iterable<ReactivityGossipCollection>;
	/** Resolve the collection owning an inbound frame (by collectionId/topicId) → its {@link PushState}, or undefined. */
	readonly pushStateForGossip: (g: PushStateGossipV1) => PushState | undefined;
	/** Inbound authenticity gate: is `fromPeerId` a member of the cohort for the frame's coord? Absent ⇒ accept all. */
	readonly isCohortMember?: (fromPeerId: string, g: PushStateGossipV1) => boolean;
	/** Cadence interval. Default {@link DEFAULT_GOSSIP_INTERVAL_MS}. */
	readonly intervalMs?: number;
	/** Per-frame ceiling (frame, including the length prefix, stays within this). Default {@link DEFAULT_STREAM_MAX_BYTES}. */
	readonly maxBytes?: number;
	/** Reserved for parity with the cohort host's tick discipline; unused today (gossip carries its own `receivedAt`). */
	readonly clock?: () => number;
	/** Observe a clipped (over-bound) frame, in addition to the "no silent cap" log. Test/diagnostic seam. */
	readonly onTruncate?: (info: PushStateGossipTruncation) => void;
}

/**
 * Drives {@link PushState} convergence across a forwarder cohort: each round it broadcasts every live
 * collection's serialized push-state to the cohort (clipped to the frame bound), and each inbound frame is
 * gated, resolved to the owning collection, and merged. Build one per node and bind its inbound
 * {@link ReactivityPushStateGossipDriver.deliver} to the `push-state-gossip` protocol handler.
 */
export class ReactivityPushStateGossipDriver {
	private readonly gossipTransport: Pick<FretCohortGossipTransport, "broadcastOver">;
	private readonly liveCollections: () => Iterable<ReactivityGossipCollection>;
	private readonly pushStateForGossip: (g: PushStateGossipV1) => PushState | undefined;
	private readonly isCohortMember?: (fromPeerId: string, g: PushStateGossipV1) => boolean;
	private readonly intervalMs: number;
	private readonly maxBytes: number;
	private readonly onTruncate?: (info: PushStateGossipTruncation) => void;

	private timer?: ReturnType<typeof setInterval>;
	private stopped = false;
	/** Re-entrancy guard mirroring the host tick: skip a round that overlaps a slow prior one. */
	private rounding = false;

	constructor(deps: ReactivityPushStateGossipDriverDeps) {
		this.gossipTransport = deps.gossipTransport;
		this.liveCollections = deps.liveCollections;
		this.pushStateForGossip = deps.pushStateForGossip;
		this.isCohortMember = deps.isCohortMember;
		this.intervalMs = deps.intervalMs ?? DEFAULT_GOSSIP_INTERVAL_MS;
		this.maxBytes = deps.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
		this.onTruncate = deps.onTruncate;
	}

	/** Begin the unref'd cadence timer. Idempotent; a no-op once {@link stop} has run. */
	start(): void {
		if (this.stopped || this.timer !== undefined) {
			return;
		}
		const timer = setInterval((): void => {
			this.round();
		}, this.intervalMs);
		// Node timers keep the event loop alive; push-state gossip must not pin a process that is otherwise idle.
		(timer as { unref?: () => void }).unref?.();
		this.timer = timer;
	}

	/**
	 * One round: broadcast each live collection's serialized {@link PushState} to its cohort, clipped to the
	 * frame bound. Per-collection isolated (one collection's fault never skips the rest) and `stopped`-gated
	 * mid-loop, mirroring the host tick.
	 */
	round(): void {
		if (this.stopped || this.rounding) {
			return;
		}
		this.rounding = true;
		try {
			for (const { pushState, cohortCoord } of this.liveCollections()) {
				if (this.stopped) {
					break;
				}
				try {
					this.broadcastOne(pushState, cohortCoord);
				} catch (err) {
					log("push-state gossip round failed for a collection (isolated): %o", err);
				}
			}
		} finally {
			this.rounding = false;
		}
	}

	/**
	 * Inbound handler body: decode → membership gate → resolve owning collection → merge. Never throws on a
	 * bad frame (a malformed/forged/foreign frame is logged and dropped), so a stream handler can call it
	 * directly. `mergeGossip` independently guards a collection/topic mismatch, so the resolve step is a fast
	 * pre-filter, not the only line of defense.
	 */
	deliver(fromPeerId: string, frame: Uint8Array): void {
		let g: PushStateGossipV1;
		try {
			g = decodePushStateGossipV1(frame, this.maxBytes);
		} catch (err) {
			log("dropped an undecodable push-state gossip frame from %s: %o", fromPeerId, err);
			return;
		}
		if (this.isCohortMember !== undefined && !this.isCohortMember(fromPeerId, g)) {
			log("dropped push-state gossip from non-member %s for collection=%s topic=%s", fromPeerId, g.collectionId, g.topicId);
			return;
		}
		const pushState = this.pushStateForGossip(g);
		if (pushState === undefined) {
			return; // gossip for a collection this node does not serve — nothing to merge into.
		}
		try {
			pushState.mergeGossip(g);
		} catch (err) {
			log("push-state mergeGossip threw (isolated) for collection=%s: %o", g.collectionId, err);
		}
	}

	/** Stop the cadence: short-circuit any in-flight/future round and clear the timer. */
	stop(): void {
		this.stopped = true;
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/** Serialize one collection, clip to the frame bound, and broadcast to its cohort. */
	private broadcastOne(pushState: PushState, cohortCoord: RingCoord): void {
		const g = pushState.serializeGossip();
		const { frame, kept, total } = this.boundedFrame(g);
		if (kept < total) {
			// "No silent caps" (AGENTS.md): a clipped ring is always surfaced. Convergence still completes —
			// each entry replicates while it is within the most-recent window across successive rounds, and
			// `mergeGossip` unions ring entries so a partial frame loses nothing already held by a peer.
			log("push-state gossip frame clipped for collection=%s: kept %d/%d most-recent replay entries to fit maxBytes=%d", g.collectionId, kept, total, this.maxBytes);
			this.onTruncate?.({ collectionId: g.collectionId, topicId: g.topicId, kept, total, frameBytes: frame.length, maxBytes: this.maxBytes });
		}
		this.gossipTransport.broadcastOver(PROTOCOL_REACTIVITY_PUSH_STATE_GOSSIP, cohortCoord, frame);
	}

	/**
	 * Build the broadcast frame for one serialized push-state, kept within {@link maxBytes}.
	 *
	 * The whole replay ring (`W` up to 256 full `NotificationV1`s) can exceed the frame bound. When it does,
	 * keep the full (small) dedupe window and the **most-recent-N** replay entries that fit — sliced from the
	 * high-revision end, since a lagging subscriber backfills the newest gap first and older revisions roll
	 * to the parent checkpoint anyway. Frame size is monotone in the entry count, so binary-search the
	 * high-water N rather than re-encoding per entry.
	 */
	private boundedFrame(g: PushStateGossipV1): { frame: Uint8Array; kept: number; total: number } {
		const total = g.replayBuffer.entries.length;
		const full = encodePushStateGossipV1(g, NO_FRAME_LIMIT);
		if (full.length <= this.maxBytes) {
			return { frame: full, kept: total, total };
		}
		// Largest most-recent-N replay slice whose frame still fits. `encodeSlice(g, 0)` (dedupe window only)
		// is the floor we ship if even that overruns the bound (pathological — the dedupe window is small).
		let lo = 0;
		let hi = total;
		let bestN = 0;
		let bestFrame = this.encodeSlice(g, 0);
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			const frame = this.encodeSlice(g, mid);
			if (frame.length <= this.maxBytes) {
				bestN = mid;
				bestFrame = frame;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		return { frame: bestFrame, kept: bestN, total };
	}

	/** Encode `g` with only its most-recent `keep` replay entries retained (the full dedupe window is kept). */
	private encodeSlice(g: PushStateGossipV1, keep: number): Uint8Array {
		const entries = g.replayBuffer.entries;
		const kept = keep >= entries.length ? entries : entries.slice(entries.length - keep);
		const sliced: PushStateGossipV1 = {
			...g,
			replayBuffer: { capacity: g.replayBuffer.capacity, entries: kept },
		};
		return encodePushStateGossipV1(sliced, NO_FRAME_LIMIT);
	}
}
