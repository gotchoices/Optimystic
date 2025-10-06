import { BTree } from 'digitree';

export type PeerState = 'connected' | 'disconnected' | 'dead';

export interface PeerEntry {
	id: string;
	coord: Uint8Array;
	relevance: number;
	lastAccess: number;
	state: PeerState;
	accessCount: number;
	successCount: number;
	failureCount: number;
	avgLatencyMs: number;
	metadata?: Record<string, any>;
}

function coordToHex(coord: Uint8Array): string {
	let s = '';
	for (let i = 0; i < coord.length; i++) s += coord[i]!.toString(16).padStart(2, '0');
	return s;
}

function makeKey(entry: PeerEntry): string {
	return `${coordToHex(entry.coord)}|${entry.id}`;
}

export class DigitreeStore {
	private readonly byKey: BTree<string, PeerEntry>;
	private readonly byId: Map<string, string>; // id -> key

	constructor() {
		this.byKey = new BTree<string, PeerEntry>((e: PeerEntry) => makeKey(e));
		this.byId = new Map();
	}

	insert(entry: PeerEntry): void {
		const key = makeKey(entry);
		this.byKey.insert(entry);
		this.byId.set(entry.id, key);
	}

	upsert(id: string, coord: Uint8Array): PeerEntry {
		const now = Date.now();
		const prevKey = this.byId.get(id);
		if (prevKey) {
			const path = this.byKey.find(prevKey);
			if (path.on) this.byKey.deleteAt(path);
			this.byId.delete(id);
		}
		const entry: PeerEntry = {
			id,
			coord,
			relevance: 0,
			lastAccess: now,
			state: 'disconnected',
			accessCount: 0,
			successCount: 0,
			failureCount: 0,
			avgLatencyMs: 0
		};
		this.insert(entry);
		return entry;
	}

	update(id: string, patch: Partial<PeerEntry>): void {
		const key = this.byId.get(id);
		if (!key) return;
		const path = this.byKey.find(key);
		const cur = this.byKey.at(path);
		if (!cur) return;
		const next: PeerEntry = { ...cur, ...patch };
		this.byKey.updateAt(path, next);
		if (makeKey(cur) !== makeKey(next)) {
			this.byKey.deleteAt(path);
			this.insert(next);
		}
	}

	getById(id: string): PeerEntry | undefined {
		const key = this.byId.get(id);
		if (!key) return undefined;
		const p = this.byKey.find(key);
		return p.on ? this.byKey.at(p) : undefined;
	}

	remove(id: string): void {
		const key = this.byId.get(id);
		if (!key) return;
		const p = this.byKey.find(key);
		if (p.on) this.byKey.deleteAt(p);
		this.byId.delete(id);
	}

	list(): PeerEntry[] {
		const out: PeerEntry[] = [];
		for (const p of this.byKey.ascending(this.byKey.first())) out.push(this.byKey.at(p)!);
		return out;
	}

	size(): number {
		return this.byId.size;
	}

	setState(id: string, state: PeerState): void {
		this.update(id, { state });
	}

	protectedIdsAround(coord: Uint8Array, breadth: number): Set<string> {
		const ids = new Set<string>();
		for (const id of this.neighborsRight(coord, breadth)) ids.add(id);
		for (const id of this.neighborsLeft(coord, breadth)) ids.add(id);
		return ids;
	}

	private ceilPath(hexCoord: string) {
		// find first >= hexCoord by seeking hexCoord + "|\x00"
		const seek = `${hexCoord}|\x00`;
		let p = this.byKey.find(seek);
		if (!p.on) p = this.byKey.next(p);
		return p;
	}

	private floorPath(hexCoord: string) {
		// find last < hexCoord by seeking hexCoord + "|\uffff" then prior
		const seek = `${hexCoord}|\uffff`;
		let p = this.byKey.find(seek);
		if (!p.on) p = this.byKey.prior(p);
		return p;
	}

	successorOfCoord(coord: Uint8Array): PeerEntry | undefined {
		const hex = coordToHex(coord);
		const p = this.ceilPath(hex);
		if (p.on) return this.byKey.at(p);
		// if p is off-end, wrap to first
		const f = this.byKey.first();
		return f.on ? this.byKey.at(f) : undefined;
	}

	predecessorOfCoord(coord: Uint8Array): PeerEntry | undefined {
		const hex = coordToHex(coord);
		const p = this.floorPath(hex);
		if (p.on) return this.byKey.at(p);
		const l = this.byKey.last();
		return l.on ? this.byKey.at(l) : undefined;
	}

	neighborsRight(coord: Uint8Array, count: number): string[] {
		const out: string[] = [];
		const hex = coordToHex(coord);
		let p = this.ceilPath(hex);
		p = p.on ? p : this.byKey.first();
		let i = 0;
		while (i < count) {
			if (!p.on) {
				p = this.byKey.first();
				if (!p.on) break;
			}
			out.push(this.byKey.at(p)!.id);
			p = this.byKey.next(p);
			i++;
		}
		return Array.from(new Set(out));
	}

	neighborsLeft(coord: Uint8Array, count: number): string[] {
		const out: string[] = [];
		const hex = coordToHex(coord);
		let p = this.floorPath(hex);
		p = p.on ? p : this.byKey.last();
		let i = 0;
		while (i < count) {
			if (!p.on) {
				p = this.byKey.last();
				if (!p.on) break;
			}
			out.push(this.byKey.at(p)!.id);
			p = this.byKey.prior(p);
			i++;
		}
		return Array.from(new Set(out));
	}
}
