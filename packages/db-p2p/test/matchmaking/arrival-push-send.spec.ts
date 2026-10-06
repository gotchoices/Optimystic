/**
 * Matchmaking arrival push — reading a seeker's contact hint (`docs/matchmaking.md` §Edge cases & interactions,
 * seeker reachable only through a relay). The send binding dials whatever peer the hint names, so a hint must
 * name the seeker itself: a circuit address that stops at `/p2p-circuit` names only the relay.
 */

import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { contactHintTarget } from '../../src/matchmaking/arrival-push-send.js';

async function newPeerId(): Promise<string> {
	return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

describe('matchmaking / arrival push contact hint', () => {
	it('reads a bare peer id or a multiaddr ending in /p2p/<id>, and nothing that does not name the seeker', async () => {
		const seeker = await newPeerId();
		const relay = await newPeerId();
		const direct = `/ip4/127.0.0.1/tcp/4002/p2p/${seeker}`;
		const circuit = `/ip4/10.0.0.1/tcp/4001/p2p/${relay}/p2p-circuit/p2p/${seeker}`;

		const bare = contactHintTarget(seeker);
		expect(bare?.peerId.toString(), 'a bare peer id names the seeker').to.equal(seeker);
		expect(bare?.addr, 'a bare peer id carries no address to merge').to.equal(undefined);

		const viaDirect = contactHintTarget(direct);
		expect(viaDirect?.peerId.toString(), 'a direct multiaddr names the seeker').to.equal(seeker);
		expect(viaDirect?.addr, 'and is the address to merge').to.equal(direct);
		expect(contactHintTarget(circuit)?.peerId.toString(), 'a circuit address names the seeker behind the relay, not the relay').to.equal(seeker);

		expect(contactHintTarget(`/ip4/10.0.0.1/tcp/4001/p2p/${relay}/p2p-circuit`), 'a circuit address naming only the relay').to.equal(undefined);
		expect(contactHintTarget('/ip4/127.0.0.1/tcp/4002'), 'a multiaddr naming no peer').to.equal(undefined);
		expect(contactHintTarget('not a hint'), 'neither form').to.equal(undefined);
	});
});
