import type { Libp2p } from 'libp2p';
import { peerIdFromString } from '@libp2p/peer-id';
import {
	PROTOCOL_NEIGHBORS,
	PROTOCOL_NEIGHBORS_ANNOUNCE,
	encodeJson,
	decodeJson,
} from './protocols.js';
import type { NeighborSnapshotV1 } from '../index.js';
import type { Stream } from '@libp2p/interface';
import { createLogger } from '../logger.js';

const log = createLogger('rpc:neighbors');

export function registerNeighbors(
	node: Libp2p,
	getSnapshot: () => NeighborSnapshotV1 | Promise<NeighborSnapshotV1>,
	onAnnounce?: (from: string, snapshot: NeighborSnapshotV1) => void,
	protocols = { PROTOCOL_NEIGHBORS, PROTOCOL_NEIGHBORS_ANNOUNCE }
): void {
	node.handle(protocols.PROTOCOL_NEIGHBORS, async ({ stream }) => {
		try {
			const snap = await getSnapshot();
			await stream.sink(
				(async function* () {
					yield await encodeJson(snap);
				})()
			);
			try { (stream as any).close?.(); } catch { }
		} catch (err) {
			console.error('neighbors handler error:', err);
		}
	});

	// Optional: accept pushed announcements of neighbor snapshots
	if (onAnnounce) {
		node.handle(protocols.PROTOCOL_NEIGHBORS_ANNOUNCE, async ({ stream }) => {
			try {
				const bytes = await readAll(stream);
				const snap = await decodeJson<NeighborSnapshotV1>(bytes);
				onAnnounce(snap.from, snap);
				await stream.sink(
					(async function* () {
						yield await encodeJson({ ok: true });
					})()
				);
				try { (stream as any).close?.(); } catch { }
			} catch (err) {
				console.error('neighbors announce handler error:', err);
			}
		});
	}
}

export async function fetchNeighbors(
	node: Libp2p,
	peerIdOrStr: string,
	protocol = PROTOCOL_NEIGHBORS
): Promise<NeighborSnapshotV1> {
	const pid = peerIdFromString(peerIdOrStr);
	// Prefer existing connection stream to avoid dials
	const conns = (node as any).getConnections?.(pid) ?? [];
	if (!Array.isArray(conns) || conns.length === 0 || typeof conns[0]?.newStream !== 'function') {
		// No existing connection - skip to reduce churn
		return { v: 1, from: peerIdOrStr, timestamp: Date.now(), successors: [], predecessors: [], sig: '' } as NeighborSnapshotV1;
	}
	let stream: any;
	try {
		stream = await conns[0].newStream([protocol]);
		const bytes = await readAll(stream);
		return await decodeJson<NeighborSnapshotV1>(bytes);
	} catch (err) {
		log('fetchNeighbors decode failed for %s - %o', peerIdOrStr, err);
		return { v: 1, from: peerIdOrStr, timestamp: Date.now(), successors: [], predecessors: [], sig: '' } as NeighborSnapshotV1;
	} finally {
		if (stream) {
			try { await stream.close(); } catch {}
		}
	}
}

export async function announceNeighbors(
	node: Libp2p,
	peerIdOrStr: string,
	snapshot: NeighborSnapshotV1,
	protocol = PROTOCOL_NEIGHBORS_ANNOUNCE
): Promise<void> {
	const pid = peerIdFromString(peerIdOrStr);
	const conns = (node as any).getConnections?.(pid) ?? [];
	if (!Array.isArray(conns) || conns.length === 0 || typeof conns[0]?.newStream !== 'function') {
		return; // skip if not connected
	}
	let stream: any;
	try {
		stream = await conns[0].newStream([protocol]);
		await stream.sink(
			(async function* () {
				yield await encodeJson(snapshot);
			})()
		);
	} catch (err) {
		log('announceNeighbors failed to %s - %o', peerIdOrStr, err);
	} finally {
		if (stream) {
			try { await stream.close(); } catch {}
		}
	}
}

function toBytes(chunk: unknown): Uint8Array {
	if (chunk instanceof Uint8Array) return chunk;
	const maybe = chunk as { subarray?: (start?: number, end?: number) => Uint8Array } & ArrayBufferView;
	if (typeof maybe?.subarray === 'function') {
		try { return maybe.subarray(0); } catch (err) { log('toBytes subarray failed - %o', err) }
	}
	if (ArrayBuffer.isView(maybe)) {
		return new Uint8Array(maybe.buffer, maybe.byteOffset, maybe.byteLength);
	}
	throw new Error('Unsupported chunk type in neighbors read');
}

async function readAll(stream: Stream): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	for await (const chunk of stream.source as AsyncIterable<unknown>) parts.push(toBytes(chunk));
	let len = 0;
	for (const p of parts) len += p.length;
	const out = new Uint8Array(len);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}
