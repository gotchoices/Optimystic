/**
 * Optional, embedder-supplied answer to "is this peer one of us?", consulted wherever this node
 * chooses peers to hold or coordinate its network's data.
 *
 * Without it, a node decides that a remote peer serves its network from the peer's libp2p
 * peerStore protocol list, and any connected peer can put this network's protocols into that list
 * — by opening a stream on one (libp2p records the negotiated protocol before the handler lookup,
 * so even a stream `authorizeInboundStream` then resets has already written it) or by advertising
 * them through identify. An application whose membership is decided elsewhere (an enrollment
 * record, an invitation) supplies this predicate so a stranger cannot be chosen as a cohort member
 * or coordinator. `docs/internals.md` § Network Membership Predicate has the full account.
 *
 * Contract:
 *
 * - **Absent predicate → today's behavior exactly.** {@link createNetworkMembershipGate} returns
 *   `undefined`, every consumer guards on that, and no check runs.
 * - **Synchronous.** It runs inside the per-peer classification loop of every cohort assembly, so
 *   it must be an in-memory lookup. A predicate that returns a promise is a contract violation and
 *   is read as a refusal (logged), never awaited.
 * - **Fail closed.** Only a literal `true` admits. `false` refuses; a throw or any other value
 *   refuses and is logged with the peer id.
 * - **Self is always a member**, so the predicate may list remote members only — the same contract
 *   `authorizeInboundStream` has.
 * - **Read live.** Consumers ask on every classification and keep no verdict of their own, so a
 *   peer the application admits counts on the next lookup and one it removes drops out of it.
 * - **Peer id encoding**: the libp2p base58btc string `PeerId.toString()` produces (`12D3KooW…`).
 */

/**
 * Is `peerId` a member of this node's network?
 *
 * @param peerId the peer's `PeerId.toString()` (base58btc, `12D3KooW…`)
 * @returns `true` to admit. Anything else — `false`, a throw, any other value — refuses.
 */
export type IsNetworkMember = (peerId: string) => boolean;

/**
 * The total, fail-closed form of {@link IsNetworkMember} handed to consumers: it never throws, and
 * answers `true` for this node itself whatever the predicate says.
 */
export type NetworkMembershipGate = (peerId: string) => boolean;

/**
 * Does `gate` admit `peerId`? An absent gate (no predicate configured) admits everyone, which is the
 * one rule every consumer of an optional gate applies.
 */
export function admittedBy(gate: NetworkMembershipGate | undefined, peerId: string): boolean {
	return gate === undefined || gate(peerId);
}

/** Log sink shape shared by the component loggers and the `debug` loggers this package uses. */
export type NetworkMembershipLog = (message: string, ...args: unknown[]) => void;

/**
 * Build the gate, or `undefined` when the embedder supplied no predicate — returning `undefined`
 * rather than an always-admit gate is what lets every consumer skip the check entirely.
 */
export function createNetworkMembershipGate(
	predicate: IsNetworkMember | undefined,
	selfPeerId: string,
	log: NetworkMembershipLog
): NetworkMembershipGate | undefined {
	if (predicate === undefined) return undefined;
	// NOTE: a faulty predicate logs once per classification — several times per peer per lookup —
	// unthrottled. Debug-namespace only; if it floods an operator's log, log once per peer per fault kind.
	return (peerId: string): boolean => {
		if (peerId === selfPeerId) return true;
		let verdict: unknown;
		try {
			verdict = predicate(peerId);
		} catch (err) {
			log('network-membership:predicate-threw peer=%s - refused %o', peerId, err);
			return false;
		}
		if (verdict === true || verdict === false) return verdict;
		log('network-membership:non-boolean peer=%s verdict=%o - refused (the predicate must return true or false synchronously)', peerId, verdict);
		if (verdict instanceof Promise) {
			// Never awaited, so a rejection would otherwise surface as an unhandled one.
			void verdict.catch(err => log('network-membership:async-predicate-rejected peer=%s - %o', peerId, err));
		}
		return false;
	};
}
