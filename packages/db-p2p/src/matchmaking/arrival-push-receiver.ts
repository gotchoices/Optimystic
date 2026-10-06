/**
 * Matchmaking — the seeker's end of arrival push (db-p2p).
 *
 * `docs/matchmaking.md` §Push channel. One {@link ArrivalPushReceiver} per node holds the walks currently
 * waiting on pushes, keyed by the push binding id each one registered with (its seeker payload's
 * `correlationId`, base64url). An inbound {@link ArrivalPushV1} is decoded, its signature checked against the
 * peer the connection authenticated, and queued on the matching walk's {@link SeekerPushChannel}; the reply
 * is an {@link ArrivalPushAckV1}: `ok` when a walk took it, `unknown_seeker` when none holds that binding
 * (the walk ended, or re-registered under another id), so the pushing member drops its binding.
 *
 * A frame that does not decode, or whose signature does not verify against its sender, gets no reply at
 * all: answering `unknown_seeker` to a frame not provably from its sender would let anyone clear a
 * member's binding for us.
 *
 * In-process delivery, for a seeker whose slot primary is its own node, is {@link ArrivalPushReceiver.receive}
 * called with this node's peer id; no stream is involved.
 */

import type { Libp2p } from "libp2p";
import {
	arrivalPushSigningPayload,
	b64urlToBytes,
	bytesToB64url,
	decodeArrivalPushV1,
	encodeArrivalPushAckV1,
	type ArrivalPushResult,
	type ArrivalPushV1,
} from "@optimystic/db-core";
import { verifyPeerSig } from "../cohort-topic/peer-sig.js";
import { handleRequestResponse, DEFAULT_STREAM_MAX_BYTES } from "../cohort-topic/stream-util.js";
import { createLogger } from "../logger.js";
import { armUnrefTimer } from "../unref-timer.js";
import type { SeekerPushChannel } from "./seeker-walk-client.js";

const defaultLog = createLogger("matchmaking:arrival-push-receiver");

type Log = (formatter: string, ...args: unknown[]) => void;

/**
 * Default cap on pushes queued for one walk. The walk drains its queue on every wake, so only a sender
 * pushing far faster than any coalescing member would fills it.
 */
export const DEFAULT_ARRIVAL_PUSH_QUEUE_CAP = 64;

/** Construction inputs for an {@link ArrivalPushReceiver}; all optional. */
export interface ArrivalPushReceiverOptions {
	/** Per-frame ceiling for decoding a push and encoding its ack; default {@link DEFAULT_STREAM_MAX_BYTES}. */
	readonly maxBytes?: number;
	/** Pushes held per walk before the oldest is dropped; default {@link DEFAULT_ARRIVAL_PUSH_QUEUE_CAP}. */
	readonly queueCap?: number;
	/** Logger for dropped frames and overflowing queues; default the `matchmaking:arrival-push-receiver` namespace. */
	readonly log?: Log;
	/** Arm a walk's one-shot wait timer, returning its cancel; default `setTimeout`, unref'd so it never holds a process open. */
	readonly setTimer?: (fn: () => void, ms: number) => () => void;
}

/** One walk's listening registration. */
export interface ArrivalPushSubscription {
	/** The pushes bound to this walk; hand it to the walk as {@link import("./seeker-walk-client.js").SeekerWalkTransport.pushes}. */
	readonly channel: SeekerPushChannel;
	/** Stop listening: later pushes for the binding are acked `unknown_seeker`, and a pending `wait` resolves. Idempotent. */
	unsubscribe(): void;
}

/** The node's listening walks, by push binding id. See the module header. */
export class ArrivalPushReceiver {
	private readonly maxBytes: number;
	private readonly queueCap: number;
	private readonly log: Log;
	private readonly setTimer: (fn: () => void, ms: number) => () => void;
	private readonly listening = new Map<string, PushQueue>();

	constructor(options: ArrivalPushReceiverOptions = {}) {
		this.maxBytes = options.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
		this.queueCap = options.queueCap ?? DEFAULT_ARRIVAL_PUSH_QUEUE_CAP;
		this.log = options.log ?? defaultLog;
		this.setTimer = options.setTimer ?? armUnrefTimer;
		if (!Number.isInteger(this.queueCap) || this.queueCap < 1) {
			throw new RangeError(`arrival push receiver: queueCap must be an integer >= 1, got ${this.queueCap}`);
		}
	}

	/** Listen for pushes bound to `correlationId` (base64url) on `topicId`. A binding id already listened for throws. */
	subscribe(topicId: Uint8Array, correlationId: string): ArrivalPushSubscription {
		if (this.listening.has(correlationId)) {
			throw new Error(`arrival push receiver: binding ${correlationId} is already subscribed`);
		}
		const queue = new PushQueue(bytesToB64url(topicId), correlationId, this.queueCap, this.log, this.setTimer);
		this.listening.set(correlationId, queue);
		return {
			channel: queue,
			unsubscribe: (): void => {
				if (this.listening.get(correlationId) === queue) {
					this.listening.delete(correlationId);
				}
				queue.close();
			},
		};
	}

	/** One encoded {@link ArrivalPushV1} from peer `from` (peer-id string) → an encoded ack, or `undefined` for no reply. Never throws. */
	async receive(frame: Uint8Array, from: string): Promise<Uint8Array | undefined> {
		try {
			const push = this.authenticated(frame, from);
			if (push === undefined) {
				return undefined;
			}
			const queue = this.listening.get(push.correlationId);
			if (queue === undefined || queue.topicId !== push.topicId) {
				return this.ack("unknown_seeker");
			}
			queue.deliver(push);
			return this.ack("ok");
		} catch (err) {
			this.log("arrival push from %s dropped (no reply): %o", from, err);
			return undefined;
		}
	}

	/** The decoded push when it decodes and its signature verifies against `from`; otherwise logged and `undefined`. */
	private authenticated(frame: Uint8Array, from: string): ArrivalPushV1 | undefined {
		let push: ArrivalPushV1;
		try {
			push = decodeArrivalPushV1(frame, this.maxBytes);
		} catch (err) {
			this.log("arrival push from %s dropped (malformed, no reply): %o", from, err);
			return undefined;
		}
		if (!verifyPeerSig(from, arrivalPushSigningPayload(push), b64urlToBytes(push.signature))) {
			this.log("arrival push from %s dropped (signature does not verify against the sender, no reply)", from);
			return undefined;
		}
		return push;
	}

	private ack(result: ArrivalPushResult): Uint8Array {
		return encodeArrivalPushAckV1({ v: 1, result }, this.maxBytes);
	}
}

/**
 * Register the inbound arrival-push protocol on `node`: one {@link ArrivalPushV1} frame in, one
 * {@link import("@optimystic/db-core").ArrivalPushAckV1} frame back, or no reply. The sender is the peer
 * the connection authenticated.
 */
export function registerArrivalPushHandler(node: Libp2p, protocol: string, receiver: ArrivalPushReceiver, maxBytes = DEFAULT_STREAM_MAX_BYTES): void {
	handleRequestResponse(node, protocol, (frame, from) => receiver.receive(frame, from.toString()), maxBytes);
}

/** One walk's queued pushes plus at most one pending waiter. */
class PushQueue implements SeekerPushChannel {
	private queue: ArrivalPushV1[] = [];
	/** Resolves the pending `wait`, if any. */
	private wake: (() => void) | undefined;
	private closed = false;

	constructor(
		readonly topicId: string,
		private readonly correlationId: string,
		private readonly cap: number,
		private readonly log: Log,
		private readonly setTimer: (fn: () => void, ms: number) => () => void,
	) {}

	take(): ArrivalPushV1[] {
		const taken = this.queue;
		this.queue = [];
		return taken;
	}

	wait(ms: number): Promise<void> {
		if (ms <= 0 || this.queue.length > 0 || this.closed) {
			return Promise.resolve();
		}
		// The walk never waits twice at once; if a caller does, the older waiter is released rather than stranded.
		this.release();
		return new Promise<void>((resolve) => {
			let cancelTimer: (() => void) | undefined;
			const done = (): void => {
				cancelTimer?.();
				if (this.wake === done) {
					this.wake = undefined;
				}
				resolve();
			};
			this.wake = done;
			cancelTimer = this.setTimer(done, ms);
		});
	}

	deliver(push: ArrivalPushV1): void {
		this.queue.push(push);
		if (this.queue.length > this.cap) {
			this.queue.shift();
			this.log("arrival push queue for binding %s over its cap of %d: dropped the oldest push", this.correlationId, this.cap);
		}
		this.release();
	}

	close(): void {
		this.closed = true;
		this.queue = [];
		this.release();
	}

	private release(): void {
		this.wake?.();
	}
}
