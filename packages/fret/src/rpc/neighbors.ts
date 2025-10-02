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
	const stream = await node.dialProtocol(pid, [protocol]);
	const bytes = await readAll(stream);
	return await decodeJson<NeighborSnapshotV1>(bytes);
}

export async function announceNeighbors(
	node: Libp2p,
	peerIdOrStr: string,
	snapshot: NeighborSnapshotV1,
	protocol = PROTOCOL_NEIGHBORS_ANNOUNCE
): Promise<void> {
	const pid = peerIdFromString(peerIdOrStr);
	const stream = await node.dialProtocol(pid, [protocol]);
	await stream.sink(
		(async function* () {
			yield await encodeJson(snapshot);
		})()
	);
}

function toBytes(chunk: unknown): Uint8Array {
	if (chunk instanceof Uint8Array) return chunk;
	const maybe = chunk as { subarray?: (start?: number, end?: number) => Uint8Array };
	if (typeof maybe?.subarray === 'function') return maybe.subarray(0);
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
