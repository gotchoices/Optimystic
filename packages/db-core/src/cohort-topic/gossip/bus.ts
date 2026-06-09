/**
 * Cohort-topic substrate — intra-cohort gossip bus.
 *
 * Per `docs/cohort-topic.md` §Cohort gossip. Each member periodically broadcasts a `CohortGossipV1`
 * carrying its willingness vector, load buckets, exact per-topic summaries, and any registration
 * record deltas (new/touched records + evictions). The bus:
 *
 * - **broadcasts** outbound gossip over the injected {@link ICohortGossipTransport} (FRET cohort
 *   gossip underneath — db-core never imports FRET);
 * - **routes by coord**: a delivered frame is fanned to every coord engine's bus on a node, so each
 *   bus merges only the gossip whose `coord` names its own cohort (epoch alone never isolates two
 *   coords — they can share a member set, hence an epoch);
 * - **merges inbound** gossip — record deltas into the {@link RegistrationStore} (last-writer-wins
 *   by `lastPing`; evictions remove), and willingness/load/summaries into the per-member
 *   {@link CohortView};
 * - **detects epoch drift**: an inbound `cohortEpoch` that differs from the local epoch fires the
 *   drift handlers, and record deltas under a foreign epoch are *not* merged (their slot
 *   assignments belong to a different membership snapshot);
 * - **optionally authenticates** inbound transport frames via an injected {@link GossipInboundVerifier}
 *   (db-p2p binds peer-sig + cohort membership), dropping forged or non-member gossip before any merge.
 *
 * Convergence target (doc): a single gossip round spreads a touched record / willingness flip to all
 * members — one {@link CohortGossipBus.applyInbound} of that gossip makes it visible locally.
 */

import { bytesEqual } from "../registration/bytes.js";
import type { RegistrationStore } from "../registration/types.js";
import type { ICohortGossipTransport, PeerRef, RingCoord } from "../ports.js";
import { b64urlToBytes, decodeCohortGossipV1, encodeCohortMessage } from "../wire/codec.js";
import type { CohortGossipV1 } from "../wire/types.js";
import { fromGossipRecord } from "./records.js";
import { createCohortView, type CohortView, type MutableCohortView } from "./view.js";

/** Handler for inbound gossip (after merge). */
export type GossipHandler = (g: CohortGossipV1) => void;
/** Handler for a detected cohort-epoch drift on an inbound gossip. */
export type DriftHandler = (inboundEpoch: Uint8Array, localEpoch: Uint8Array, from: string) => void;
/** Authenticity gate for an inbound gossip arriving over the transport — `false` drops the frame. */
export type GossipInboundVerifier = (g: CohortGossipV1) => boolean;

export interface CohortGossipBusDeps {
	/** FRET-backed cohort gossip transport (broadcast / subscribe). */
	transport: ICohortGossipTransport;
	/** Local registration store record deltas merge into. */
	store: RegistrationStore;
	/** This cohort's coord — the broadcast key **and** the inbound routing key (see {@link CohortGossipV1.coord}). */
	coord: RingCoord;
	/** The local cohort epoch, read fresh each merge so rotation is observed. */
	localEpoch: () => Uint8Array;
	/** Wall clock for inbound merges via the transport path; injectable for tests. */
	now?: () => number;
	/** Frame ceiling for encode/decode (defaults to the codec default). */
	maxMessageBytes?: number;
	/**
	 * Optional authenticity gate run on every gossip arriving over the transport (db-p2p binds it to the
	 * peer-sig primitive: verify `fromMember`'s signature over the gossip image **and** that `fromMember`
	 * is a member of this coord's cohort). A `false` verdict drops the frame — no merge, no handler fire —
	 * so a forged or non-member gossip can neither spoof willingness/load nor replicate fake records.
	 * Absent → the gate is skipped (unit tests / key-less interim mode); the `coord` routing check below
	 * still runs regardless. Not applied to direct {@link CohortGossipBus.applyInbound} calls (the trusted
	 * test/internal merge entry point).
	 */
	verifyInbound?: GossipInboundVerifier;
}

/** Intra-cohort gossip bus (merge logic over an injected transport). */
export interface CohortGossipBus {
	/** Broadcast `g` to the cohort. */
	broadcast(g: CohortGossipV1): void;
	/** Subscribe to inbound gossip (fired after merge); returns an unsubscribe handle. */
	onGossip(handler: GossipHandler): () => void;
	/** Subscribe to epoch-drift detections; returns an unsubscribe handle. */
	onDrift(handler: DriftHandler): () => void;
	/** Merge one inbound gossip: records/willingness/load, with epoch drift detection. */
	applyInbound(g: CohortGossipV1, now: number): void;
	/** The merged per-member view (willingness / load / summaries). */
	view(): CohortView;
	/** Detach the transport subscription. */
	close(): void;
}

class TransportCohortGossipBus implements CohortGossipBus {
	private readonly gossipHandlers = new Set<GossipHandler>();
	private readonly driftHandlers = new Set<DriftHandler>();
	private readonly memberView: MutableCohortView = createCohortView();
	private readonly now: () => number;
	private readonly detach: () => void;

	constructor(private readonly deps: CohortGossipBusDeps) {
		this.now = deps.now ?? ((): number => Date.now());
		this.detach = deps.transport.onMessage((_from: PeerRef, msg: Uint8Array) => this.onInbound(msg));
	}

	broadcast(g: CohortGossipV1): void {
		this.deps.transport.broadcast(this.deps.coord, encodeCohortMessage(g, this.deps.maxMessageBytes));
	}

	onGossip(handler: GossipHandler): () => void {
		this.gossipHandlers.add(handler);
		return () => this.gossipHandlers.delete(handler);
	}

	onDrift(handler: DriftHandler): () => void {
		this.driftHandlers.add(handler);
		return () => this.driftHandlers.delete(handler);
	}

	applyInbound(g: CohortGossipV1, now: number): void {
		// Coord routing: a frame is fanned to every coord engine's bus, but it belongs only to the bus
		// whose coord it names. Drop any gossip for another cohort so it cannot merge into this store/view
		// (two coords on one node can even share a member set — and thus an epoch — so epoch alone never
		// isolates them).
		if (!this.isOurCoord(g)) {
			return;
		}
		const localEpoch = this.deps.localEpoch();
		const inboundEpoch = b64urlToBytes(g.cohortEpoch);
		const epochMatches = bytesEqual(inboundEpoch, localEpoch);
		if (!epochMatches) {
			for (const handler of this.driftHandlers) {
				handler(inboundEpoch, localEpoch, g.fromMember);
			}
		}
		this.mergeView(g, inboundEpoch);
		if (epochMatches) {
			this.mergeRecords(g, now);
		}
	}

	view(): CohortView {
		return this.memberView;
	}

	close(): void {
		this.detach();
	}

	private onInbound(msg: Uint8Array): void {
		const g = decodeCohortGossipV1(msg, this.deps.maxMessageBytes);
		// Cheap routing check first so a non-matching coord skips the (expensive) signature verify.
		if (!this.isOurCoord(g)) {
			return;
		}
		// Authenticity gate (db-p2p binds peer-sig + cohort membership); a forged/non-member gossip is
		// dropped before any merge or handler fire. Absent in key-less/unit composition.
		if (this.deps.verifyInbound !== undefined && !this.deps.verifyInbound(g)) {
			return;
		}
		this.applyInbound(g, this.now());
		for (const handler of this.gossipHandlers) {
			handler(g);
		}
	}

	/** True iff `g` names this bus's cohort coord (the inbound routing key). */
	private isOurCoord(g: CohortGossipV1): boolean {
		return bytesEqual(b64urlToBytes(g.coord), this.deps.coord);
	}

	private mergeView(g: CohortGossipV1, inboundEpoch: Uint8Array): void {
		this.memberView.merge(g.fromMember, {
			cohortEpoch: inboundEpoch,
			willingness: parseInt(g.willingnessBits, 16),
			loadBuckets: g.loadBuckets,
			windowSeconds: g.windowSeconds,
			topicSummaries: g.topicSummaries,
			timestamp: g.timestamp,
		});
	}

	private mergeRecords(g: CohortGossipV1, now: number): void {
		for (const gr of g.records ?? []) {
			const incoming = fromGossipRecord(gr);
			// A record already past its TTL is dead; merging it would resurrect a registration the
			// owner has (or soon will have) evicted. Drop it, matching `store.evictStale`'s predicate
			// so replication can never reintroduce what local eviction removes.
			if (now - incoming.lastPing > incoming.ttl) {
				continue;
			}
			const held = this.deps.store.getByParticipant(incoming.topicId, incoming.participantId);
			// Last-writer-wins by lastPing: a touch (newer lastPing) replaces an older replica.
			if (held === undefined || incoming.lastPing >= held.lastPing) {
				this.deps.store.put(incoming);
			}
		}
		for (const ref of g.evicted ?? []) {
			this.deps.store.delete(b64urlToBytes(ref.topicId), b64urlToBytes(ref.participantId));
		}
	}
}

/** Build a {@link CohortGossipBus} over the injected transport + store. */
export function createCohortGossipBus(deps: CohortGossipBusDeps): CohortGossipBus {
	return new TransportCohortGossipBus(deps);
}
