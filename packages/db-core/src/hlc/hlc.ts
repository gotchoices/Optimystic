/**
 * A hybrid logical clock (HLC) value: the Kulkarni-Demirbas construction docs/crdt-sync.md
 * §HLC Generation and Causal Tracking describes, as one plain JSON-safe object, since it travels
 * inside log blocks and pend requests, both plain JSON on the wire.
 *
 * Only `HlcClock` mints one. The other constructors are {@link legacyHlc}, for a record written
 * before the field existed, and test fixtures.
 */
export type Hlc = {
	/** Wall-clock milliseconds, or higher: the max of the issuer's clock and the highest HLC it had observed. */
	readonly wallMs: number;
	/** Breaks ties among HLCs issued within one `wallMs`. 0 whenever `wallMs` moved. */
	readonly logical: number;
	/** The issuing node's peer id string. `''` means legacy: an entry written before the field existed. */
	readonly nodeId: string;
};

/**
 * The total order on HLCs: `wallMs`, then `logical`, then `nodeId` by plain string (code unit)
 * comparison. Two HLCs from one node never compare equal, because its clock never issues the same
 * `(wallMs, logical)` twice; two from different nodes are separated by `nodeId`.
 */
export function compareHlc(a: Hlc, b: Hlc): number {
	if (a.wallMs !== b.wallMs) return a.wallMs < b.wallMs ? -1 : 1;
	if (a.logical !== b.logical) return a.logical < b.logical ? -1 : 1;
	if (a.nodeId === b.nodeId) return 0;
	return a.nodeId < b.nodeId ? -1 : 1;
}

/**
 * The HLC a reader derives for an entry or record written before the field existed: its plain
 * timestamp, no logical count, and the empty node id. The empty id sorts before every real peer id,
 * which is the only property anything relies on.
 */
export function legacyHlc(timestamp: number): Hlc {
	return { wallMs: timestamp, logical: 0, nodeId: '' };
}

/** Whether a value read off the wire has the shape of an {@link Hlc}: two finite numbers and a string node id. */
export function isHlc(value: unknown): value is Hlc {
	if (typeof value !== 'object' || value === null) return false;
	const { wallMs, logical, nodeId } = value as Record<string, unknown>;
	return typeof wallMs === 'number' && Number.isFinite(wallMs)
		&& typeof logical === 'number' && Number.isFinite(logical)
		&& typeof nodeId === 'string';
}
