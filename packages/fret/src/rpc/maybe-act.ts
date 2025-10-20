import type { Libp2p } from 'libp2p';
import { peerIdFromString } from '@libp2p/peer-id';
import { PROTOCOL_MAYBE_ACT, encodeJson, decodeJson } from './protocols.js';
import type { RouteAndMaybeActV1, NearAnchorV1 } from '../index.js';
import type { Stream } from '@libp2p/interface';

export function registerMaybeAct(
	node: Libp2p,
	handle: (msg: RouteAndMaybeActV1) => Promise<NearAnchorV1 | { commitCertificate: string }>,
	protocol = PROTOCOL_MAYBE_ACT
): void {
	node.handle(protocol, async ({ stream }) => {
		try {
			const bytes = await readAll(stream);
			const msg = await decodeJson<RouteAndMaybeActV1>(bytes);
			const res = await handle(msg);
			await stream.sink(
				(async function* () {
					yield await encodeJson(res);
				})()
			);
		} catch (err) {
			console.error('maybeAct handler error:', err);
		}
	});
}

export async function sendMaybeAct(
	node: Libp2p,
	peerIdStr: string,
	msg: RouteAndMaybeActV1,
	protocol = PROTOCOL_MAYBE_ACT
): Promise<NearAnchorV1 | { commitCertificate: string }> {
	const pid = peerIdFromString(peerIdStr);
	const conns = (node as any).getConnections?.(pid) ?? [];
	let stream: any;
	try {
		if (Array.isArray(conns) && conns.length > 0 && typeof conns[0]?.newStream === 'function') {
			stream = await conns[0].newStream([protocol]);
		} else {
			stream = await node.dialProtocol(pid, [protocol]);
		}
		await stream.sink(
			(async function* () {
				yield await encodeJson(msg);
			})()
		);
		const bytes = await readAll(stream);
		return await decodeJson(bytes);
	} finally {
		if (stream) {
			try { await stream.close(); } catch {}
		}
	}
}

function toBytes(chunk: unknown): Uint8Array {
	if (chunk instanceof Uint8Array) return chunk;
	const maybe = chunk as { subarray?: (start?: number, end?: number) => Uint8Array };
	if (typeof maybe?.subarray === 'function') return maybe.subarray(0);
	throw new Error('Unsupported chunk type in maybeAct read');
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
