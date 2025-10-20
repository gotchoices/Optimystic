export interface PeerStatus {
	peerId: string;
	lastSeen: number;
	lastGoodbye?: number;
	consecutiveFailures: number;
}

/**
 * Detects potential network partitions by tracking peer health,
 * goodbye messages, and sudden mass unreachability events.
 */
export class PartitionDetector {
	private peerStatuses: Map<string, PeerStatus> = new Map();
	private readonly unreachableThreshold = 3; // consecutive failures
	private readonly rapidChurnThreshold = 5; // peers
	private readonly rapidChurnWindow = 10000; // 10 seconds
	private readonly peerTimeoutMs = 60000; // 1 minute

	/**
	 * Record successful communication with a peer
	 */
	recordSuccess(peerId: string): void {
		const now = Date.now();
		const status = this.peerStatuses.get(peerId);

		if (status) {
			status.lastSeen = now;
			status.consecutiveFailures = 0;
		} else {
			this.peerStatuses.set(peerId, {
				peerId,
				lastSeen: now,
				consecutiveFailures: 0
			});
		}

		// Clean up old peer records
		this.cleanupOldPeers();
	}

	/**
	 * Record failed communication attempt with a peer
	 */
	recordFailure(peerId: string): void {
		const now = Date.now();
		const status = this.peerStatuses.get(peerId);

		if (status) {
			status.consecutiveFailures++;
			status.lastSeen = now;
		} else {
			this.peerStatuses.set(peerId, {
				peerId,
				lastSeen: now,
				consecutiveFailures: 1
			});
		}
	}

	/**
	 * Record explicit goodbye message from a peer
	 */
	recordGoodbye(peerId: string): void {
		const now = Date.now();
		const status = this.peerStatuses.get(peerId);

		if (status) {
			status.lastGoodbye = now;
			status.lastSeen = now;
		} else {
			this.peerStatuses.set(peerId, {
				peerId,
				lastSeen: now,
				lastGoodbye: now,
				consecutiveFailures: 0
			});
		}
	}

	/**
	 * Detect if we're likely in a network partition
	 * Returns true if sudden mass unreachability or rapid goodbye rate
	 */
	detectPartition(): boolean {
		const now = Date.now();

		// Count recent goodbyes
		const recentGoodbyes = this.getRecentGoodbyes(this.rapidChurnWindow);

		// Count unreachable peers
		const unreachable = Array.from(this.peerStatuses.values()).filter(
			s => s.consecutiveFailures >= this.unreachableThreshold
				&& !s.lastGoodbye // Exclude peers that said goodbye
		);

		// Sudden mass unreachability suggests partition
		const totalChurn = recentGoodbyes.length + unreachable.length;

		return totalChurn >= this.rapidChurnThreshold;
	}

	/**
	 * Get list of currently unreachable peers
	 */
	getUnreachablePeers(): string[] {
		return Array.from(this.peerStatuses.values())
			.filter(s => s.consecutiveFailures >= this.unreachableThreshold && !s.lastGoodbye)
			.map(s => s.peerId);
	}

	/**
	 * Get recent goodbye messages within the specified window
	 */
	private getRecentGoodbyes(windowMs: number): PeerStatus[] {
		const cutoff = Date.now() - windowMs;
		return Array.from(this.peerStatuses.values()).filter(
			s => s.lastGoodbye && s.lastGoodbye > cutoff
		);
	}

	/**
	 * Clean up peer records that haven't been seen recently
	 */
	private cleanupOldPeers(): void {
		const cutoff = Date.now() - this.peerTimeoutMs;
		for (const [peerId, status] of this.peerStatuses.entries()) {
			if (status.lastSeen < cutoff) {
				this.peerStatuses.delete(peerId);
			}
		}
	}

	/**
	 * Get statistics for monitoring
	 */
	getStatistics(): {
		totalPeers: number;
		unreachable: number;
		recentGoodbyes: number;
	} {
		const unreachable = this.getUnreachablePeers().length;
		const recentGoodbyes = this.getRecentGoodbyes(this.rapidChurnWindow).length;

		return {
			totalPeers: this.peerStatuses.size,
			unreachable,
			recentGoodbyes
		};
	}

	/**
	 * Reset all tracked peer states (useful for testing)
	 */
	reset(): void {
		this.peerStatuses.clear();
	}
}

