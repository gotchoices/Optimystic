/**
 * `holePunchingWanted`: whether `createLibp2pNodeBase` registers libp2p's hole-punching service.
 * A node runs it only when it advertises an address another machine could dial directly, unless
 * `NodeOptions.holePunching` says otherwise. Pure, so this spec boots no node.
 */
import { expect } from 'chai';
import { holePunchingWanted, type HolePunchingInputs } from '../src/network/hole-punching.js';

const RELAY_ID = '12D3KooWAtsbgzunPgZAuj5BrRVfNWAvJK5yCEakkL8iqZzDiaML';

const cases: ReadonlyArray<{ name: string; inputs: HolePunchingInputs; wanted: boolean }> = [
	{ name: 'no listen address', inputs: { listenAddrs: [] }, wanted: false },
	{ name: 'a bare circuit listener', inputs: { listenAddrs: ['/p2p-circuit'] }, wanted: false },
	{ name: 'a relay-naming circuit listener', inputs: { listenAddrs: [`/ip4/127.0.0.1/tcp/4003/ws/p2p/${RELAY_ID}/p2p-circuit`] }, wanted: false },
	{ name: 'an IPv4 loopback listener', inputs: { listenAddrs: ['/ip4/127.0.0.1/tcp/0'] }, wanted: false },
	{ name: 'an IPv6 loopback listener', inputs: { listenAddrs: ['/ip6/::1/tcp/0/ws'] }, wanted: false },
	{ name: 'a wildcard listener', inputs: { listenAddrs: ['/ip4/0.0.0.0/tcp/0'] }, wanted: true },
	{ name: 'a private LAN listener', inputs: { listenAddrs: ['/ip4/192.168.1.5/tcp/4001'] }, wanted: true },
	{
		name: 'a loopback listener announced by DNS (a reverse proxy)',
		inputs: { listenAddrs: ['/ip4/127.0.0.1/tcp/0'], announceAddrs: ['/dns4/example.com/tcp/443/wss'] },
		wanted: true
	},
	{
		name: 'a circuit listener with a public address appended',
		inputs: { listenAddrs: ['/p2p-circuit'], appendAnnounceAddrs: ['/ip4/203.0.113.7/tcp/4001'] },
		wanted: true
	},
	{ name: 'forced on with no listen address', inputs: { holePunching: true, listenAddrs: [] }, wanted: true },
	{ name: 'forced off with a wildcard listener', inputs: { holePunching: false, listenAddrs: ['/ip4/0.0.0.0/tcp/0'] }, wanted: false },
	{ name: 'an address that does not parse', inputs: { listenAddrs: ['not-a-multiaddr'] }, wanted: true }
];

describe('holePunchingWanted (a node no peer can dial directly leaves out hole punching)', () => {
	for (const { name, inputs, wanted } of cases) {
		it(`${name} → ${wanted ? 'on' : 'off'}`, () => {
			expect(holePunchingWanted(inputs)).to.equal(wanted);
		});
	}
});
