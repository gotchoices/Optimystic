/**
 * Single-frame libp2p stream helpers, shared by cohort-topic, matchmaking, and reactivity.
 *
 * These protocols exchange a single varint-length-prefixed frame each way, via FRET's exported
 * `sendFramed` / `readFramed` pair — the varint prefix is what delimits the frame on the wire
 * (the db-core codec's own internal length prefix travels *inside* the framed body and plays no
 * part in stream delimiting). Request/response is one framed send + one framed read, matching
 * FRET's own four RPC protocols and the `it-length-prefixed` framing the rest of `db-p2p`
 * (`protocol-client.ts`, the cluster/repo/sync/dispute services) already uses, keeping the stream
 * lifecycle (open → send → close-write → read → close) consistent across all protocol families.
 *
 * NOTE: every `sendFramed` here discards its boolean result (`false` = "write accepted, transport
 * buffer now full"), so these helpers apply no backpressure. Harmless while each protocol writes
 * exactly one bounded frame per stream and then closes; if a caller ever writes repeatedly on one
 * stream, honor the flag by awaiting the stream's `'drain'` event the way FRET's `rpcRequest` does.
 *
 * NOTE: accepted tradeoff — both calls to {@link openProtocolStream} below deliberately omit
 * `negotiateFully`, taking libp2p's default of full multistream-select negotiation at stream-open.
 * FRET's `openRpcStream` and `libp2p-key-network.ts#connect` both pass `negotiateFully: false`,
 * which saves a round trip but defers an unsupported-protocol failure from stream-open to the
 * first read — that would turn {@link sendOneWay} against a peer lacking the protocol into a
 * silent no-op. Revisit if stream-open latency shows up in a profile.
 */

import type { Libp2p } from "libp2p";
import type { Connection, PeerId, Stream } from "@libp2p/interface";
import { readFramed, sendFramed } from "p2p-fret";
import { openProtocolStream } from "../network/open-protocol-stream.js";
import { registerProtocolHandler } from "../network/register-protocol-handler.js";

/** Default per-frame ceiling — matches FRET's 512 KiB maybe-act bound. */
export const DEFAULT_STREAM_MAX_BYTES = 512 * 1024;

/**
 * Open `protocol` to `peer`, send `frame`, and read the bounded reply frame.
 *
 * Resolves `undefined` when the peer replied with a **zero-length frame** — the in-band "I have no
 * result" signal {@link handleRequestResponse} sends for a handler that returned nothing. A returned
 * `Uint8Array` is therefore never empty, and every caller must decide what "no result" means for its
 * protocol: fall through to another peer, map it to a benign default, or {@link requireReply} when the
 * protocol always carries a reply. Genuine failures still reject — a dial failure, a stream the peer
 * aborted (`FrameTruncationError`), an over-ceiling reply (`PayloadTooLargeError`).
 *
 * NOTE: takes no `AbortSignal`, so a caller cannot set its own deadline. Bounded today anyway —
 * `readFramed` self-times-out at 5s and `dialProtocol` falls back to libp2p's default dial
 * timeout (~30s) — so an unresponsive peer is slow, not hung. If a caller ever needs a tighter
 * deadline (`membership-source.fetch` walks candidate peers *sequentially*, so its worst case is
 * peers × dial-timeout), pass one through {@link openProtocolStream}'s `signal` the way
 * `libp2p-key-network.ts#connect` does.
 */
export async function requestResponse(
	node: Libp2p,
	peer: PeerId,
	protocol: string,
	frame: Uint8Array,
	maxBytes = DEFAULT_STREAM_MAX_BYTES,
): Promise<Uint8Array | undefined> {
	let stream: Stream | undefined;
	try {
		// `negotiateFully` deliberately omitted — see the accepted tradeoff in the module docblock.
		stream = await openProtocolStream(node, peer, protocol);
		sendFramed(stream, frame);
		await stream.close();
		const reply = await readFramed(stream, maxBytes);
		// NOTE: every zero-length reply maps to "no result". Safe while no protocol has a meaningful empty reply
		// (cohort frames carry an inner length prefix; query/recover replies are encoded objects). If one ever
		// needs to answer "empty" as data, it must send a non-empty envelope rather than bare empty bytes.
		return reply.length === 0 ? undefined : reply;
	} finally {
		if (stream != null) {
			try {
				await stream.close();
			} catch {
				/* already closed */
			}
		}
	}
}

/** Thrown when a request/response peer replied with a zero-length frame where the protocol requires a reply. */
export class NoResultReplyError extends Error {
	constructor(context: string) {
		super(`${context}: peer replied with no result (zero-length reply frame)`);
		this.name = "NoResultReplyError";
	}
}

/**
 * Unwrap a {@link requestResponse} reply for a protocol whose responder always carries a frame; throw
 * {@link NoResultReplyError} (naming `context`) when the peer had no result.
 */
export function requireReply(reply: Uint8Array | undefined, context: string): Uint8Array {
	if (reply === undefined) {
		throw new NoResultReplyError(context);
	}
	return reply;
}

/** Open `protocol` to `peer` and send `frame` without awaiting a reply (fire-and-forget gossip). */
export async function sendOneWay(node: Libp2p, peer: PeerId, protocol: string, frame: Uint8Array): Promise<void> {
	let stream: Stream | undefined;
	try {
		// `negotiateFully` deliberately omitted — see the accepted tradeoff in the module docblock.
		stream = await openProtocolStream(node, peer, protocol);
		sendFramed(stream, frame);
		await stream.close();
	} finally {
		if (stream != null) {
			try {
				await stream.close();
			} catch {
				/* already closed */
			}
		}
	}
}

/**
 * Register a request/response handler for `protocol`: read one bounded frame, reply with one frame.
 *
 * A `handle` that returns `undefined` (a drop, a gate rejection, no serving engine) replies with an
 * explicit **zero-length frame** rather than silence: `readFramed` treats end-of-stream as a
 * truncation error, so "no result" must travel in-band — the dialer's {@link requestResponse}
 * resolves it as `undefined`. Returning `new Uint8Array(0)` puts the same zero-length frame on the
 * wire, so it is the same signal (host.ts's membership responder says "no certificate" that way).
 * A `handle` that throws aborts the stream instead, which the dialer sees as a rejection.
 *
 * Only the reply direction carries "no result": the request frame `handle` receives is always bytes,
 * and an empty request arrives as a zero-length `Uint8Array`.
 */
export function handleRequestResponse(
	node: Libp2p,
	protocol: string,
	handle: (frame: Uint8Array, from: PeerId) => Promise<Uint8Array | undefined>,
	maxBytes = DEFAULT_STREAM_MAX_BYTES,
): void {
	void registerProtocolHandler(node, protocol, (stream: Stream, connection: Connection) => {
		void (async (): Promise<void> => {
			try {
				const frame = await readFramed(stream, maxBytes);
				const reply = await handle(frame, connection.remotePeer);
				sendFramed(stream, reply ?? new Uint8Array(0));
				await stream.close();
			} catch {
				try {
					stream.abort(new Error("cohort-topic stream handler error"));
				} catch {
					/* already aborted */
				}
			}
		})();
	});
}
