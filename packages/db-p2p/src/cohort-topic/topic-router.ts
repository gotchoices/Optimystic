import type { ITopicRouter, PeerRef, RingCoord } from "@optimystic/db-core";
import { bytesToB64url, b64urlToBytes, encodeCohortMessage } from "@optimystic/db-core";
import type { Libp2p } from "libp2p";
import type { FretService, RouteAndMaybeActV1, NearAnchorV1 } from "p2p-fret";
import { bytesToPeerId } from "./peer-codec.js";
import { requestResponse, DEFAULT_STREAM_MAX_BYTES } from "./stream-util.js";
import { PROTOCOL_COHORT_REGISTER } from "./protocols.js";

/** A FRET `routeAct` result carrying a cohort reply. */
function isCommit(res: NearAnchorV1 | { commitCertificate: string }): res is { commitCertificate: string } {
	return typeof res === "object" && res !== null && "commitCertificate" in res;
}

export interface FretTopicRouterOptions {
	/** The `/register` protocol id (defaults to the canonical one). */
	readonly registerProtocol?: string;
	/** RPC TTL hops for `RouteAndMaybeAct`. Default 16. */
	readonly ttl?: number;
	/** Per-frame ceiling. Default {@link DEFAULT_STREAM_MAX_BYTES}. */
	readonly maxBytes?: number;
	/** Monotonic clock (unix ms); injectable for tests. Default `Date.now`. */
	readonly clock?: () => number;
}

/**
 * FRET-backed {@link ITopicRouter}.
 *
 * `routeAndAct` maps onto FRET's `RouteAndMaybeAct` (`FretService.routeAct`): the `RegisterV1` frame
 * rides the `activity` field (base64url), routed to the cohort owning `key = coord_d(self, topicId)`,
 * collecting `want_k = k` participants and `min_sigs = k − x`. The cohort's activity callback (set by
 * the host) runs the willingness / cold-start / admission decision and returns the encoded
 * `RegisterReplyV1` as the `commitCertificate`; this adapter decodes it back to bytes. A bare
 * `NearAnchorV1` (no in-cluster activity ran) is surfaced to the walk as `no_state`.
 *
 * `dialMember` is the post-registration direct path: a libp2p dial of the `/register` protocol to the
 * cached primary, used by the renewal ping (`docs/cohort-topic.md` §FRET integration L457-460).
 */
export class FretTopicRouter implements ITopicRouter {
	private readonly registerProtocol: string;
	private readonly ttl: number;
	private readonly maxBytes: number;
	private readonly clock: () => number;

	constructor(private readonly node: Libp2p, private readonly fret: FretService, options: FretTopicRouterOptions = {}) {
		this.registerProtocol = options.registerProtocol ?? PROTOCOL_COHORT_REGISTER;
		this.ttl = options.ttl ?? 16;
		this.maxBytes = options.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
		this.clock = options.clock ?? ((): number => Date.now());
	}

	async routeAndAct(key: RingCoord, activity: Uint8Array, opts: { wantK: number; minSigs: number }): Promise<Uint8Array> {
		const now = this.clock();
		const msg: RouteAndMaybeActV1 = {
			v: 1,
			key: bytesToB64url(key),
			want_k: opts.wantK,
			min_sigs: opts.minSigs,
			ttl: this.ttl,
			activity: bytesToB64url(activity),
			correlation_id: bytesToB64url(key) + ":" + now,
			timestamp: now,
			signature: "",
		};
		const res = await this.fret.routeAct(msg);
		if (isCommit(res)) {
			return b64urlToBytes(res.commitCertificate);
		}
		// No in-cluster activity ran (we only reached an anchor hint): the walk treats this as NoState
		// and steps toward the root.
		return encodeCohortMessage({ v: 1, result: "no_state" }, this.maxBytes);
	}

	async dialMember(member: PeerRef, activity: Uint8Array): Promise<Uint8Array> {
		const peer = bytesToPeerId(member.id);
		return requestResponse(this.node, peer, this.registerProtocol, activity, this.maxBytes);
	}
}
