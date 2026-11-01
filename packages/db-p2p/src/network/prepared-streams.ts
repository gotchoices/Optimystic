/**
 * One stream per (peer, protocol), negotiated ahead of the request that will use it.
 *
 * Opening a protocol stream costs one full link round trip even on a connection that is already
 * open: multistream-select sends the protocol proposal and waits for the remote's echo before the
 * stream is handed back (`@libp2p/multistream-select` 7 ignores `negotiateFully: false`;
 * `test/stream-open-costs-a-round-trip.spec.ts` pins it). Every request this package makes is one
 * request on one fresh stream (`ProtocolClient.processMessage`), so every request paid two round
 * trips — over a relay, about half of each request's time. A *prepared stream* is one whose
 * negotiation has already completed, held idle until the next request to that peer on that protocol
 * takes it; that request then costs only its own round trip.
 *
 * Nothing changes on the answering side. Every request/response handler this pool serves reads the
 * first frame of a stream and returns after one reply, so a held stream simply waits for its one
 * request, and a held stream closed with no request ends the handler's read without a frame and
 * without an error.
 *
 * The rules:
 *
 * - **Depth one.** At most one ready stream, and at most one background open in flight, per
 *   (peer, protocol). A burst of concurrent requests to one peer takes the one ready stream and
 *   opens the rest fresh, as every request did before.
 * - **Only on demand.** {@link PreparedStreams.replenish} is called by `Libp2pKeyPeerNetwork.connect`
 *   after it hands out a stream, so a peer this node has not just sent a request to gets nothing:
 *   no warming on connection open or identify.
 * - **Never dials.** The background open runs `openProtocolStream` with `allowDial: false`, so a peer
 *   with no open connection gets no prepared stream and its next request dials as before.
 * - **Idle expiry.** A ready stream not taken within the idle time is closed gracefully — the
 *   answering handler then sees an empty stream and returns quietly — and is not replaced. A burst
 *   of activity therefore costs one extra stream open and one empty stream at its end.
 * - **Eviction.** A ready stream leaves the pool the moment it closes for any reason (its connection
 *   aborted or condemned, the remote reset it, a relay circuit hit its cap) or the remote half-closes
 *   it.
 * - **Take re-checks.** {@link PreparedStreams.take} hands a stream out only if it is still open in
 *   both directions, its connection is still open, it is younger than the idle time, and it is not on
 *   a relayed connection while a direct one to the same peer now exists (the one a fresh open would
 *   pick after a DCUtR upgrade). Anything else is closed and the request opens fresh.
 *
 * A prepared stream was negotiated up to the idle time before the request it carries, and its
 * connection may have died in between without either side noticing (the half-open connection of
 * GitHub #32). A request on it cannot hedge to another connection the way a fresh open does, since
 * that would send the request twice on purpose; instead `processMessage` re-sends once when a stream
 * this pool handed out ({@link isPreparedStream}) fails before any reply byte arrives — unless the
 * remote reset it, which means the request reached a live handler and failed there. What ends the
 * wait on a dead connection is the replacement open `connect` starts beside the request: it picks
 * the same connection first, stays pending there, and condemns it after the dead-connection delay,
 * which aborts the request's stream from this side.
 *
 * NOTE: libp2p (3.3.11) records a stream's protocol in the remote peer's peerStore record on every
 * stream, both ends — `peerStore.merge(remotePeer, { protocols: [protocol] })` in
 * `Connection.newStream` and in `onIncomingStream` — and each merge takes the peer's write lock. This
 * pool moves the requester's open, and that merge, off the request's critical path, but it does not
 * reduce the count: still one stream, so one merge, per request on each end. A stream carrying more
 * than one request was considered and declined (GitHub #40); libp2p/js-libp2p#3692 fixes it upstream
 * by merging each protocol once per connection, and until a libp2p release carries it
 * `protocol-merge-throttle.ts` lets one such merge per peer and protocol reach the store per minute.
 * An unchanged merge emits no `peer:update`, so it does not invalidate the key network's cached
 * records (`peer-record-cache.ts`).
 *
 * Imports here are type-only or pure, like `open-protocol-stream.ts`: this module is reachable from
 * the react-native entry (`src/rn.ts`) through `libp2p-key-network.ts`.
 */

import type { Libp2p } from "libp2p";
import type { Connection, PeerId, Stream } from "@libp2p/interface";
import type { StreamOpenDeadlines } from "../rpc-deadline.js";
import { unrefTimer } from "../unref-timer.js";
import { createLogger } from "../logger.js";
import { discardStream, isLimitedConnection, openProtocolStream, type StreamOpenLog } from "./open-protocol-stream.js";

/** How long a prepared stream may sit unused before it is closed. */
export const PREPARED_STREAM_IDLE_MS = 30_000;

export interface PreparedStreamsInit {
	/** The protocol ids that get a prepared stream. Any other protocol passes straight through. */
	protocols: readonly string[];
	/** How long a prepared stream may sit unused before it is closed; default {@link PREPARED_STREAM_IDLE_MS}. */
	idleMs?: number;
	/** Hedge and dead-connection delays for the background open — the node's `LinkDeadlines`. */
	deadlines?: StreamOpenDeadlines;
	/** Receives the background opens' `open-stream:connection-dead` reports; `openProtocolStream`'s own logger when omitted. */
	streamOpenLog?: StreamOpenLog;
}

/** Every stream {@link PreparedStreams.take} has handed out; weak, so a stream is forgotten with itself. */
const handedOut = new WeakSet<Stream>();

/** True for a stream {@link PreparedStreams.take} handed out, so `processMessage` can apply its one re-send. */
export function isPreparedStream(stream: Stream): boolean {
	return handedOut.has(stream);
}

/** A ready stream and what {@link PreparedStreams.take} needs to judge it. */
interface HeldStream {
	readonly stream: Stream;
	readonly connection: Connection;
	readonly preparedAt: number;
	readonly idleTimer: ReturnType<typeof setTimeout>;
	readonly onClose: () => void;
	readonly onRemoteCloseWrite: () => void;
}

/** Why {@link PreparedStreams.take} would not hand a held stream out. */
type Refusal = "stream-not-open" | "remote-half-closed" | "connection-not-open" | "idle" | "direct-connection-available";

/** The pool's key for one (peer, protocol); a peer id holds no whitespace. */
const keyOf = (peer: PeerId, protocol: string): string => `${peer.toString()} ${protocol}`;

/** A short label for why a background open failed: the error's `.code` where it has one. */
function failureReason(err: unknown): string {
	const code = (err as { code?: unknown })?.code;
	if (typeof code === "string" && code.length > 0) return code;
	const message = err instanceof Error ? err.message : String(err);
	return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

/** One prepared stream per (peer, protocol); see the module docblock. */
export class PreparedStreams {
	private readonly protocols: ReadonlySet<string>;
	private readonly idleMs: number;
	private readonly log: ReturnType<typeof createLogger>;
	private readonly ready = new Map<string, HeldStream>();
	/** One controller per background open in flight; aborted by {@link close}. */
	private readonly opening = new Map<string, AbortController>();
	private closed = false;

	constructor(private readonly node: Libp2p, private readonly init: PreparedStreamsInit) {
		this.protocols = new Set(init.protocols);
		this.idleMs = init.idleMs ?? PREPARED_STREAM_IDLE_MS;
		this.log = createLogger("prepared-stream", node.peerId.toString());
	}

	/** A ready stream for (peer, protocol), removed from the pool, or undefined. Never waits, never dials. */
	take(peer: PeerId, protocol: string): Stream | undefined {
		const key = keyOf(peer, protocol);
		const held = this.ready.get(key);
		if (held === undefined) return undefined;
		this.release(key, held);
		const refusal = this.refusalOf(held, peer);
		if (refusal !== undefined) {
			this.log("prepared-stream:refused peer=%s protocol=%s reason=%s", peer.toString().substring(0, 12), protocol, refusal);
			discardStream(held.stream);
			return undefined;
		}
		handedOut.add(held.stream);
		return held.stream;
	}

	/** Make sure one stream for (peer, protocol) is ready or being prepared. Fire-and-forget. */
	replenish(peer: PeerId, protocol: string): void {
		if (this.closed || !this.protocols.has(protocol)) return;
		// libp2p never dials self, and nothing asks for a stream to self today; the guard is free.
		if (peer.toString() === this.node.peerId.toString()) return;
		const key = keyOf(peer, protocol);
		if (this.ready.has(key) || this.opening.has(key)) return;
		const controller = new AbortController();
		this.opening.set(key, controller);
		void this.prepare(key, peer, protocol, controller);
	}

	/** Close every held stream, cancel every background open, clear every timer. Idempotent. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const controller of this.opening.values()) controller.abort(new Error("prepared streams closed"));
		this.opening.clear();
		for (const [key, held] of [...this.ready]) {
			this.release(key, held);
			discardStream(held.stream);
		}
	}

	private async prepare(key: string, peer: PeerId, protocol: string, controller: AbortController): Promise<void> {
		let stream: Stream;
		try {
			stream = await openProtocolStream(this.node, peer, protocol, {
				signal: controller.signal,
				negotiateFully: false,
				allowDial: false,
				deadlines: this.init.deadlines,
				log: this.init.streamOpenLog,
			});
		} catch (err) {
			if (this.opening.get(key) === controller) this.opening.delete(key);
			// Cancelled by `close()`: not a failure.
			if (controller.signal.aborted) return;
			this.log("prepared-stream:open-failed peer=%s protocol=%s reason=%s", peer.toString().substring(0, 12), protocol, failureReason(err));
			return;
		}
		if (this.opening.get(key) !== controller || this.closed) {
			discardStream(stream);
			return;
		}
		this.opening.delete(key);
		this.hold(key, peer, protocol, stream);
	}

	private hold(key: string, peer: PeerId, protocol: string, stream: Stream): void {
		const connection = this.node.getConnections(peer).find(c => c.streams.includes(stream));
		// Without its connection a held stream cannot be judged at take time; libp2p lists every stream
		// it opens on its connection, so this is a stream that has already closed.
		if (connection === undefined) {
			this.log("prepared-stream:open-failed peer=%s protocol=%s reason=%s", peer.toString().substring(0, 12), protocol, "connection-not-found");
			discardStream(stream);
			return;
		}
		const held: HeldStream = {
			stream,
			connection,
			preparedAt: Date.now(),
			idleTimer: unrefTimer(setTimeout(() => this.expire(key, held, peer, protocol), this.idleMs)),
			onClose: () => {
				if (this.ready.get(key) === held) this.release(key, held);
			},
			onRemoteCloseWrite: () => {
				if (this.ready.get(key) !== held) return;
				this.release(key, held);
				discardStream(stream);
			},
		};
		stream.addEventListener("close", held.onClose);
		stream.addEventListener("remoteCloseWrite", held.onRemoteCloseWrite);
		this.ready.set(key, held);
	}

	/** Not taken within the idle time: close it gracefully and do not replace it. */
	private expire(key: string, held: HeldStream, peer: PeerId, protocol: string): void {
		if (this.ready.get(key) !== held) return;
		this.release(key, held);
		this.log("prepared-stream:expired peer=%s protocol=%s idleMs=%d", peer.toString().substring(0, 12), protocol, this.idleMs);
		discardStream(held.stream);
	}

	/** Take `held` out of the pool: forget it, clear its timer, drop its listeners. */
	private release(key: string, held: HeldStream): void {
		if (this.ready.get(key) === held) this.ready.delete(key);
		clearTimeout(held.idleTimer);
		held.stream.removeEventListener("close", held.onClose);
		held.stream.removeEventListener("remoteCloseWrite", held.onRemoteCloseWrite);
	}

	private refusalOf(held: HeldStream, peer: PeerId): Refusal | undefined {
		const { stream, connection } = held;
		if (stream.status !== "open" || stream.writeStatus !== "writable") return "stream-not-open";
		if (stream.remoteWriteStatus !== "writable") return "remote-half-closed";
		if (connection.status !== "open") return "connection-not-open";
		// The timer normally retires a stream first; a stalled event loop can run a take before it.
		if (Date.now() - held.preparedAt >= this.idleMs) return "idle";
		if (isLimitedConnection(connection) && this.hasOpenDirectConnection(peer)) return "direct-connection-available";
		return undefined;
	}

	private hasOpenDirectConnection(peer: PeerId): boolean {
		return this.node.getConnections(peer).some(c => c.status === "open" && !isLimitedConnection(c));
	}
}
