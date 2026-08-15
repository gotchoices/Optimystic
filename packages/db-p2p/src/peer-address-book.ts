import type { PeerId } from '@libp2p/interface'
import { peerIdFromString } from '@libp2p/peer-id'
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr'

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
	const out: string[] = []
	for (const a of addrs) {
		try {
			// An empty string parses as the root multiaddr `/` — syntactically fine, addresses
			// nothing, and encodes to zero bytes. Reject it so a blank entry can't occupy a slot
			// in the address book (or in the per-message cap).
			if (multiaddr(a).bytes.length === 0) {
				log('WARN: multiaddr addresses nothing %s', a)
				continue
			}
			out.push(a)
		} catch (err) {
			log('WARN: invalid multiaddr %s %o', a, err)
		}
	}
	return out
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
