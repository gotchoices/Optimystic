/**
 * Reactivity notify transport — the one-way `NotificationV1` delivery primitive (`docs/reactivity.md`
 * §Propagation).
 *
 * Unlike the cohort-gossip transport (which *broadcasts* a frame to a FRET-assembled cohort), notify is
 * **unicast**: the fan-out orchestration above this layer (the `reactivity-forwarder-host` ticket) decides
 * who to dial and calls {@link ReactivityNotifyTransport.send} once per named target. This module owns only
 * the framing + dial + inbound-decode plumbing — no fan-out, no role decision, no gossip.
 *
 * The db-core `NotificationV1` codec ({@link encodeNotificationV1} / {@link decodeNotificationV1}) does the
 * length-prefixed JSON framing; this layer rides one self-delimiting frame each way over the notify
 * protocol, reusing the cohort-topic {@link sendOneWay} / {@link readAllBounded} stream lifecycle so the
 * two protocol families behave identically on the wire.
 *
 * Failure isolation is the load-bearing property: notify is fire-and-forget and hint-only, so a dead /
 * unreachable target's rejection is swallowed (logged), never propagated to the caller's fan-out loop or a
 * commit. There is no reply frame — a handler that tried to send one back would desync the dialer's
 * {@link sendOneWay} (which closes after send).
 */

import type { NotificationV1, PeerRef } from "@optimystic/db-core";
import { encodeNotificationV1, decodeNotificationV1 } from "@optimystic/db-core";
import type { Libp2p } from "libp2p";
import type { Connection, Stream } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { readAllBounded } from "p2p-fret";
import { peerIdToBytes } from "../cohort-topic/peer-codec.js";
import { sendOneWay, DEFAULT_STREAM_MAX_BYTES } from "../cohort-topic/stream-util.js";
import { PROTOCOL_REACTIVITY_NOTIFY } from "./protocols.js";
import { createLogger } from "../logger.js";

const log = createLogger("reactivity-notify");

/** One-way `NotificationV1` transport: unicast send, inbound subscribe, and the host's deliver seam. */
export interface ReactivityNotifyTransport {
	/**
	 * Frame `n` ({@link encodeNotificationV1}) and dial `target` (peer-id string) over the notify protocol.
	 * Fire-and-forget, failure-isolated: a dead/unreachable target's rejection is swallowed (logged), never
	 * propagated to the caller's fan-out loop.
	 */
	send(target: string, n: NotificationV1): Promise<void>;
	/** Subscribe to inbound notifications (after decode); returns an unsubscribe handle. */
	onNotification(handler: (from: PeerRef, n: NotificationV1) => void): () => void;
	/** Feed an inbound notify frame (called by the host's notify protocol handler). */
	deliver(fromPeerId: string, frame: Uint8Array): void;
}

/** Construction options for {@link Libp2pReactivityNotifyTransport}. */
export interface ReactivityNotifyTransportOptions {
	/** Notify protocol ID; default {@link PROTOCOL_REACTIVITY_NOTIFY}. */
	readonly notifyProtocol?: string;
	/** Per-frame ceiling for the inbound decode bound. Default {@link DEFAULT_STREAM_MAX_BYTES}. */
	readonly maxBytes?: number;
	/** This node's peer-id string; when set, {@link Libp2pReactivityNotifyTransport.send} never dials self. */
	readonly selfPeerId?: string;
}

/**
 * libp2p-backed {@link ReactivityNotifyTransport}: {@link send} frames + dials a single target over
 * `/optimystic/reactivity/1.0.0/notify` (fire-and-forget, failure-isolated); inbound frames arrive through
 * the host's notify protocol handler ({@link registerNotifyHandler}), which calls {@link deliver}.
 * Subscribers registered via {@link onNotification} see every decoded notification.
 */
export class Libp2pReactivityNotifyTransport implements ReactivityNotifyTransport {
	private readonly handlers = new Set<(from: PeerRef, n: NotificationV1) => void>();
	private readonly notifyProtocol: string;
	private readonly maxBytes: number;
	private readonly selfPeerId?: string;

	constructor(private readonly node: Libp2p, options: ReactivityNotifyTransportOptions = {}) {
		this.notifyProtocol = options.notifyProtocol ?? PROTOCOL_REACTIVITY_NOTIFY;
		this.maxBytes = options.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
		this.selfPeerId = options.selfPeerId;
	}

	send(target: string, n: NotificationV1): Promise<void> {
		if (this.selfPeerId !== undefined && target === this.selfPeerId) {
			// Never dial self; a co-located subscriber is delivered in-process by the forwarder host.
			return Promise.resolve();
		}
		try {
			const frame = encodeNotificationV1(n);
			return sendOneWay(this.node, peerIdFromString(target), this.notifyProtocol, frame).catch((err: unknown) => {
				// Best-effort, failure-isolated: a dead/unreachable target must not break the fan-out or a commit.
				log("send to %s failed (swallowed): %o", target, err);
			});
		} catch (err) {
			// Malformed notification or peer-id string: log + drop, never reject (reactivity is hint-only).
			log("dropped a send to %s: %o", target, err);
			return Promise.resolve();
		}
	}

	onNotification(handler: (from: PeerRef, n: NotificationV1) => void): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	/** Feed an inbound notify frame (called by the host's notify protocol handler). */
	deliver(fromPeerId: string, frame: Uint8Array): void {
		let n: NotificationV1;
		try {
			n = decodeNotificationV1(frame, this.maxBytes);
		} catch (err) {
			// A malformed frame must never throw out of a stream handler: log + drop.
			log("dropped an undecodable inbound frame from %s: %o", fromPeerId, err);
			return;
		}
		const from: PeerRef = { id: peerIdToBytes(fromPeerId) };
		for (const handler of this.handlers) {
			handler(from, n);
		}
	}
}

/**
 * Register the inbound notify protocol handler: read one bounded frame and hand it to
 * {@link ReactivityNotifyTransport.deliver}, then close. One-way — no reply frame (notify is strictly
 * fire-and-forget; a reply would desync the dialer's {@link sendOneWay}). Mirrors the cohort-topic
 * one-way handlers: a read error aborts the stream, and {@link ReactivityNotifyTransport.deliver}
 * swallows a decode failure, so the handler never throws on the stream.
 */
export function registerNotifyHandler(
	node: Libp2p,
	protocol: string,
	transport: ReactivityNotifyTransport,
	maxBytes = DEFAULT_STREAM_MAX_BYTES,
): void {
	void node.handle(protocol, (stream: Stream, connection: Connection) => {
		void (async (): Promise<void> => {
			try {
				const frame = await readAllBounded(stream, maxBytes);
				transport.deliver(connection.remotePeer.toString(), frame);
				await stream.close();
			} catch {
				try {
					stream.abort(new Error("reactivity notify stream handler error"));
				} catch {
					/* already aborted */
				}
			}
		})();
	});
}
