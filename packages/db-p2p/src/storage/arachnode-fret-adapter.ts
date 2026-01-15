import type { FretService } from 'p2p-fret';

/**
 * Arachnode ring membership information.
 * Stored in FRET's generic metadata field.
 */
export interface ArachnodeInfo {
	/** Ring depth: 0 = full keyspace, N = 2^N partitions */
	ringDepth: number;

	/** Partition this node covers (undefined if ringDepth = 0) */
	partition?: {
		prefixBits: number;
		prefixValue: number;
	};

	/** Storage capacity in bytes */
	capacity: {
		total: number;
		used: number;
		available: number;
	};

	/** Ring membership status */
	status: 'joining' | 'active' | 'moving' | 'leaving';
}

/**
 * Adapter that provides Arachnode-specific methods on top of FRET's generic metadata.
 *
 * FRET remains a pure DHT, while this adapter layers Arachnode semantics.
 */
export class ArachnodeFretAdapter {
	private static readonly ARACHNODE_KEY = 'arachnode';

	constructor(private readonly fret: FretService) {}

	/**
	 * Set this node's Arachnode ring membership.
	 */
	setArachnodeInfo(info: ArachnodeInfo): void {
		this.fret.setMetadata({
			[ArachnodeFretAdapter.ARACHNODE_KEY]: info
		});
	}

	/**
	 * Get Arachnode info for a specific peer.
	 */
	getArachnodeInfo(peerId: string): ArachnodeInfo | undefined {
		const metadata = this.fret.getMetadata(peerId);
		return metadata?.[ArachnodeFretAdapter.ARACHNODE_KEY] as ArachnodeInfo | undefined;
	}

	/**
	 * Get my own Arachnode info.
	 */
	getMyArachnodeInfo(): ArachnodeInfo | undefined {
		const myPeerId = (this.fret as any).node?.peerId?.toString();
		if (!myPeerId) return undefined;
		return this.getArachnodeInfo(myPeerId);
	}

	/**
	 * Find all peers at a specific ring depth.
	 */
	findPeersAtRing(ringDepth: number): string[] {
		const peers = this.fret.listPeers();
		return peers
			.filter(peer => {
				const arachnode = peer.metadata?.[ArachnodeFretAdapter.ARACHNODE_KEY] as ArachnodeInfo | undefined;
				return arachnode?.ringDepth === ringDepth;
			})
			.map(peer => peer.id);
	}

	/**
	 * Find all known storage rings (unique ring depths).
	 */
	getKnownRings(): number[] {
		const peers = this.fret.listPeers();
		const rings = new Set<number>();

		for (const peer of peers) {
			const arachnode = peer.metadata?.[ArachnodeFretAdapter.ARACHNODE_KEY] as ArachnodeInfo | undefined;
			if (arachnode?.ringDepth !== undefined) {
				rings.add(arachnode.ringDepth);
			}
		}

		return Array.from(rings).sort((a, b) => a - b);
	}

	/**
	 * Get statistics about discovered rings.
	 */
	getRingStats(): Array<{ ringDepth: number; peerCount: number; avgCapacity: number }> {
		const peers = this.fret.listPeers();
		const ringMap = new Map<number, { count: number; totalCapacity: number }>();

		for (const peer of peers) {
			const arachnode = peer.metadata?.[ArachnodeFretAdapter.ARACHNODE_KEY] as ArachnodeInfo | undefined;
			if (arachnode) {
				const existing = ringMap.get(arachnode.ringDepth) ?? { count: 0, totalCapacity: 0 };
				ringMap.set(arachnode.ringDepth, {
					count: existing.count + 1,
					totalCapacity: existing.totalCapacity + arachnode.capacity.available
				});
			}
		}

		return Array.from(ringMap.entries())
			.map(([ringDepth, stats]) => ({
				ringDepth,
				peerCount: stats.count,
				avgCapacity: stats.totalCapacity / stats.count
			}))
			.sort((a, b) => a.ringDepth - b.ringDepth);
	}

	/**
	 * Access the underlying FRET service.
	 */
	getFret(): FretService {
		return this.fret;
	}
}

