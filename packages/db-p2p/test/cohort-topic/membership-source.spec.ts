import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { MockNode } from '../../src/testing/cohort-topic-mesh-harness.js';
import { handleRequestResponse } from '../../src/cohort-topic/stream-util.js';
import { FretMembershipSource } from '../../src/cohort-topic/membership-source.js';
import { PROTOCOL_COHORT_MEMBERSHIP } from '../../src/cohort-topic/protocols.js';

/**
 * `FretMembershipSource.fetch` over the real request/response framing. A cohort member with no published
 * certificate answers with no result (host.ts's membership responder replies `new Uint8Array(0)`), and fetch
 * must move on to the next member rather than caching or returning an empty certificate.
 */
describe('cohort-topic: membership source fetch', () => {
	const coord = new Uint8Array(32).fill(9);
	const cert = new Uint8Array([0, 0, 0, 2, 0x7b, 0x7d]);

	/** `n` in-process nodes on one registry, so a dial from one drives another's real handler. */
	async function makeNodes(n: number): Promise<MockNode[]> {
		const registry = new Map<string, MockNode>();
		const down = new Set<string>();
		const keys = await Promise.all(Array.from({ length: n }, () => generateKeyPair('Ed25519')));
		const nodes = keys.map(k => new MockNode(peerIdFromPrivateKey(k), registry, down));
		for (const node of nodes) {
			registry.set(node.peerId.toString(), node);
		}
		return nodes;
	}

	/** A membership responder: answers `reply`, recording which member was asked and for which coord. */
	function serveMembership(node: MockNode, reply: Uint8Array | undefined, asked: string[]): void {
		handleRequestResponse(node as never, PROTOCOL_COHORT_MEMBERSHIP, frame => {
			expect([...frame], 'the membership request frame is the raw coord').to.deep.equal([...coord]);
			asked.push(node.peerId.toString());
			return Promise.resolve(reply);
		});
	}

	it('skips a member with no certificate and returns + caches the next member\'s', async () => {
		const [client, empty, holder] = await makeNodes(3) as [MockNode, MockNode, MockNode];
		const asked: string[] = [];
		serveMembership(empty, new Uint8Array(0), asked); // host.ts's "no certificate" reply
		serveMembership(holder, cert, asked);
		const source = new FretMembershipSource(client as never, {
			cohortPeers: () => [empty.peerId.toString(), holder.peerId.toString()],
		});

		const fetched = await source.fetch(coord);

		expect(asked, 'the empty member was asked first, then the holder').to.deep.equal([empty.peerId.toString(), holder.peerId.toString()]);
		expect([...fetched!], 'fetch returns the holder\'s certificate').to.deep.equal([...cert]);
		expect(source.has(coord), 'the fetched certificate is cached').to.equal(true);
		expect([...(await source.current(coord))!]).to.deep.equal([...cert]);
	});

	it('resolves undefined and caches nothing when every member has no certificate', async () => {
		const [client, first, second] = await makeNodes(3) as [MockNode, MockNode, MockNode];
		const asked: string[] = [];
		serveMembership(first, undefined, asked);
		serveMembership(second, new Uint8Array(0), asked);
		const source = new FretMembershipSource(client as never, {
			cohortPeers: () => [first.peerId.toString(), second.peerId.toString()],
		});

		const fetched = await source.fetch(coord);

		expect(asked, 'every member was asked once').to.deep.equal([first.peerId.toString(), second.peerId.toString()]);
		expect(fetched).to.equal(undefined);
		expect(source.has(coord), 'nothing is cached from a no-result reply').to.equal(false);
	});
});
