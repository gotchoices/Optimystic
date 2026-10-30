import type { CohortGossipV1, ICohortGossipTransport, RingCoord } from "@optimystic/db-core";
import { b64urlToBytes, bytesKey } from "@optimystic/db-core";
import type { Libp2p } from "libp2p";
import { peerIdFromString } from "@libp2p/peer-id";
import { sendOneWay } from "./stream-util.js";
import { PROTOCOL_COHORT_GOSSIP } from "./protocols.js";
import type { StreamOpenDeadlines } from "../rpc-deadline.js";

/** Resolves the cohort owning a coord to its libp2p peer-id strings (FRET two-sided assembly). */
export interface CohortPeerResolver {
	/** Peer-id strings of the cohort owning `coord`, up to `wants` members. */
	cohortPeers(coord: RingCoord, wants: number): string[];
}

export interface FretCohortGossipTransportOptions {
	readonly gossipProtocol?: string;
	/** Cohort fan-out for a broadcast. Default 16. */
	readonly wants?: number;
	/** This node's peer-id string — excluded from its own broadcasts. */
	readonly selfPeerId: string;
	/** The stream-open delays for each member's dial (`sendOneWay` in `stream-util.ts`); the node's where the host has them. */
	readonly streamOpen?: StreamOpenDeadlines;
}

type GossipHandler = (g: CohortGossipV1) => void;

/**
 * FRET-backed {@link ICohortGossipTransport}: intra-cohort gossip over
 * `/optimystic/cohort-topic/1.0.0/cohort-gossip`. `broadcast` fans a frame out to the FRET-assembled
 * cohort for `coord` (fire-and-forget, self excluded). Inbound frames arrive through the host's gossip
 * protocol handler, which decodes each one once, authenticates it, and calls {@link deliver}; the frame
 * then reaches only the subscribers registered via `onGossip` under the coord it names.
 */
export class FretCohortGossipTransport implements ICohortGossipTransport {
	/** Subscribers per coord, keyed by {@link bytesKey}; a coord with none has no entry. */
	private readonly subscribers = new Map<string, Set<GossipHandler>>();
	private readonly gossipProtocol: string;
	private readonly wants: number;
	private readonly selfPeerId: string;
	private readonly streamOpen: StreamOpenDeadlines | undefined;

	constructor(private readonly node: Libp2p, private readonly resolver: CohortPeerResolver, options: FretCohortGossipTransportOptions) {
		this.gossipProtocol = options.gossipProtocol ?? PROTOCOL_COHORT_GOSSIP;
		this.wants = options.wants ?? 16;
		this.selfPeerId = options.selfPeerId;
		this.streamOpen = options.streamOpen;
	}

	broadcast(coord: RingCoord, msg: Uint8Array): void {
		this.broadcastOver(this.gossipProtocol, coord, msg);
	}

	/**
	 * Fan `msg` out to the FRET-assembled cohort for `coord` over an arbitrary one-way `protocol` (self
	 * excluded, fire-and-forget). Reuses the cohort peer resolution so the `promote` protocol's
	 * promotion/demotion notice broadcast shares the gossip transport's wiring; a single unreachable
	 * member is recovered by the cohort's next convergence round, so per-peer failures are swallowed.
	 */
	broadcastOver(protocol: string, coord: RingCoord, msg: Uint8Array): void {
		for (const peerStr of this.resolver.cohortPeers(coord, this.wants)) {
			if (peerStr === this.selfPeerId) {
				continue;
			}
			void sendOneWay(this.node, peerIdFromString(peerStr), protocol, msg, this.streamOpen).catch(() => {
				// Best-effort: a single unreachable member is recovered by the next round.
			});
		}
	}

	onGossip(coord: RingCoord, handler: GossipHandler): () => void {
		const key = bytesKey(coord);
		let handlers = this.subscribers.get(key);
		if (handlers === undefined) {
			handlers = new Set();
			this.subscribers.set(key, handlers);
		}
		handlers.add(handler);
		return (): void => {
			const held = this.subscribers.get(key);
			if (held !== undefined && held.delete(handler) && held.size === 0) {
				this.subscribers.delete(key);
			}
		};
	}

	/**
	 * True iff some bus is subscribed under `coord`. A plain map lookup: it touches no engine, so asking it of an
	 * unauthenticated frame bumps nothing's eviction recency.
	 */
	hasSubscriber(coord: RingCoord): boolean {
		return this.subscribers.has(bytesKey(coord));
	}

	/**
	 * Number of live inbound subscriptions over all coords (one per subscribed gossip bus). Test/diagnostic
	 * introspection: each {@link CoordEngine}'s bus subscribes via {@link onGossip} and drops its subscription on
	 * `close()`, so this tracks the number of live coord engines (+ the node-level participant bus) — used to
	 * observe that the coord-engine registry's LRU eviction actually tears evicted engines down (no leaked
	 * subscriptions).
	 */
	get subscriberCount(): number {
		let count = 0;
		for (const handlers of this.subscribers.values()) {
			count += handlers.size;
		}
		return count;
	}

	/**
	 * Hand a decoded, already-authenticated inbound frame to the subscribers of the coord it names (called by the
	 * host's `/cohort-gossip` protocol handler). A frame for a coord nobody subscribes to reaches no one.
	 */
	deliver(g: CohortGossipV1): void {
		const handlers = this.subscribers.get(bytesKey(b64urlToBytes(g.coord)));
		if (handlers === undefined) {
			return;
		}
		for (const handler of handlers) {
			handler(g);
		}
	}
}
