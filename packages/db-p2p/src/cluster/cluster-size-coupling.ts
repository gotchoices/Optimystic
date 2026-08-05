/** A component that exposes the cluster size it actually resolved to. */
export interface HasEffectiveClusterSize {
	readonly effectiveClusterSize: number;
}

/**
 * Fail-fast coupling check for a live node's cluster-size wiring, mirroring
 * `assertSuperMajorityCoupling`.
 *
 * `resolveClusterPolicy` (`cluster/cluster-policy.ts`) is the single place that settles the
 * replication factor / target cohort breadth (`clusterSize`). Every consumer that resolves its
 * own cluster size — `Libp2pKeyPeerNetwork` (peer selection) and `NetworkManagerService` (ring
 * sizing) — must be constructed from that SAME resolved value, or the membership admission
 * gate's "is this declared peer set suspiciously small?" yardstick silently diverges from the
 * cohort width peer selection actually assembles (ticket
 * `bug-cluster-size-resolution-single-source`: an unconfigured node ran peer selection at 16
 * while consensus believed full size was 10, so a cohort that had quietly lost six members still
 * measured as full).
 *
 * On a live node both are constructed from `resolveClusterPolicy(options).clusterSize`, so this
 * check normally passes. It exists to catch *future* drift — a call site reverting to its own
 * default, a new consumer added without threading the resolved value — by throwing at
 * construction with every resolved value and its source, rather than letting the node come up
 * mismatched.
 *
 * @throws Error naming the resolved size and every consumer that disagrees with it.
 */
export function assertClusterSizeCoupling(
	resolvedClusterSize: number,
	consumers: Record<string, HasEffectiveClusterSize | undefined>
): void {
	const mismatches = Object.entries(consumers)
		.filter((entry): entry is [string, HasEffectiveClusterSize] => entry[1] !== undefined)
		.filter(([, consumer]) => consumer.effectiveClusterSize !== resolvedClusterSize)
		.map(([name, consumer]) => `${name} resolved ${consumer.effectiveClusterSize}`);

	if (mismatches.length > 0) {
		throw new Error(
			`Cluster size mismatch at node startup: resolveClusterPolicy() produced clusterSize=${resolvedClusterSize}, ` +
			`but ${mismatches.join(', ')}. Every cluster-size consumer must be constructed from the SAME resolved ` +
			`value (see cluster/cluster-policy.ts), or the membership admission gate's yardstick can diverge from ` +
			`the cohort width peer selection actually assembles.`
		);
	}
}
