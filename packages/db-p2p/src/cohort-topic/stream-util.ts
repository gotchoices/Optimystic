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
 * {@link openStream} deliberately duplicates FRET's `rpc/protocols.ts#openRpcStream` connection
 * selection. FRET now exports `openRpcStream`, but the accepted tradeoff on
 * {@link STREAM_OPTIONS} is why the local copy stays: FRET's helper pins `negotiateFully: false`,
 * which this module deliberately does not set — swapping would silently reverse that decision.
 * Same applies to `libp2p-key-network.ts#connect`, which is a third copy.
 */

import type { Libp2p } from "libp2p";
import type { Connection, PeerId, Stream } from "@libp2p/interface";
import { readFramed, sendFramed } from "p2p-fret";

/** Default per-frame ceiling — matches FRET's 512 KiB maybe-act bound. */
export const DEFAULT_STREAM_MAX_BYTES = 512 * 1024;

/**
 * libp2p refuses to open a protocol stream over a *limited* (circuit-relay) connection unless the
 * caller opts in, so every peer reachable only through a relay — the steady state for browsers and
 * NATed peers — depends on this flag. It is a harmless no-op on a direct connection.
 *
 * NOTE: accepted tradeoff — FRET's `openRpcStream` and `libp2p-key-network.ts#connect` also set
 * `negotiateFully: false`; deliberately not set here. It saves a round trip but defers an
 * unsupported-protocol failure from stream-open to the first read, which would turn
 * {@link sendOneWay} against a peer lacking the protocol into a silent no-op. Revisit if
 * stream-open latency shows up in a profile.
 */
const STREAM_OPTIONS = { runOnLimitedConnection: true } as const;

/** True for a circuit-relay ("limited") connection: libp2p stamps one with per-circuit `limits`;
 * sniffing `/p2p-circuit` in the multiaddr covers transports that leave `limits` unpopulated. */
function isLimitedConnection(c: Connection): boolean {
	if ((c as { limits?: unknown }).limits != null) return true;
	return c.remoteAddr?.toString?.().includes("/p2p-circuit") ?? false;
}

/**
 * Open `protocol` to `peer`, reusing a healthy existing connection when there is one.
 *
 * Skips connections libp2p has not yet evicted from its index but that are no longer open, and
 * prefers a direct connection over a relayed one — a relayed connection can be reset once the
 * relay's per-circuit cap or reservation lapses, and after DCUtR upgrades a link to direct both
 * briefly coexist. Falls back to the relayed connection when it is the only open path.
 */
async function openStream(node: Libp2p, peer: PeerId, protocol: string): Promise<Stream> {
	const open = node.getConnections(peer).filter(c => c?.status === "open" && typeof c?.newStream === "function");
	const chosen = open.find(c => !isLimitedConnection(c)) ?? open[0];
	return chosen ? await chosen.newStream([protocol], STREAM_OPTIONS) : await node.dialProtocol(peer, [protocol], STREAM_OPTIONS);
}

/**
 * Open `protocol` to `peer`, send `frame`, and read the bounded reply frame.
 *
 * NOTE: takes no `AbortSignal`, so a caller cannot set its own deadline. Bounded today anyway —
 * `readFramed` self-times-out at 5s and `dialProtocol` falls back to libp2p's default dial
 * timeout (~30s) — so an unresponsive peer is slow, not hung. If a caller ever needs a tighter
 * deadline (`membership-source.fetch` walks candidate peers *sequentially*, so its worst case is
 * peers × dial-timeout), thread a signal through {@link openStream} the way
 * `libp2p-key-network.ts#connect` does.
 */
export async function requestResponse(
	node: Libp2p,
	peer: PeerId,
	protocol: string,
	frame: Uint8Array,
	maxBytes = DEFAULT_STREAM_MAX_BYTES,
): Promise<Uint8Array> {
	let stream: Stream | undefined;
	try {
		stream = await openStream(node, peer, protocol);
		sendFramed(stream, frame);
		await stream.close();
		return await readFramed(stream, maxBytes);
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

/** Open `protocol` to `peer` and send `frame` without awaiting a reply (fire-and-forget gossip). */
export async function sendOneWay(node: Libp2p, peer: PeerId, protocol: string, frame: Uint8Array): Promise<void> {
	let stream: Stream | undefined;
	try {
		stream = await openStream(node, peer, protocol);
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
 * truncation error, so "no reply" must travel in-band — the dialer's {@link requestResponse}
 * resolves it as empty bytes, exactly what the old read-to-EOF returned for a silent close.
 */
export function handleRequestResponse(
	node: Libp2p,
	protocol: string,
	handle: (frame: Uint8Array, from: PeerId) => Promise<Uint8Array | undefined>,
	maxBytes = DEFAULT_STREAM_MAX_BYTES,
): void {
	void node.handle(protocol, (stream: Stream, connection: Connection) => {
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
