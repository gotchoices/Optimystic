export const PROTOCOL_NEIGHBORS = '/fret/1.0.0/neighbors';
export const PROTOCOL_NEIGHBORS_ANNOUNCE = '/fret/1.0.0/neighbors/announce';
export const PROTOCOL_MAYBE_ACT = '/fret/1.0.0/maybeAct';
export const PROTOCOL_LEAVE = '/fret/1.0.0/leave';
export const PROTOCOL_PING = '/fret/1.0.0/ping';

export async function encodeJson(obj: unknown): Promise<Uint8Array> {
	const text = JSON.stringify(obj);
	return new TextEncoder().encode(text);
}

export async function decodeJson<T = unknown>(bytes: Uint8Array): Promise<T> {
	const text = new TextDecoder().decode(bytes);
	return JSON.parse(text) as T;
}
