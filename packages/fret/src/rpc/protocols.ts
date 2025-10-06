export function makeProtocols(networkName = 'default') {
	const prefix = `/optimystic/${networkName}/fret/1.0.0`;
	return {
		PROTOCOL_NEIGHBORS: `${prefix}/neighbors`,
		PROTOCOL_NEIGHBORS_ANNOUNCE: `${prefix}/neighbors/announce`,
		PROTOCOL_MAYBE_ACT: `${prefix}/maybeAct`,
		PROTOCOL_LEAVE: `${prefix}/leave`,
		PROTOCOL_PING: `${prefix}/ping`,
	};
}

// Backward compatibility: default export uses 'default' network
export const PROTOCOL_NEIGHBORS = '/optimystic/default/fret/1.0.0/neighbors';
export const PROTOCOL_NEIGHBORS_ANNOUNCE = '/optimystic/default/fret/1.0.0/neighbors/announce';
export const PROTOCOL_MAYBE_ACT = '/optimystic/default/fret/1.0.0/maybeAct';
export const PROTOCOL_LEAVE = '/optimystic/default/fret/1.0.0/leave';
export const PROTOCOL_PING = '/optimystic/default/fret/1.0.0/ping';

export async function encodeJson(obj: unknown): Promise<Uint8Array> {
	const text = JSON.stringify(obj);
	return new TextEncoder().encode(text);
}

export async function decodeJson<T = unknown>(bytes: Uint8Array): Promise<T> {
	// guard against binary frames or empty buffers from underlying muxers
	if (bytes.byteLength === 0) throw new Error('empty response');
	// strip any leading/trailing nulls/whitespace
	let start = 0;
	let end = bytes.byteLength;
	while (start < end && (bytes[start] === 0 || bytes[start] === 9 || bytes[start] === 10 || bytes[start] === 13 || bytes[start] === 32)) start++;
	while (end > start && (bytes[end - 1] === 0 || bytes[end - 1] === 9 || bytes[end - 1] === 10 || bytes[end - 1] === 13 || bytes[end - 1] === 32)) end--;
	if (end <= start) throw new Error('whitespace response');
	const text = new TextDecoder().decode(bytes.subarray(start, end));
	return JSON.parse(text) as T;
}
