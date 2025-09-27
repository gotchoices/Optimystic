import type { Libp2p } from 'libp2p';
import { peerIdFromString } from '@libp2p/peer-id';
import { PROTOCOL_LEAVE, encodeJson, decodeJson } from './protocols.js';
import type { Stream } from '@libp2p/interface';

export interface LeaveNoticeV1 {
	v: 1;
	from: string;
	replacements?: string[];
	timestamp: number;
}

export function registerLeave(
	node: Libp2p,
	onLeave: (notice: LeaveNoticeV1) => Promise<void> | void
): void {
	node.handle(PROTOCOL_LEAVE, async ({ stream }) => {
		try {
			const bytes = await readAll(stream);
			const msg = await decodeJson<LeaveNoticeV1>(bytes);
			await onLeave(msg);
			await stream.sink(
				(async function* () {
					yield await encodeJson({ ok: true });
				})()
			);
		} catch (err) {
			console.error('leave handler error:', err);
		}
	});
}

export async function sendLeave(
	node: Libp2p,
	peerIdStr: string,
	notice: LeaveNoticeV1
): Promise<void> {
	const pid = peerIdFromString(peerIdStr);
	const stream = await node.dialProtocol(pid, [PROTOCOL_LEAVE]);
	await stream.sink(
		(async function* () {
			yield await encodeJson(notice);
		})()
	);
}

function toBytes(chunk: unknown): Uint8Array {
	if (chunk instanceof Uint8Array) return chunk;
	const maybe = chunk as { subarray?: (start?: number, end?: number) => Uint8Array };
	if (typeof maybe?.subarray === 'function') return maybe.subarray(0);
	throw new Error('Unsupported chunk type in leave read');
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
