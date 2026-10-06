/**
 * Matchmaking — the libp2p delivery an {@link import("./arrival-push-driver.js").ArrivalPushDriver} sends
 * through (db-p2p).
 *
 * `docs/matchmaking.md` §Push channel. A push is addressed to the seeker's `contactHint`, whose format the
 * doc leaves to the application. This binding reads the two forms this codebase produces: a bare peer-id
 * string (the libp2p seeker transport's default, its own peer id) and a multiaddr whose last component is
 * `/p2p/<id>` (what the mesh harness advertises, and what a seeker reachable only through a relay must
 * advertise: its circuit address, `…/p2p/<relay>/p2p-circuit/p2p/<seeker>`). Any other hint is logged and the
 * push dropped, which the driver treats like any failed delivery.
 *
 * A multiaddr hint is merged into the peerStore before the dial, through the one address-book writer
 * ({@link mergePeerAddresses}, which caps addresses per peer). The hint is whatever the seeker put in its
 * registration, so it is attacker-supplied, but a merged address only makes a dial attempt possible: the
 * dialed peer still authenticates by peer id at the handshake. That is the trust boundary
 * `ClusterRecord.peers` addresses already sit on (`docs/internals.md` §Third-Party Address Learning).
 *
 * A seeker on this node — its slot primary is its own node — is delivered to in process through the node's
 * {@link ArrivalPushReceiver}, with no dial: libp2p cannot dial self.
 */

import type { Libp2p } from "libp2p";
import type { PeerId } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import { requestResponse, DEFAULT_STREAM_MAX_BYTES } from "../cohort-topic/stream-util.js";
import { createLogger } from "../logger.js";
import { mergePeerAddresses } from "../peer-address-book.js";
import type { StreamOpenDeadlines } from "../rpc-deadline.js";
import type { ArrivalPushDriverDeps } from "./arrival-push-driver.js";
import type { ArrivalPushReceiver } from "./arrival-push-receiver.js";

const defaultLog = createLogger("matchmaking:arrival-push");

type Log = (formatter: string, ...args: unknown[]) => void;

/** Construction inputs for {@link createArrivalPushSend}. */
export interface ArrivalPushSendDeps {
	/** The node pushes are dialed from; its peer id decides which hints are delivered in process. */
	readonly node: Libp2p;
	/** The node's own receiver, for a seeker whose contact hint names this node. */
	readonly receiver: Pick<ArrivalPushReceiver, "receive">;
	/** The arrival-push protocol id (`MatchmakingProtocols.arrivalPush`). */
	readonly protocol: string;
	/** Per-frame ceiling for the ack; default {@link DEFAULT_STREAM_MAX_BYTES}. */
	readonly maxBytes?: number;
	/** The hedge and dead-connection delays the dial's stream open runs under (the node's `LinkDeadlines`). */
	readonly streamOpen?: StreamOpenDeadlines;
	/** Logger for unusable hints and failed dials; default the `matchmaking:arrival-push` namespace. */
	readonly log?: Log;
}

/** Where a contact hint says to deliver: the seeker's peer, plus the address to reach it on when the hint carried one. */
export interface ContactHintTarget {
	readonly peerId: PeerId;
	/** The hint itself when it is a multiaddr; absent for a bare peer-id hint. */
	readonly addr?: string;
}

/**
 * Read a seeker's `contactHint`: a bare peer-id string, or a multiaddr ending in `/p2p/<id>`. Returns
 * `undefined` for anything else — including a circuit address with no `/p2p/<seeker>` after its
 * `/p2p-circuit`, which names only the relay.
 */
export function contactHintTarget(hint: string): ContactHintTarget | undefined {
	try {
		// A multiaddr's string form always starts with "/" and a peer id's never does.
		if (!hint.startsWith("/")) {
			return { peerId: peerIdFromString(hint) };
		}
		const last = multiaddr(hint).getComponents().at(-1);
		return last?.name === "p2p" && last.value !== undefined
			? { peerId: peerIdFromString(last.value), addr: hint }
			: undefined;
	} catch {
		return undefined;
	}
}

/** Build the driver's `send`: resolve the hint, deliver in process or merge the hint's address and dial. Never rejects. */
export function createArrivalPushSend(deps: ArrivalPushSendDeps): ArrivalPushDriverDeps["send"] {
	const { node, receiver, protocol, streamOpen } = deps;
	const maxBytes = deps.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
	const log = deps.log ?? defaultLog;
	const selfPeerId = node.peerId.toString();

	return async (contactHint: string, frame: Uint8Array): Promise<Uint8Array | undefined> => {
		const target = contactHintTarget(contactHint);
		if (target === undefined) {
			log("arrival push not sent: contact hint %s is neither a peer id nor a multiaddr ending in /p2p/<id>", contactHint);
			return undefined;
		}
		if (target.peerId.toString() === selfPeerId) {
			return receiver.receive(frame, selfPeerId);
		}
		// NOTE: the dialed peer is whoever the hint names, which nothing checks against the registration's
		// participant, so a seeker can point a member's pushes at a third party (one dial per selected arrival,
		// bounded by provider arrivals × capacityBudget). If that shows up as abuse, require the hint's peer to
		// equal the participant that signed the registration.
		if (target.addr !== undefined) {
			mergePeerAddresses(node, target.peerId, [target.addr], log);
		}
		try {
			return await requestResponse(node, target.peerId, protocol, frame, maxBytes, streamOpen);
		} catch (err) {
			log("arrival push to %s failed: %o", contactHint, err);
			return undefined;
		}
	};
}
