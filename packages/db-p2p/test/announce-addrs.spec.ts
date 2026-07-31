/**
 * Pins `NodeOptions.announceAddrs` / `appendAnnounceAddrs` — the passthrough to libp2p's
 * `addresses.announce` / `addresses.appendAnnounce` (`AddressManagerInit`) added so a node behind
 * a NAT / reverse proxy / DNS front can advertise a reachable address that differs from the one it
 * actually binds. Pure passthrough, so these specs exercise real libp2p nodes over loopback rather
 * than mocking `createLibp2p`, per the `relay-address-propagation.spec.ts` pattern.
 */
import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import { createLibp2pNode } from '../src/libp2p-node.js';

const ANNOUNCE_ADDR = '/dns4/example.com/tcp/4321';
const LISTEN_ADDR = '/ip4/127.0.0.1/tcp/0';

function isLoopbackTcp(addr: string): boolean {
	return addr.includes('/ip4/127.0.0.1/tcp/');
}

function isAnnounced(addr: string): boolean {
	return addr.startsWith(ANNOUNCE_ADDR);
}

describe('NodeOptions announce address passthrough', function () {
	this.timeout(40_000);

	let node: Libp2p | undefined;

	afterEach(async () => {
		const toStop = node;
		node = undefined;
		await toStop?.stop();
	});

	it('with neither option set, advertises only the listen addr (unchanged default behavior)', async () => {
		node = await createLibp2pNode({
			bootstrapNodes: [],
			networkName: 'test-announce-default',
			listenAddrs: [LISTEN_ADDR],
			arachnode: { enableRingZulu: false }
		});

		const addrs = node.getMultiaddrs().map(a => a.toString());
		expect(addrs.some(isLoopbackTcp), `expected a loopback TCP addr, got: ${addrs.join(', ')}`).to.equal(true);
		expect(addrs.some(isAnnounced), `expected no announced addr, got: ${addrs.join(', ')}`).to.equal(false);
	});

	it('with announceAddrs set, advertises ONLY the announced addr, not the listen addr', async () => {
		node = await createLibp2pNode({
			bootstrapNodes: [],
			networkName: 'test-announce-replace',
			listenAddrs: [LISTEN_ADDR],
			announceAddrs: [ANNOUNCE_ADDR],
			arachnode: { enableRingZulu: false }
		});

		const addrs = node.getMultiaddrs().map(a => a.toString());
		expect(addrs.some(isAnnounced), `expected the announced addr, got: ${addrs.join(', ')}`).to.equal(true);
		expect(addrs.some(isLoopbackTcp), `expected no loopback listen addr, got: ${addrs.join(', ')}`).to.equal(false);
	});

	it('with appendAnnounceAddrs set, advertises the listen addr PLUS the appended addr', async () => {
		node = await createLibp2pNode({
			bootstrapNodes: [],
			networkName: 'test-announce-append',
			listenAddrs: [LISTEN_ADDR],
			appendAnnounceAddrs: [ANNOUNCE_ADDR],
			arachnode: { enableRingZulu: false }
		});

		const addrs = node.getMultiaddrs().map(a => a.toString());
		expect(addrs.some(isLoopbackTcp), `expected the loopback listen addr, got: ${addrs.join(', ')}`).to.equal(true);
		expect(addrs.some(isAnnounced), `expected the appended addr, got: ${addrs.join(', ')}`).to.equal(true);
	});
});
