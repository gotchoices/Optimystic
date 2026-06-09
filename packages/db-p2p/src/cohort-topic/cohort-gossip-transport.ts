import type { ICohortGossipTransport, PeerRef, RingCoord } from "@optimystic/db-core";
import type { Libp2p } from "libp2p";
import { peerIdFromString } from "@libp2p/peer-id";
import { peerIdToBytes } from "./peer-codec.js";
import { sendOneWay } from "./stream-util.js";
import { PROTOCOL_COHORT_GOSSIP } from "./protocols.js";

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
}

/**
 * FRET-backed {@link ICohortGossipTransport}: intra-cohort gossip over
 * `/optimystic/cohort-topic/1.0.0/cohort-gossip`. `broadcast` fans a frame out to the FRET-assembled
 * cohort for `coord` (fire-and-forget, self excluded); inbound frames arrive through the host's gossip
 * protocol handler, which calls {@link deliver}. Subscribers registered via `onMessage` see every
 * delivered frame.
 */
export class FretCohortGossipTransport implements ICohortGossipTransport {
	private readonly handlers = new Set<(from: PeerRef, msg: Uint8Array) => void>();
	private readonly gossipProtocol: string;
	private readonly wants: number;
	private readonly selfPeerId: string;

	constructor(private readonly node: Libp2p, private readonly resolver: CohortPeerResolver, options: FretCohortGossipTransportOptions) {
		this.gossipProtocol = options.gossipProtocol ?? PROTOCOL_COHORT_GOSSIP;
		this.wants = options.wants ?? 16;
		this.selfPeerId = options.selfPeerId;
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
			void sendOneWay(this.node, peerIdFromString(peerStr), protocol, msg).catch(() => {
				// Best-effort: a single unreachable member is recovered by the next round.
			});
		}
	}

	onMessage(handler: (from: PeerRef, msg: Uint8Array) => void): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	/** Feed an inbound gossip frame (called by the host's `/cohort-gossip` protocol handler). */
	deliver(fromPeerId: string, msg: Uint8Array): void {
		const from: PeerRef = { id: peerIdToBytes(fromPeerId) };
		for (const handler of this.handlers) {
			handler(from, msg);
		}
	}
}
