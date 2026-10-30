import type { ITopicRouter, PeerRef, TopicRouteKey } from "@optimystic/db-core";
import { bytesToB64url, b64urlToBytes, encodeCohortMessage, RenewBatchUnsupportedError } from "@optimystic/db-core";
import type { Libp2p } from "libp2p";
import { peerIdFromString } from "@libp2p/peer-id";
import { randomBytes } from "@libp2p/crypto";
import type { FretService, RouteAndMaybeActV1, NearAnchorV1 } from "p2p-fret";
import { bytesToPeerId } from "./peer-codec.js";
import { requestResponse, requireReply, DEFAULT_STREAM_MAX_BYTES, type NoResultReplyError } from "./stream-util.js";
import { PROTOCOL_COHORT_REGISTER, PROTOCOL_COHORT_RENEW_BATCH } from "./protocols.js";
import { isUnsupportedProtocolError } from "../network/open-protocol-stream.js";
import { createLogger } from "../logger.js";
import type { StreamOpenDeadlines } from "../rpc-deadline.js";

const log = createLogger("cohort-topic");

/** A FRET `routeAct` result carrying a cohort reply. */
function isCommit(res: NearAnchorV1 | { commitCertificate: string }): res is { commitCertificate: string } {
	return typeof res === "object" && res !== null && "commitCertificate" in res;
}

export interface FretTopicRouterOptions {
	/** The `/register` protocol id (defaults to the canonical one). */
	readonly registerProtocol?: string;
	/** The `/renew-batch` protocol id (defaults to the canonical one). */
	readonly renewBatchProtocol?: string;
	/** RPC TTL hops for `RouteAndMaybeAct`. Default 16. */
	readonly ttl?: number;
	/** Per-frame ceiling. Default {@link DEFAULT_STREAM_MAX_BYTES}. */
	readonly maxBytes?: number;
	/** Monotonic clock (unix ms); injectable for tests. Default `Date.now`. */
	readonly clock?: () => number;
	/**
	 * The root group of a root-placed topic, by root key: the peer-id strings responsible for the key under
	 * the rule storage placement uses, in the order to try them. Supplying it gives the router a
	 * {@link ITopicRouter.routeToRoot}; omitting it leaves that method absent, so the walk falls back to ring
	 * routing on the root key, which reaches the ring's nearest peers to the root coordinate `H(rootKey)` —
	 * the group itself unless the ring is shared with another network (see `routeToTier` in
	 * `packages/db-core/src/cohort-topic/walk.ts`). The host binds it to its root-group option, keyed by the
	 * coordinate `H(rootKey)`.
	 */
	readonly rootGroupMembers?: (rootKey: Uint8Array) => Promise<readonly string[]>;
	/**
	 * This node's own peer-id string. With {@link handleLocally}, every direct dial addressed to this node — a
	 * {@link FretTopicRouter.dialMember} to a primary that is this node, or a root-group member that is — is
	 * served in process rather than dialed. libp2p refuses a self-dial, so without it a node that is the
	 * primary of its own registration fails every renewal ping, and a `clusterSize: 1` deployment (whose root
	 * group is this node alone) could never register at its own root.
	 */
	readonly selfPeerId?: string;
	/** The `/register` body this node runs for a frame addressed to itself (see {@link selfPeerId}). */
	readonly handleLocally?: (activity: Uint8Array) => Promise<Uint8Array>;
	/** The `/renew-batch` body this node runs for a batch addressed to itself (see {@link selfPeerId}). */
	readonly handleRenewBatchLocally?: (frame: Uint8Array) => Promise<Uint8Array>;
	/** The stream-open delays for the direct dials (`requestResponse` in `stream-util.ts`); the node's where the host has them. */
	readonly streamOpen?: StreamOpenDeadlines;
}

/**
 * FRET-backed {@link ITopicRouter}.
 *
 * `routeAndAct` maps onto FRET's `RouteAndMaybeAct` (`FretService.routeAct`): the `RegisterV1` frame
 * rides the `activity` field (base64url), and `key` is the tier's route key — the bytes `coord_d(self,
 * topicId)` is the hash of — because FRET hashes the key it is handed into the ring position it routes to,
 * at the origin and at every forwarding hop. The frame therefore lands at `coord_d`, collecting
 * `want_k = k` participants and `min_sigs = k − x`. The cohort's activity callback (set by
 * the host) runs the willingness / cold-start / admission decision and returns the encoded
 * `RegisterReplyV1` as the `commitCertificate`; this adapter decodes it back to bytes. A bare
 * `NearAnchorV1` (no in-cluster activity ran) is surfaced to the walk as `no_state`.
 *
 * `dialMember` is the post-registration direct path: a libp2p dial of the `/register` protocol to the
 * cached primary, used by the renewal ping (`docs/cohort-topic.md` §FRET integration). A primary that is this
 * node is answered in process (see {@link FretTopicRouterOptions.selfPeerId}). `dialMemberRenewBatch` is the
 * same path for several plain pings to one primary, over `/renew-batch`.
 *
 * `routeToRoot` — present only when the router was given {@link FretTopicRouterOptions.rootGroupMembers} —
 * is the tier-0 step of a root-placed topic (`docs/cohort-topic.md` §Root placement at a routing key). It
 * is deliberately **not** built on `routeAndAct`: ring routing on the root key reaches the ring's nearest
 * peers to `H(rootKey)`, which on a ring shared with another network may be that network's peers rather
 * than the storage group. Instead it resolves the group by the rule that chose it and dials each member's
 * `/register` directly, in order, returning the first reply it gets — including an `unwilling_member`,
 * which the walk's own member retry then acts on.
 */
export class FretTopicRouter implements ITopicRouter {
	private readonly registerProtocol: string;
	private readonly renewBatchProtocol: string;
	private readonly ttl: number;
	private readonly maxBytes: number;
	private readonly clock: () => number;
	private readonly selfPeerId: string | undefined;
	private readonly handleLocally: ((activity: Uint8Array) => Promise<Uint8Array>) | undefined;
	private readonly handleRenewBatchLocally: ((frame: Uint8Array) => Promise<Uint8Array>) | undefined;
	private readonly streamOpen: StreamOpenDeadlines | undefined;
	readonly routeToRoot?: (rootKey: Uint8Array, activity: Uint8Array) => Promise<Uint8Array>;

	constructor(private readonly node: Libp2p, private readonly fret: FretService, options: FretTopicRouterOptions = {}) {
		this.registerProtocol = options.registerProtocol ?? PROTOCOL_COHORT_REGISTER;
		this.renewBatchProtocol = options.renewBatchProtocol ?? PROTOCOL_COHORT_RENEW_BATCH;
		this.ttl = options.ttl ?? 16;
		this.maxBytes = options.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
		this.clock = options.clock ?? ((): number => Date.now());
		this.selfPeerId = options.selfPeerId;
		this.handleLocally = options.handleLocally;
		this.handleRenewBatchLocally = options.handleRenewBatchLocally;
		this.streamOpen = options.streamOpen;
		const rootGroupMembers = options.rootGroupMembers;
		if (rootGroupMembers !== undefined) {
			this.routeToRoot = (rootKey, activity): Promise<Uint8Array> => this.dialRootGroup(rootGroupMembers, rootKey, activity);
		}
	}

	async routeAndAct(key: TopicRouteKey, activity: Uint8Array, opts: { wantK: number; minSigs: number }): Promise<Uint8Array> {
		const now = this.clock();
		const msg: RouteAndMaybeActV1 = {
			v: 1,
			key: bytesToB64url(key),
			want_k: opts.wantK,
			min_sigs: opts.minSigs,
			ttl: this.ttl,
			activity: bytesToB64url(activity),
			// A fresh nonce, not the key: FRET answers a repeated `correlation_id` from its dedup cache, so a key-
			// derived id hands one participant's reply to another routing the same tier in the same millisecond, and
			// FRET refuses an id over 256 characters at every forwarding hop, which a long root key would exceed.
			correlation_id: bytesToB64url(randomBytes(16)) + ":" + now,
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

	/**
	 * Dial `member`'s `/register` directly and return its encoded reply. A `member` that is this node is served
	 * in process through {@link FretTopicRouterOptions.handleLocally} when the router was given it, exactly as
	 * an inbound `/register` frame is; a throw there is a fault of the frame, not of a link, and propagates.
	 *
	 * The `/register` responder always writes a frame, so a no-result (zero-length) reply only comes from a
	 * non-conforming peer; it rejects with {@link NoResultReplyError}, reaching the caller exactly as a dial
	 * failure does (renewal counts a failed ping; the walk's direct dial propagates the rejection). db-core's {@link ITopicRouter.dialMember} port deliberately stays
	 * `Promise<Uint8Array>` rather than widening to `| undefined`: that would ripple through the walk and
	 * renewal decision logic for a state only a misbehaving peer can produce, so the decision is made here.
	 */
	async dialMember(member: PeerRef, activity: Uint8Array): Promise<Uint8Array> {
		const peer = bytesToPeerId(member.id);
		if (this.handleLocally !== undefined && peer.toString() === this.selfPeerId) {
			return this.handleLocally(activity);
		}
		const reply = await requestResponse(this.node, peer, this.registerProtocol, activity, this.maxBytes, this.streamOpen);
		return requireReply(reply, "cohort-topic register dial");
	}

	/**
	 * Dial `member`'s `/renew-batch` with an encoded `RenewBatchV1` and return its encoded reply. A member that
	 * refuses the protocol at negotiation (a build that predates it) rejects with `RenewBatchUnsupportedError`, so
	 * the caller sends the same pings singly over `/register`; any other failure rejects as {@link dialMember}'s
	 * does. A `member` that is this node is served in process through
	 * {@link FretTopicRouterOptions.handleRenewBatchLocally}; a router given no such handler answers a self-addressed
	 * batch as unsupported, so its pings go singly through {@link dialMember}'s own self path.
	 */
	async dialMemberRenewBatch(member: PeerRef, frame: Uint8Array): Promise<Uint8Array> {
		const peer = bytesToPeerId(member.id);
		if (peer.toString() === this.selfPeerId) {
			if (this.handleRenewBatchLocally === undefined) {
				throw new RenewBatchUnsupportedError(member.id);
			}
			return this.handleRenewBatchLocally(frame);
		}
		let reply: Uint8Array | undefined;
		try {
			reply = await requestResponse(this.node, peer, this.renewBatchProtocol, frame, this.maxBytes, this.streamOpen);
		} catch (err) {
			// NOTE: `openProtocolStream` treats a negotiation refusal like any failed path and tries a forced fresh dial
			// before rejecting, so each refusal leaves one extra connection to the older member (measured: 1 → 2 on two
			// local nodes). The participant asks an older member at most once per `RENEW_BATCH_UNSUPPORTED_RECHECK_MS`;
			// if those connections ever show up, have the stream opener stop at a negotiation refusal.
			if (isUnsupportedProtocolError(err)) {
				throw new RenewBatchUnsupportedError(member.id, { cause: err });
			}
			throw err;
		}
		return requireReply(reply, "cohort-topic renew-batch dial");
	}

	/**
	 * Deliver `activity` to the first root-group member that answers. A member that cannot be reached, or
	 * that writes no result frame, is skipped for the next; any reply frame is returned as-is. When the group
	 * resolves empty or nobody answers, the walk is told `unwilling_cohort` so the participant backs off in
	 * time and retries — the shape every other transient refusal takes — rather than failing the register.
	 * A member that is this node is served in process (a throw there is a fault of the frame, not of a
	 * link, and propagates).
	 */
	private async dialRootGroup(rootGroupMembers: (rootKey: Uint8Array) => Promise<readonly string[]>, rootKey: Uint8Array, activity: Uint8Array): Promise<Uint8Array> {
		const members = await rootGroupMembers(rootKey);
		for (const peerStr of members) {
			if (peerStr === this.selfPeerId && this.handleLocally !== undefined) {
				return this.handleLocally(activity);
			}
			try {
				const reply = await requestResponse(this.node, peerIdFromString(peerStr), this.registerProtocol, activity, this.maxBytes, this.streamOpen);
				if (reply !== undefined) {
					return reply;
				}
			} catch (err) {
				log("cohort-topic: root-group member %s did not answer the root step: %o", peerStr, err);
			}
		}
		log("cohort-topic: no root-group member answered (%d dialed) — telling the walk to back off", members.length);
		return encodeCohortMessage({ v: 1, result: "unwilling_cohort", reason: "root group unreachable" }, this.maxBytes);
	}
}
