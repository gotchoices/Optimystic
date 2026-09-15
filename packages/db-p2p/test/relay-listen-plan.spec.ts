/**
 * `planRelayListenAddrs`: the listen-address rewrite `createLibp2pNodeBase` applies before it builds
 * libp2p's options. A relay-naming circuit listen address becomes a bare `/p2p-circuit` entry plus a
 * supervised relay; everything else passes through untouched. Pure, so this spec boots no node.
 */
import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import { CIRCUIT_SEARCH_LISTEN_ADDR, planRelayListenAddrs } from '../src/network/relay-reservation.js';

const TCP = '/ip4/0.0.0.0/tcp/4001';
const WS = '/ip4/0.0.0.0/tcp/4002/ws';

describe('planRelayListenAddrs (relay-naming listen addresses become supervised bare listeners)', () => {
	let relayA: PeerId;
	let relayB: PeerId;

	before(async () => {
		relayA = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
		relayB = peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
	});

	const wsDial = (relay: PeerId): string => `/ip4/127.0.0.1/tcp/4003/ws/p2p/${relay.toString()}`;
	const tcpDial = (relay: PeerId): string => `/ip4/127.0.0.1/tcp/4004/p2p/${relay.toString()}`;

	it('turns a relay-naming address into one bare entry and one supervised relay', () => {
		const plan = planRelayListenAddrs([`${wsDial(relayA)}/p2p-circuit`]);
		expect(plan.listenAddrs).to.deep.equal([CIRCUIT_SEARCH_LISTEN_ADDR]);
		expect(plan.supervisedRelays).to.deep.equal([{ dialAddr: wsDial(relayA), peerId: relayA.toString() }]);
	});

	it("passes a host's own bare /p2p-circuit through unsupervised", () => {
		const plan = planRelayListenAddrs([CIRCUIT_SEARCH_LISTEN_ADDR]);
		expect(plan.listenAddrs).to.deep.equal([CIRCUIT_SEARCH_LISTEN_ADDR]);
		expect(plan.supervisedRelays).to.deep.equal([]);
	});

	it('leaves TCP and WebSocket entries untouched, in place', () => {
		const plan = planRelayListenAddrs([TCP, `${wsDial(relayA)}/p2p-circuit`, WS]);
		expect(plan.listenAddrs).to.deep.equal([TCP, CIRCUIT_SEARCH_LISTEN_ADDR, WS]);
		expect(plan.supervisedRelays.map(r => r.peerId)).to.deep.equal([relayA.toString()]);
	});

	it('gives two relays two bare entries — libp2p keeps listen addresses as a plain array, one listener each', () => {
		const plan = planRelayListenAddrs([`${wsDial(relayA)}/p2p-circuit`, `${wsDial(relayB)}/p2p-circuit`]);
		expect(plan.listenAddrs).to.deep.equal([CIRCUIT_SEARCH_LISTEN_ADDR, CIRCUIT_SEARCH_LISTEN_ADDR]);
		expect(plan.supervisedRelays.map(r => r.peerId)).to.deep.equal([relayA.toString(), relayB.toString()]);
	});

	it('gives two addresses naming one relay a single entry, keeping the first dial address', () => {
		const plan = planRelayListenAddrs([`${wsDial(relayA)}/p2p-circuit`, `${tcpDial(relayA)}/p2p-circuit`]);
		expect(plan.listenAddrs).to.deep.equal([CIRCUIT_SEARCH_LISTEN_ADDR]);
		expect(plan.supervisedRelays).to.deep.equal([{ dialAddr: wsDial(relayA), peerId: relayA.toString() }]);
	});

	it('normalizes a CID-form relay id to the base58 form PeerId.toString() produces', () => {
		const cidForm = relayA.toCID().toString();
		expect(cidForm, 'the test must actually use a different spelling').to.not.equal(relayA.toString());
		const plan = planRelayListenAddrs([`/ip4/127.0.0.1/tcp/4003/ws/p2p/${cidForm}/p2p-circuit`]);
		expect(plan.supervisedRelays.map(r => r.peerId)).to.deep.equal([relayA.toString()]);
		// One relay, whichever spelling each entry used.
		const both = planRelayListenAddrs([`${wsDial(relayA)}/p2p-circuit`, `/ip4/127.0.0.1/tcp/4003/ws/p2p/${cidForm}/p2p-circuit`]);
		expect(both.listenAddrs).to.deep.equal([CIRCUIT_SEARCH_LISTEN_ADDR]);
	});

	it('leaves malformed, multi-hop and non-terminal circuit entries for libp2p to reject', () => {
		const untouched = [
			'not-a-multiaddr',
			`${wsDial(relayA)}/p2p-circuit/p2p/${relayB.toString()}/p2p-circuit`,
			`${wsDial(relayA)}/p2p-circuit/p2p/${relayB.toString()}`,
			'/ip4/127.0.0.1/tcp/4003/ws/p2p-circuit',
			'/ip4/127.0.0.1/tcp/4003/ws/p2p/not-a-peer-id/p2p-circuit'
		];
		const plan = planRelayListenAddrs(untouched);
		expect(plan.listenAddrs).to.deep.equal(untouched);
		expect(plan.supervisedRelays).to.deep.equal([]);
	});

	it('returns nothing to supervise for an empty or purely direct listen set', () => {
		expect(planRelayListenAddrs([])).to.deep.equal({ listenAddrs: [], supervisedRelays: [] });
		expect(planRelayListenAddrs([TCP, WS])).to.deep.equal({ listenAddrs: [TCP, WS], supervisedRelays: [] });
	});
});
