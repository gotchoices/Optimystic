import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { MockNode } from '../../src/testing/cohort-topic-mesh-harness.js';
import { handleRequestResponse, NoResultReplyError } from '../../src/cohort-topic/stream-util.js';
import { FretTopicRouter } from '../../src/cohort-topic/topic-router.js';
import { PROTOCOL_COHORT_REGISTER } from '../../src/cohort-topic/protocols.js';
import { peerIdToBytes } from '../../src/cohort-topic/peer-codec.js';

/**
 * `FretTopicRouter.dialMember` — the direct `/register` dial to a cached primary — over the real
 * request/response framing. The `/register` responder always writes a frame, so a no-result reply can only
 * come from a non-conforming peer; the router rejects it (the walk and renewal treat that as a failed dial)
 * rather than handing db-core empty bytes to decode.
 */
describe('cohort-topic: topic router direct dial', () => {
	async function makePair(): Promise<{ client: MockNode; member: MockNode }> {
		const registry = new Map<string, MockNode>();
		const down = new Set<string>();
		const keys = await Promise.all([generateKeyPair('Ed25519'), generateKeyPair('Ed25519')]);
		const [client, member] = keys.map(k => new MockNode(peerIdFromPrivateKey(k), registry, down)) as [MockNode, MockNode];
		for (const node of [client, member]) {
			registry.set(node.peerId.toString(), node);
		}
		return { client, member };
	}

	const activity = new Uint8Array([1, 2, 3]);

	it('returns the member\'s /register reply bytes', async () => {
		const { client, member } = await makePair();
		const replyBytes = new Uint8Array([9, 9, 9]);
		handleRequestResponse(member as never, PROTOCOL_COHORT_REGISTER, frame => {
			expect([...frame], 'the member reads the activity frame verbatim').to.deep.equal([...activity]);
			return Promise.resolve(replyBytes);
		});
		const router = new FretTopicRouter(client as never, {} as never);

		const reply = await router.dialMember({ id: peerIdToBytes(member.peerId) }, activity);

		expect([...reply]).to.deep.equal([...replyBytes]);
	});

	it('rejects with NoResultReplyError when the member replies with no result', async () => {
		const { client, member } = await makePair();
		let served = 0;
		handleRequestResponse(member as never, PROTOCOL_COHORT_REGISTER, () => {
			served++;
			return Promise.resolve(undefined);
		});
		const router = new FretTopicRouter(client as never, {} as never);

		const err = await router.dialMember({ id: peerIdToBytes(member.peerId) }, activity)
			.then(() => undefined, (e: unknown) => e);

		expect(served, 'the member\'s handler really ran (not a dial failure)').to.equal(1);
		expect(err).to.be.instanceOf(NoResultReplyError);
		expect((err as Error).message).to.contain('cohort-topic register dial');
	});
});
