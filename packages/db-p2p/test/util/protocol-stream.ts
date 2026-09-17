import { pipe } from 'it-pipe';
import { encode as lpEncode, decode as lpDecode } from 'it-length-prefixed';

/** Length-prefix encode a JSON value into the byte chunks a libp2p stream yields. */
export async function encodeJson(value: unknown): Promise<Uint8Array[]> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of pipe([new TextEncoder().encode(JSON.stringify(value))], lpEncode)) {
		chunks.push(chunk.subarray());
	}
	return chunks;
}

/** Decode every length-prefixed JSON object out of a set of stream chunks. */
export async function decodeJson(chunks: Uint8Array[]): Promise<unknown[]> {
	const source = (async function* () { for (const c of chunks) yield c; })();
	const out: unknown[] = [];
	for await (const data of pipe(source, lpDecode)) {
		out.push(JSON.parse(new TextDecoder().decode(data.subarray())));
	}
	return out;
}

/**
 * An inbound stream for a protocol service's handler: sources `requestChunks`, captures what the
 * handler sends, and resolves `done` when the handler closes or aborts it.
 */
export function makeServiceStream(requestChunks: Uint8Array[]) {
	const sent: Uint8Array[] = [];
	let aborted = false;
	let resolveDone: () => void;
	const done = new Promise<void>((resolve) => { resolveDone = resolve; });
	const stream = {
		send: (chunk: { subarray: () => Uint8Array }) => { sent.push(chunk.subarray()); },
		close: async () => { resolveDone(); },
		abort: (_err: unknown) => { aborted = true; resolveDone(); },
		async *[Symbol.asyncIterator]() {
			for (const chunk of requestChunks) yield chunk;
		},
	};
	return { stream, sent, done, wasAborted: () => aborted };
}
