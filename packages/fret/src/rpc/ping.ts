import type { Libp2p } from 'libp2p';
import { peerIdFromString } from '@libp2p/peer-id';
import { PROTOCOL_PING, encodeJson, decodeJson } from './protocols.js';
import { createLogger } from '../logger.js';

const log = createLogger('rpc:ping');

export interface PingResponseV1 {
	ok: boolean;
	ts: number;
	size_estimate?: number;
	confidence?: number;
}

export type SizeEstimateProvider = () => { size_estimate?: number; confidence?: number } | Promise<{ size_estimate?: number; confidence?: number }>;

export function registerPing(
	node: Libp2p,
	protocol = PROTOCOL_PING,
	getSizeEstimate?: SizeEstimateProvider
): void {
	node.handle(protocol, async ({ stream }) => {
		const response: PingResponseV1 = { ok: true, ts: Date.now() };

		// Add network size hint if provider available
		if (getSizeEstimate) {
			try {
				const sizeInfo = await getSizeEstimate();
				if (sizeInfo.size_estimate !== undefined) {
					response.size_estimate = sizeInfo.size_estimate;
					response.confidence = sizeInfo.confidence;
				}
			} catch (err) {
				log('getSizeEstimate failed - %o', err);
			}
		}

		await stream.sink(
			(async function* () {
				yield await encodeJson(response);
			})()
		);
	});
}

export async function sendPing(node: Libp2p, peer: string, protocol = PROTOCOL_PING): Promise<{ ok: boolean; rttMs: number; size_estimate?: number; confidence?: number }> {
	const start = Date.now();
	const pid = peerIdFromString(peer);
	let stream: any;
	try {
		try {
			const conns = (node as any).getConnections?.(pid) ?? [];
			if (Array.isArray(conns) && conns.length > 0 && typeof conns[0]?.newStream === 'function') {
				stream = await conns[0].newStream([protocol]);
			} else {
				const conn = await (node as any).dialProtocol(pid, [protocol]);
				stream = (conn as any).stream ?? conn;
			}
		} catch (e) {
			// fallback to dial if newStream path failed
			const conn = await (node as any).dialProtocol(pid, [protocol]);
			stream = (conn as any).stream ?? conn;
		}
		let first: Uint8Array | null = null;
		for await (const chunk of stream.source) {
			if (chunk == null) continue;
			try {
				if (chunk instanceof Uint8Array) { first = chunk; break; }
				if (typeof (chunk as any).subarray === 'function') {
					const maybe = (chunk as any).subarray();
					if (maybe instanceof Uint8Array) { first = maybe; break; }
					if (ArrayBuffer.isView(maybe)) {
						first = new Uint8Array(maybe.buffer, maybe.byteOffset, maybe.byteLength);
						break;
					}
				}
				if (ArrayBuffer.isView(chunk)) {
					first = new Uint8Array((chunk as ArrayBufferView).buffer, (chunk as ArrayBufferView).byteOffset, (chunk as ArrayBufferView).byteLength);
					break;
				}
			} catch (err) { log('sendPing chunk handling failed - %o', err) }
		}
		const rttMs = Math.max(0, Date.now() - start);
		if (!first || first.length === 0) return { ok: false, rttMs };
		const text = new TextDecoder().decode(first).trim();
		if (!text || text[0] !== '{' || !text.endsWith('}')) return { ok: false, rttMs };
		try {
			const res = await decodeJson<PingResponseV1>(first);
			return {
				ok: Boolean(res.ok),
				rttMs,
				size_estimate: res.size_estimate,
				confidence: res.confidence
			};
		} catch (err) {
			log('sendPing decode failed - %o', err)
			return { ok: false, rttMs };
		}
	} finally {
		if (stream) {
			try { await stream.close(); } catch { }
		}
	}
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
