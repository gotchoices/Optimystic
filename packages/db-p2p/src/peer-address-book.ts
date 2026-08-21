import type { PeerId } from '@libp2p/interface'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr, type Component, type Multiaddr } from '@multiformats/multiaddr'

/**
 * Cap on addresses merged per peer from one application-level message.
 *
 * Without a cap, a crafted cluster record or redirect payload could stuff the address
 * book and turn every cohort member into a dial amplifier aimed at an address of the
 * sender's choosing. This bounds the per-peer cost;
 * {@link MAX_LEARNED_PEERS_PER_RECORD} bounds how many peers one record may introduce.
 */
export const MAX_MERGED_ADDRS_PER_PEER = 8

/**
 * Cap on how many distinct peers one cluster record may teach us addresses for.
 *
 * A record's peer map is NOT self-limiting: `ClusterService.processOperation` learns from it
 * before `checkRedirect` and before `cluster.update` validates a single signature, and inbound
 * stream authorization is opt-in (`authorizeInboundStream` is undefined by default), so the map
 * is attacker-authored at that point. One 1 MiB control message (`MAX_CONTROL_MESSAGE_BYTES`)
 * holds on the order of a thousand fabricated `{ id, multiaddrs, publicKey }` entries, each of
 * which would otherwise become a persisted peerStore record. Real cohorts are `clusterSize`
 * peers — single digits — so this is generous margin, not a functional limit.
 */
export const MAX_LEARNED_PEERS_PER_RECORD = 64

/** The narrow slice of libp2p this module needs — a peer id and (optionally) a peerStore writer. */
export interface PeerAddressBookHost {
	peerId: PeerId
	peerStore?: {
		merge?: (id: PeerId, data: { multiaddrs: Multiaddr[] }) => Promise<unknown>
	}
}

/** Log sink shaped like both `debug` loggers and libp2p's `Logger`. */
export type AddressLog = (fmt: string, ...args: unknown[]) => void

/**
 * Keep only the entries that parse as multiaddrs, logging (but not throwing on) the rest.
 *
 * The single validator for address strings arriving from the wire or from a connection —
 * `Libp2pKeyPeerNetwork.parseMultiaddrs` delegates here so there is one definition of
 * "an address string we are willing to carry".
 */
export function validMultiaddrStrings(addrs: string[], log: AddressLog): string[] {
	return addrs.filter(a => isCarriableMultiaddrString(a, log))
}

/** One address string's verdict, shared by {@link validMultiaddrStrings} and {@link publishableConnectionAddr}. */
function isCarriableMultiaddrString(addr: string, log: AddressLog): boolean {
	try {
		// An empty string parses as the root multiaddr `/` — syntactically fine, addresses
		// nothing, and encodes to zero bytes. Reject it so a blank entry can't occupy a slot
		// in the address book (or in the per-message cap).
		if (multiaddr(addr).bytes.length === 0) {
			log('WARN: multiaddr addresses nothing %s', addr)
			return false
		}
		return true
	} catch (err) {
		log('WARN: invalid multiaddr %s %o', addr, err)
		return false
	}
}

/**
 * The slice of a libp2p `Connection` that decides whether its remote address may be published.
 *
 * `direction` is populated on every connection libp2p creates; it is optional here only because
 * unit stubs build connection literals by hand — and a missing `direction` is deliberately treated
 * as NOT publishable, so a stub cannot silently opt back into the pre-fix behavior.
 */
export interface DirectionalConnection {
	direction?: 'inbound' | 'outbound'
	remoteAddr?: { toString?: () => string }
}

/**
 * A live connection's remote address, when it is one we may publish to a **third** party —
 * otherwise `undefined`.
 *
 * The companion to {@link validMultiaddrStrings}: that answers "an address string we are willing
 * to carry", this answers "an address we are willing to hand to someone else". They are not the
 * same question, because an inbound connection's `remoteAddr` is not an address at all in the
 * sense a third party needs. For an **outbound** connection it is the address we dialed — a real
 * listen (or circuit) address that anyone can reach the peer on. For an **inbound** one it is the
 * far side's *ephemeral source socket*: the port their operating system picked for this single
 * connection. It is reachable by nobody else, it is indistinguishable from a listen address once
 * it is on the wire, and it takes a slot against {@link MAX_MERGED_ADDRS_PER_PEER} in every peer
 * that merges it. So the cure has to be here, at the producer.
 *
 * An inbound-only peer loses nothing by this: its own advertised addresses reach us through
 * `identify`/`identifyPush` and are published from the peerStore instead.
 */
export function publishableConnectionAddr(conn: DirectionalConnection, log: AddressLog): string | undefined {
	if (conn.direction !== 'outbound') return undefined
	const addr = conn.remoteAddr?.toString?.()
	if (addr === undefined) return undefined
	return isCarriableMultiaddrString(addr, log) ? addr : undefined
}

/**
 * How useful the addresses we hold for a peer are **to this node's own dialer**.
 *
 * - `none` — we hold no address at all. Nobody has told us how to reach the peer.
 * - `self-relay-only` — we hold addresses, but every one of them reaches the peer by relaying
 *   through *us*. Useful to everyone except us: to use one we would have to relay to the peer
 *   through ourselves.
 * - `dialable` — at least one address does not route through us, so a dial can be attempted.
 */
export type SelfDialability = 'none' | 'self-relay-only' | 'dialable'

/**
 * Does `addr` reach its target by relaying through `relayPeerId`?
 *
 * A circuit multiaddr names its relay in the `p2p` component immediately BEFORE the
 * `p2p-circuit` marker — `/<transport>/p2p/<relay>/p2p-circuit[/p2p/<target>]`. So the question is
 * answered by walking the address's components, not by testing the string for `/p2p/<id>/p2p-circuit`:
 * the peer id after the marker (appended by libp2p's dial queue), a bare `/p2p-circuit` with no
 * relay named, and multi-hop addresses with two circuit markers all read differently as text but
 * classify correctly as components. True if ANY hop relays through `relayPeerId` — a chain that
 * passes through us at any point is one we cannot open ourselves.
 *
 * Called with our own peer id, this is the "can WE dial this?" question. It is deliberately NOT
 * the same question as {@link publishableConnectionAddr}'s: a self-relay address is perfectly
 * publishable — a cohort sibling reaching a peer through our relay is the working path — and is
 * simply unusable by the one node the circuit terminates on.
 */
export function routesThroughRelay(addr: string, relayPeerId: string, log: AddressLog): boolean {
	let components: Component[]
	try {
		components = multiaddr(addr).getComponents()
	} catch (err) {
		// Fail open. An address we cannot parse is not evidence of a self-relay loop, and the
		// caller's fallback — dial it and let libp2p reject it — is the pre-existing behavior.
		log('WARN: invalid multiaddr %s %o', addr, err)
		return false
	}
	return components.some((component, i) =>
		component.name === 'p2p-circuit' && isRelayComponent(components[i - 1], relayPeerId))
}

/**
 * True when `component` is the `p2p` hop naming `relayPeerId` (absent/other component → false).
 *
 * `relayPeerId` is always a `PeerId.toString()`, i.e. base58btc. A multiaddr's `p2p` value usually
 * is too — but it may equally be written as a CIDv1 libp2p-key string, and `@multiformats/multiaddr`
 * keeps whichever form it was given rather than normalizing. String equality alone would therefore
 * miss a CIDv1-form self-relay address arriving from the wire (`mergePeerAddresses` accepts any
 * parseable multiaddr). The canonical compare runs only when the cheap one fails, and only for the
 * single component sitting in front of a circuit marker, so the parse is bounded to circuit
 * addresses rather than paid per address.
 */
function isRelayComponent(component: Component | undefined, relayPeerId: string): boolean {
	if (component?.name !== 'p2p' || component.value === undefined) return false
	if (component.value === relayPeerId) return true
	try {
		return peerIdFromString(component.value).toString() === relayPeerId
	} catch {
		// multiaddr accepted the component but we cannot read it back as a peer id; we simply
		// cannot claim it is ours, and the address stays dialable-as-far-as-we-know.
		return false
	}
}

/**
 * Classify what the addresses we hold for one peer are worth to our own dialer.
 *
 * `self-relay-only` is the state a relay lands in for its own reservation holders: the address
 * such a client advertises — and therefore the one we learn through `identifyPush` and store — is
 * `/<our transport addr>/p2p/<our peer id>/p2p-circuit`. Dialing it is guaranteed to fail, and the
 * failure is indistinguishable from `none` in libp2p's error text, so the two are separated here
 * instead. Nothing can repair it from our side: once the client's connection drops only the client
 * can re-initiate, so the useful response is to fail fast and let the caller move on.
 */
export function classifySelfDialability(addrs: string[], selfPeerId: string, log: AddressLog): SelfDialability {
	if (addrs.length === 0) return 'none'
	return addrs.some(addr => !routesThroughRelay(addr, selfPeerId, log)) ? 'dialable' : 'self-relay-only'
}

/**
 * Write dialable addresses for `peerId` into the libp2p address book, from addresses
 * carried by an application-level message.
 *
 * Trust boundary: a merged multiaddr only makes a dial *attempt* possible. The dialed
 * peer still authenticates by peer id at the noise handshake, so an address taken from
 * a record we have not otherwise verified can waste a dial but can never impersonate.
 * That is precisely why it is safe to consume addresses from an unverified message —
 * and why the cost, not the authenticity, is what needs bounding (see
 * {@link MAX_MERGED_ADDRS_PER_PEER}).
 */
export function mergePeerAddresses(
	host: PeerAddressBookHost,
	peerId: PeerId,
	addrs: string[],
	log: AddressLog
): void {
	// A self entry is meaningless to our own dialer and, for a relay-only self, self-referential.
	if (peerId.toString() === host.peerId.toString()) return
	if (addrs.length === 0) return

	const merge = host.peerStore?.merge
	if (typeof merge !== 'function') return

	const valid = validMultiaddrStrings(addrs, log)
	if (valid.length === 0) return
	if (valid.length > MAX_MERGED_ADDRS_PER_PEER) {
		log('peer-address-book:capped peer=%s offered=%d kept=%d',
			peerId.toString().substring(0, 12), valid.length, MAX_MERGED_ADDRS_PER_PEER)
	}
	const multiaddrs = valid.slice(0, MAX_MERGED_ADDRS_PER_PEER).map(a => multiaddr(a))

	log('peer-address-book:merge peer=%s addrs=%d', peerId.toString().substring(0, 12), multiaddrs.length)
	// `merge` is async and nothing downstream awaits the address book — the very next dial
	// either sees the entry or falls back to the same failure it had before. Log a rejection
	// rather than swallowing it: a persistently failing peerStore is exactly the condition
	// that would make this whole mechanism silently inert.
	void Promise.resolve(merge.call(host.peerStore, peerId, { multiaddrs }))
		.catch((err: unknown) => log('WARN: peerStore.merge failed peer=%s %o', peerId.toString().substring(0, 12), err))
}

/** The peer map a `ClusterRecord` carries, as it arrives off the wire (nothing about it is trusted). */
export type RecordPeerMap = Record<string, { multiaddrs?: string[] } | undefined>

/**
 * Offer the addresses a cluster record carries for its cohort to an address-book `sink`, one
 * peer at a time.
 *
 * The one traversal shared by both record ingress points — `ClusterService` (inbound, from the
 * coordinator) and `ClusterClient` (outbound, from a member's reply) — so the entries a record is
 * allowed to introduce are bounded in one place rather than two. Entries with no addresses, with
 * an id equal to `skipId`, or with an unparseable id are dropped; everything past
 * {@link MAX_LEARNED_PEERS_PER_RECORD} candidates is dropped with a log line. The per-address
 * validation, the per-peer cap, and the trust boundary live behind `sink`
 * (see {@link mergePeerAddresses}).
 */
export function mergeRecordPeerAddresses(
	peers: RecordPeerMap | undefined,
	sink: (peerId: PeerId, addrs: string[]) => void,
	log: AddressLog,
	skipId?: string
): void {
	let offered = 0
	for (const [idStr, peer] of Object.entries(peers ?? {})) {
		const addrs = peer?.multiaddrs ?? []
		if (addrs.length === 0 || idStr === skipId) continue
		if (offered >= MAX_LEARNED_PEERS_PER_RECORD) {
			// Count candidates, not successes, so a record full of unparseable ids cannot spend
			// unbounded parse attempts and log lines either.
			log('peer-address-book:record-capped kept=%d', MAX_LEARNED_PEERS_PER_RECORD)
			return
		}
		offered += 1
		let pid: PeerId
		try {
			pid = peerIdFromString(idStr)
		} catch (err) {
			// An id we cannot parse is not dialable by any route; the consensus path surfaces the
			// resulting membership failure on its own.
			log('WARN: record carried an unparseable peer id %s %o', idStr, err)
			continue
		}
		sink(pid, addrs)
	}
}
