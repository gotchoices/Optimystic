/**
 * Cohort-topic libp2p stream helpers.
 *
 * The cohort-topic protocols exchange a single self-delimiting cohort frame each way (the db-core wire
 * codec already length-prefixes the body), so request/response is one `send` + one bounded read. This
 * mirrors FRET's `rpc/maybe-act.ts` exactly and reuses FRET's exported `readAllBounded`, keeping the
 * stream lifecycle (open → send → close-write → read → close) consistent across both protocol families.
 */

import type { Libp2p } from "libp2p";
import type { Connection, PeerId, Stream } from "@libp2p/interface";
import { readAllBounded } from "p2p-fret";

/** Default per-frame ceiling — matches FRET's 512 KiB maybe-act bound. */
export const DEFAULT_STREAM_MAX_BYTES = 512 * 1024;

/** Open `protocol` to `peer`, send `frame`, and read the bounded reply frame. */
export async function requestResponse(
	node: Libp2p,
	peer: PeerId,
	protocol: string,
	frame: Uint8Array,
	maxBytes = DEFAULT_STREAM_MAX_BYTES,
): Promise<Uint8Array> {
	const conns = node.getConnections(peer);
	let stream: Stream | undefined;
	try {
		stream = conns.length > 0 ? await conns[0]!.newStream([protocol]) : await node.dialProtocol(peer, [protocol]);
		stream.send(frame);
		await stream.close();
		return await readAllBounded(stream, maxBytes);
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
	const conns = node.getConnections(peer);
	let stream: Stream | undefined;
	try {
		stream = conns.length > 0 ? await conns[0]!.newStream([protocol]) : await node.dialProtocol(peer, [protocol]);
		stream.send(frame);
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

/** Register a request/response handler for `protocol`: read one bounded frame, reply with one frame. */
export function handleRequestResponse(
	node: Libp2p,
	protocol: string,
	handle: (frame: Uint8Array, from: PeerId) => Promise<Uint8Array | undefined>,
	maxBytes = DEFAULT_STREAM_MAX_BYTES,
): void {
	void node.handle(protocol, (stream: Stream, connection: Connection) => {
		void (async (): Promise<void> => {
			try {
				const frame = await readAllBounded(stream, maxBytes);
				const reply = await handle(frame, connection.remotePeer);
				if (reply !== undefined) {
					stream.send(reply);
				}
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
