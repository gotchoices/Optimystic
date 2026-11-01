/**
 * Each peer's libp2p peerStore record as the key network reads it, kept until libp2p says it changed.
 *
 * Every cohort assembly (`Libp2pKeyPeerNetwork.assembleServingCohort`, so every block read and every
 * `findCluster`) classifies each member of FRET's over-fetch band by the protocol list its peerStore
 * record holds, and `findCluster` publishes the addresses beside it. A `peerStore.get` takes the
 * peer's read lock, decodes the stored protobuf and stringifies every address. Paid per band member
 * per lookup, that made a read on a node with one connected peer several times slower than a solo
 * node's (GitHub #45, #40). A record changes far less often than it is read, and libp2p says when:
 *
 * - **`peer:update`** — `PersistentPeerStore` emits it from `save`, `patch` and `merge` whenever the
 *   stored record actually changed, creation included. Identify writes through `patch`, so a
 *   completed identify that changes a peer's protocols or addresses emits it.
 * - **`peer:identify`** — identify completed; libp2p dispatches it after the write above.
 * - **`connection:open` / `connection:close`** — change no record by themselves, but are rare, and
 *   dropping on them bounds staleness across a reconnect.
 *
 * Every one of them drops the peer's entry and none populates it, so a record is only ever built from
 * a `peerStore.get`. Two changes libp2p reports by no event — address ageing (the store drops an
 * address older than an hour when it loads a record) and a record's deletion or expiry — are bounded
 * by {@link PEER_RECORD_TTL_MS}.
 *
 * Only the record is kept. Everything the key network decides from it — membership (`membershipOf`,
 * which asks the embedder's predicate before it looks at the protocol list), the remembered serving
 * verdicts, FRET's band — is still evaluated on every lookup.
 *
 * Imports here are type-only or pure, like `prepared-streams.ts`: this module is reachable from the
 * react-native entry (`src/rn.ts`) through `libp2p-key-network.ts`.
 */

import type { Libp2p, PeerId } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { LruMap } from "@optimystic/db-core";

/**
 * How long a record is served without re-reading it when libp2p reports no change. It covers what
 * libp2p reports by no event: the peerStore drops an address older than its `maxAddressAge` (one
 * hour) when it loads a record, and deletes a peer past `maxPeerAge` (six hours). A minute keeps a
 * cached record from publishing an address libp2p has itself aged out for longer than that.
 */
export const PEER_RECORD_TTL_MS = 60_000;

/**
 * Most peers held. The set is the peers FRET hands out plus the bootstrap peers, so this is a guard
 * against an unbounded ring, not a working limit.
 *
 * NOTE: `servingPeersOutside` in `libp2p-key-network.ts` reads a record for every peer ever seen
 * serving this network (`rememberedServing`, which only grows in process) on each solo write. If that
 * set ever outgrows this bound, those reads evict each other and every solo write re-reads them all;
 * prune `rememberedServing` (its own NOTE says how) before raising this.
 */
export const PEER_RECORD_MAX_ENTRIES = 1024;

/** One peerStore record as the key network reads it. Shared with every caller: never mutate. */
export interface PeerStoreRecord {
	readonly protocols: readonly string[];
	readonly addrs: readonly string[];
}

export interface PeerRecordCacheOptions {
	/** Default {@link PEER_RECORD_TTL_MS}. */
	ttlMs?: number;
	/** Default {@link PEER_RECORD_MAX_ENTRIES}. */
	maxEntries?: number;
	/** Receives a peerStore read that failed for a reason other than the peer being unknown. */
	log?: (fmt: string, ...args: unknown[]) => void;
}

/** The node this cache reads. `peerStore` may be absent at runtime: several test doubles build a node without one. */
export type PeerRecordHost = Pick<Libp2p, "peerStore">;

/** The slice of the peerStore read here, loose enough for those doubles too. */
interface PeerStoreReader {
	get?: (id: PeerId) => Promise<{
		protocols?: readonly string[];
		addresses?: ReadonlyArray<{ multiaddr: { toString(): string } }>;
	} | undefined>;
}

/**
 * One uncached read of `peerId`'s record. `undefined` when the peerStore holds no record for the
 * peer (libp2p's `NotFoundError`) or the node has no peerStore at all; any other failure is thrown.
 */
export async function readPeerStoreRecord(host: PeerRecordHost, peerId: PeerId): Promise<PeerStoreRecord | undefined> {
	const store: PeerStoreReader | undefined = host.peerStore;
	if (store?.get == null) return undefined;
	try {
		const peer = await store.get(peerId);
		return {
			protocols: peer?.protocols ?? [],
			addrs: (peer?.addresses ?? []).map(a => a.multiaddr.toString())
		};
	} catch (err) {
		if (err instanceof Error && err.name === "NotFoundError") return undefined;
		throw err;
	}
}

/** A held answer: the record, or `undefined` for a peer the peerStore does not hold. */
interface Entry {
	readonly record: PeerStoreRecord | undefined;
	/** When the read that produced it started, as a `Date.now()` value. */
	readonly readAt: number;
}

/**
 * A `peerStore.get` in flight for one peer. `superseded` is set when the peer is invalidated while it
 * runs: its answer still goes to the callers already waiting on it, but it is not stored, and no
 * later caller joins it. Without that, a read that began before a `peer:update` would land after it
 * and serve the pre-update record until the TTL.
 */
interface PendingRead {
	answer: Promise<PeerStoreRecord | undefined>;
	superseded: boolean;
}

export class PeerRecordCache {
	private readonly ttlMs: number;
	private readonly entries: LruMap<string, Entry>;
	private readonly pending = new Map<string, PendingRead>();
	private readonly log: (fmt: string, ...args: unknown[]) => void;

	constructor(private readonly host: PeerRecordHost & Pick<Libp2p, "addEventListener">, options: PeerRecordCacheOptions = {}) {
		this.ttlMs = options.ttlMs ?? PEER_RECORD_TTL_MS;
		this.entries = new LruMap(options.maxEntries ?? PEER_RECORD_MAX_ENTRIES);
		this.log = options.log ?? (() => {});
		host.addEventListener("peer:update", evt => this.invalidate(evt.detail.peer.id.toString()));
		host.addEventListener("peer:identify", evt => this.invalidate(evt.detail.peerId.toString()));
		host.addEventListener("connection:open", evt => this.invalidate(evt.detail.remotePeer.toString()));
		host.addEventListener("connection:close", evt => this.invalidate(evt.detail.remotePeer.toString()));
	}

	/**
	 * Records for `ids`. A peer the peerStore does not hold, or whose read failed, is absent from the
	 * map. Concurrent calls share one `peerStore.get` per peer.
	 */
	async records(ids: readonly string[]): Promise<Record<string, PeerStoreRecord>> {
		const out: Record<string, PeerStoreRecord> = {};
		const now = Date.now();
		const reads: Array<Promise<void>> = [];
		for (const id of ids) {
			const held = this.fresh(id, now);
			if (held === undefined) {
				reads.push(this.read(id, now).then(record => { if (record !== undefined) out[id] = record; }));
			} else if (held.record !== undefined) {
				out[id] = held.record;
			}
		}
		if (reads.length > 0) await Promise.all(reads);
		return out;
	}

	/** Drop `peerId`'s entry now; the next {@link records} call reads the peerStore for it again. */
	invalidate(peerId: string): void {
		this.entries.delete(peerId);
		const inFlight = this.pending.get(peerId);
		if (inFlight === undefined) return;
		inFlight.superseded = true;
		this.pending.delete(peerId);
	}

	private fresh(id: string, now: number): Entry | undefined {
		const held = this.entries.get(id);
		if (held === undefined || now - held.readAt < this.ttlMs) return held;
		this.entries.delete(id);
		return undefined;
	}

	private read(id: string, now: number): Promise<PeerStoreRecord | undefined> {
		const joined = this.pending.get(id);
		if (joined !== undefined) return joined.answer;
		const read: PendingRead = { answer: Promise.resolve(undefined), superseded: false };
		read.answer = this.fetch(id)
			.then(record => {
				if (!read.superseded) this.entries.set(id, { record, readAt: now });
				return record;
			}, (err: unknown) => {
				// Not remembered: the next lookup tries again.
				this.log("peer-record:read-failed peer=%s - %o", id.substring(0, 12), err);
				return undefined;
			})
			.finally(() => {
				if (this.pending.get(id) === read) this.pending.delete(id);
			});
		this.pending.set(id, read);
		return read.answer;
	}

	private async fetch(id: string): Promise<PeerStoreRecord | undefined> {
		return readPeerStoreRecord(this.host, peerIdFromString(id));
	}
}
