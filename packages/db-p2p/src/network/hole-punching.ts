/**
 * Whether a node runs libp2p's hole-punching service (`@libp2p/dcutr`).
 *
 * dcutr acts only on a relayed connection, and only through the addresses each side advertises:
 * the side that received the connection first dials the other directly if the other advertises a
 * public address, and otherwise makes up to three relayed attempts to swap address lists, each
 * side discarding every circuit, loopback and private address in the other's list. So for a node
 * that advertises nothing another machine can dial — no listen address, or only a relay or
 * loopback one — the relayed attempts can never succeed, and each relayed connection to it spends
 * three streams finding that out. Such a node is built without the service; leaving it out on
 * either side of a pair silences the pair, because dcutr starts only toward a peer that also runs
 * it.
 */
import { multiaddr, type Component } from '@multiformats/multiaddr';
import { createLogger } from '../logger.js';

/** The rule runs only while a node is being built, so its one line joins the construction log. */
const log = createLogger('node-wiring');

export interface HolePunchingInputs {
	/** `NodeOptions.holePunching`: an explicit boolean wins outright. */
	holePunching?: boolean;
	/** The listen addresses libp2p is given — after `planRelayListenAddrs` rewrote relay entries. */
	listenAddrs: readonly string[];
	announceAddrs?: readonly string[];
	appendAnnounceAddrs?: readonly string[];
}

/** First components that name a host by DNS. dcutr treats every such address as public. */
const DNS_PROTOCOLS = new Set(['dns', 'dns4', 'dns6', 'dnsaddr']);

/** True when the node should run libp2p's `dcutr` service. */
export function holePunchingWanted(inputs: HolePunchingInputs): boolean {
	if (inputs.holePunching !== undefined) return inputs.holePunching;
	return advertisedAddrs(inputs).some(isDirectlyDialable);
}

/** The addresses libp2p will advertise: a non-empty `announceAddrs` replaces everything else, as libp2p does. */
function advertisedAddrs(inputs: HolePunchingInputs): readonly string[] {
	if (inputs.announceAddrs !== undefined && inputs.announceAddrs.length > 0) return inputs.announceAddrs;
	return [...inputs.listenAddrs, ...(inputs.appendAnnounceAddrs ?? [])];
}

/**
 * True when another machine could dial `addr` directly: not through a relay, and a DNS name or an
 * IP host other than loopback. A wildcard or private LAN bind counts — it is how a machine behind
 * a NAT listens, and hole punching can succeed there.
 */
function isDirectlyDialable(addr: string): boolean {
	let components: Component[];
	try {
		components = multiaddr(addr).getComponents();
	} catch (err) {
		// Counted as dialable, which keeps the service as before; libp2p refuses the address itself
		// when it starts listening.
		log('WARN: invalid multiaddr %s %o', addr, err);
		return true;
	}
	if (components.some(c => c.name === 'p2p-circuit')) return false;
	const host = components[0];
	if (host === undefined) return false;
	if (DNS_PROTOCOLS.has(host.name)) return true;
	if (host.name === 'ip4') return host.value?.startsWith('127.') !== true;
	// The parser writes an IPv6 host in its compressed form, so loopback is always `::1`.
	if (host.name === 'ip6') return host.value !== '::1';
	return false;
}
