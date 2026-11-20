/**
 * The slice of libp2p a {@link DrainScheduler} reads, as a double: identity, the two events it
 * listens for, who is connected, and who has been identified. Shared by both drains' specs — the
 * block drain (`under-replication-drain.spec.ts`) and the blob copy drain
 * (`blob-copy-drain.spec.ts`) — since the scheduling they exercise is one class.
 */
import type { PeerId } from '@libp2p/interface';

type EventHandler = (event: unknown) => void;

export interface MockLibp2pOptions {
	/** The protocol ids an identified peer's record lists. A peer the scheduler's `protocol` filter
	 *  wants must find it here, so each drain's spec passes its own. */
	readonly protocols: readonly string[];
}

export class MockLibp2p {
	peerId!: PeerId;
	private readonly listeners = new Map<string, EventHandler[]>();
	private readonly connected = new Map<string, PeerId>();
	private readonly identified = new Set<string>();
	readonly peerStore: { get: (peerId: PeerId) => Promise<{ protocols: string[] }> };

	constructor(private readonly options: MockLibp2pOptions) {
		this.peerStore = {
			get: async (peerId: PeerId): Promise<{ protocols: string[] }> => {
				if (!this.identified.has(peerId.toString())) throw new Error('not found');
				return { protocols: [...this.options.protocols] };
			}
		};
	}

	addEventListener(event: string, handler: EventHandler): void {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
	}
	removeEventListener(event: string, handler: EventHandler): void {
		this.listeners.set(event, (this.listeners.get(event) ?? []).filter(h => h !== handler));
	}
	listenerCount(event: string): number {
		return (this.listeners.get(event) ?? []).length;
	}
	getConnections(peerId?: PeerId): Array<{ remotePeer: PeerId }> {
		const all = [...this.connected.values()].map(remotePeer => ({ remotePeer }));
		return peerId === undefined ? all : all.filter(c => c.remotePeer.equals(peerId));
	}

	/** A peer arrives: connected, identified (unless told otherwise), and `connection:open` fires. */
	connect(peerId: PeerId, options: { identified?: boolean; emit?: boolean } = {}): void {
		this.connected.set(peerId.toString(), peerId);
		if (options.identified ?? true) this.identified.add(peerId.toString());
		if (options.emit ?? true) this.emit('connection:open', { remotePeer: peerId });
	}
	disconnect(peerId: PeerId): void {
		this.connected.delete(peerId.toString());
		this.identified.delete(peerId.toString());
	}
	emit(event: string, detail?: unknown): void {
		for (const handler of this.listeners.get(event) ?? []) handler({ detail });
	}
}
