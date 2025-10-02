import type { Libp2p } from 'libp2p';
import { peerIdFromString } from '@libp2p/peer-id';
import { PROTOCOL_PING, encodeJson, decodeJson } from './protocols.js';

export function registerPing(node: Libp2p): void {
	node.handle(PROTOCOL_PING, async ({ stream }) => {
		await stream.sink(
			(async function* () {
				yield await encodeJson({ ok: true, ts: Date.now() });
			})()
		);
	});
}

export async function sendPing(node: Libp2p, peer: string): Promise<{ ok: boolean; rttMs: number }> {
    const start = Date.now();
    const pid = peerIdFromString(peer);
    const conn = await (node as any).dialProtocol(pid, [PROTOCOL_PING]);
    const stream = conn.stream ?? conn;
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream.source) {
        if (chunk?.subarray) chunks.push(chunk);
    }
    // Some libp2p implementations may send empty frames before actual data; guard decode
    const body = concat(chunks);
    if (body.length === 0) return { ok: false, rttMs: Math.max(0, Date.now() - start) };
    const res = await decodeJson<{ ok: boolean }>(body);
    return { ok: Boolean(res.ok), rttMs: Math.max(0, Date.now() - start) };
}

function concat(chunks: Uint8Array[]): Uint8Array {
	let len = 0;
	for (const c of chunks) len += c.length;
	const out = new Uint8Array(len);
	let o = 0;
	for (const c of chunks) {
		out.set(c, o);
		o += c.length;
	}
	return out;
}
