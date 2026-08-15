import type { PeerId } from '@libp2p/interface'
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr'

/**
 * Cap on addresses merged per peer from one application-level message.
 *
 * Without a cap, a crafted cluster record or redirect payload could stuff the address
 * book and turn every cohort member into a dial amplifier aimed at an address of the
 * sender's choosing. A cohort's peer *ids* are keyspace-determined and not attacker-
 * chosen, which bounds the surface further; this bounds the per-peer cost.
 */
export const MAX_MERGED_ADDRS_PER_PEER = 8

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
