import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { hashKey, type NearAnchorV1, type RouteAndMaybeActV1 } from 'p2p-fret';
import {
	bytesToB64url,
	b64urlToBytes,
	createRingHash,
	createTierAddressing,
	createWalkEngine,
	decodeRegisterV1,
	type RegisterMessageFactory,
} from '@optimystic/db-core';
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

/**
 * `FretTopicRouter.routeAndAct` under the walk: FRET's `routeAct` hashes the key it is handed into the ring
 * position it routes to, so the walk must hand it the preimage of each tier's coordinate. The position FRET
 * acts at has to be the coordinate the host serves (`addressing.coord`), or on a ring wider than one cohort
 * the frame reaches machines that do not serve the topic.
 */
describe('cohort-topic: topic router lands each walk step on its tier coordinate', () => {
	const addressing = createTierAddressing(createRingHash());
	const self = new TextEncoder().encode('router-walk-participant');
	const topicId = new Uint8Array(32).fill(7);

	const factory: RegisterMessageFactory = {
		build: async ({ topicId: t, tier, treeTier, bootstrap, rootKey }) => ({
			v: 1,
			topicId: bytesToB64url(t),
			tier,
			treeTier,
			participantCoord: bytesToB64url(self),
			ttl: 90_000,
			...(bootstrap ? { bootstrap: true } : {}),
			...(rootKey ? { rootKey: bytesToB64url(rootKey) } : {}),
			timestamp: 1_000,
			correlationId: bytesToB64url(new Uint8Array(16).fill(treeTier)),
			signature: bytesToB64url(new Uint8Array(8)),
		}),
	};

	/** Walk from tier 2 over a FRET that reaches no cohort (every step `no_state`), recording each routed frame. */
	async function walkSteps(rootKey?: Uint8Array): Promise<{ treeTier: number; key: Uint8Array }[]> {
		const routed: RouteAndMaybeActV1[] = [];
		const fret = {
			routeAct: async (msg: RouteAndMaybeActV1): Promise<NearAnchorV1> => {
				routed.push(msg);
				return { v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: 0, confidence: 0 };
			},
		};
		// No `rootGroupMembers`, so the router has no `routeToRoot` and a root-placed root step rides `routeAndAct`.
		const router = new FretTopicRouter({} as never, fret as never);
		const walk = createWalkEngine({ router, addressing, dmax: { dMax: () => 2 }, self, factory });
		await walk.register(topicId, 1, undefined, rootKey === undefined ? undefined : { rootKey });
		return routed.map((msg) => ({ treeTier: decodeRegisterV1(b64urlToBytes(msg.activity!)).treeTier, key: b64urlToBytes(msg.key) }));
	}

	it('the hash FRET takes of every routed key is the coordinate the host serves, with and without a root key', async () => {
		for (const rootKey of [undefined, new TextEncoder().encode('tail-block-id')]) {
			const label = rootKey === undefined ? 'default addressing' : 'root-placed';
			const steps = await walkSteps(rootKey);
			expect(steps.map((s) => s.treeTier), `${label}: tiers 2, 1, 0, then the root bootstrap re-issue`).to.deep.equal([2, 1, 0, 0]);
			for (const { treeTier, key } of steps) {
				const position = await hashKey(key);
				const served = addressing.coord(treeTier, self, topicId, rootKey);
				expect(bytesToB64url(position), `${label}: tier ${treeTier} lands on coord_${treeTier}`).to.equal(bytesToB64url(served));
			}
		}
	});
});
