/**
 * Convergence polls over an observer node's **peerStore** view of a remote peer.
 *
 * These exist because of what `@libp2p/identify`'s push service is for. `identify()` alone
 * exchanges addresses and protocols once, at connection-open time. Anything a peer learns or
 * registers *later* — a circuit-relay reservation address, an AutoNAT-observed address, a
 * protocol handler registered post-start — only reaches an already-connected peer if
 * `identifyPush()` re-pushes it (gotchoices/Optimystic#7).
 *
 * Two properties of that path make polling mandatory rather than stylistic:
 *
 *  - libp2p's `AddressManager` debounces listen-address changes ~1000 ms before patching the
 *    self peer record, and
 *  - `@libp2p/identify` debounces the push itself a further `PUSH_DEBOUNCE_MS` (1000 ms).
 *
 * So a bare `await` on the triggering event followed by an immediate assertion flakes by
 * construction. Give these helpers well over 2 s.
 *
 * Both read the **observer's** peerStore, never the target's own `getMultiaddrs()` /
 * `getProtocols()`. The target's own view proves the reservation or the registration happened;
 * only the observer's peerStore proves it *propagated*, which is the thing under test.
 */
import type { Libp2p } from 'libp2p';
import type { PeerId } from '@libp2p/interface';

/** How often the polls below re-read the peerStore. */
const POLL_INTERVAL_MS = 100;

/** Outcome of {@link waitForPeerStoreAddresses}. */
export interface PeerStoreAddressWait {
	/** True if an address satisfying the predicate was observed before the timeout elapsed. */
	readonly matched: boolean;
	/** The last address list read from the observer's peerStore (empty if the entry never appeared). */
	readonly addresses: string[];
}

/**
 * Poll `observer`'s peerStore entry for `peerId` until it holds an address matching `predicate`,
 * or `timeoutMs` elapses. Returns what it last saw either way, so a negative-control test can
 * assert on the same result shape as the positive one instead of catching a throw.
 */
export async function waitForPeerStoreAddresses(
	observer: Libp2p,
	peerId: PeerId,
	timeoutMs: number,
	predicate: (addr: string) => boolean = () => true
): Promise<PeerStoreAddressWait> {
	const start = Date.now();
	let addresses: string[] = [];
	for (;;) {
		try {
			const peer = await observer.peerStore.get(peerId);
			addresses = peer.addresses.map(a => a.multiaddr.toString());
			if (addresses.some(predicate)) return { matched: true, addresses };
		} catch {
			// No peerStore entry for this peer yet — keep polling until the deadline.
		}
		if (Date.now() - start >= timeoutMs) return { matched: false, addresses };
		await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
	}
}

/** Outcome of {@link waitForPeerStoreProtocols}. */
export interface PeerStoreProtocolWait {
	/** True if a protocol satisfying the predicate was observed before the timeout elapsed. */
	readonly matched: boolean;
	/** The last protocol list read from the observer's peerStore (empty if the entry never appeared). */
	readonly protocols: string[];
}

/**
 * Poll `observer`'s peerStore entry for `peerId` until its advertised protocol list satisfies
 * `predicate`, or `timeoutMs` elapses.
 *
 * This list is what `Libp2pKeyPeerNetwork.membershipOf` classifies a peer's network membership
 * from (`serves` / `foreign` / `unknown`), so a protocol that never propagates leaves the peer
 * mis-classified and dropped from coordinator and cohort selection.
 */
export async function waitForPeerStoreProtocols(
	observer: Libp2p,
	peerId: PeerId,
	timeoutMs: number,
	predicate: (protocols: string[]) => boolean
): Promise<PeerStoreProtocolWait> {
	const start = Date.now();
	let protocols: string[] = [];
	for (;;) {
		try {
			const peer = await observer.peerStore.get(peerId);
			protocols = [...peer.protocols];
			if (predicate(protocols)) return { matched: true, protocols };
		} catch {
			// No peerStore entry for this peer yet — keep polling until the deadline.
		}
		if (Date.now() - start >= timeoutMs) return { matched: false, protocols };
		await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
	}
}
