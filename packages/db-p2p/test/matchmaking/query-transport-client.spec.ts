import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { Libp2p } from 'libp2p';
import type { FretService } from 'p2p-fret';
import {
	matchTopicId,
	bytesToB64url,
	providerSigningPayload,
	type CohortTopicService,
	type QueryV1,
	type RegisterReplyV1,
	type RegisterV1,
	type TopicTrafficV1,
} from '@optimystic/db-core';
import { createLibp2pMatchmakingTransport, createLibp2pMatchmakingSeekerSession } from '../../src/matchmaking/query-transport.js';
import { MatchmakingSeekerSession } from '../../src/matchmaking/module.js';
import { signPeer } from '../../src/cohort-topic/peer-sig.js';

/**
 * Client-side seeker query transport — the I/O-free branches the gated real-socket e2e (§5c of
 * `substrate-real-libp2p`) cannot reach (its seeker is always a *remote* node with a real primary that is
 * never itself): the no-primary / self-routed-primary handling, the `d_max` estimator wiring, and the
 * per-entry verifier. The happy dial paths (register/query over real sockets) are the e2e's job.
 *
 * Construction derives `seekerBytes` via `peerIdFromString(selfPeerId)`, so `selfPeerId` must be a real
 * peer-id string; we generate a key and use its peer id. The branches under test never dial, so a bare
 * `node` stub suffices.
 */
const topicId = matchTopicId('capability', 'pdf-render');

/** A FRET stub: `assembleCohort` returns a fixed cohort; `getNetworkSizeEstimate` feeds `d_max`. */
function fretStub(cohort: string[], sizeEstimate = 4096, confidence = 0.9): FretService {
	return {
		assembleCohort: (): string[] => cohort,
		getNetworkSizeEstimate: (): { size_estimate: number; confidence: number } => ({ size_estimate: sizeEstimate, confidence }),
	} as unknown as FretService;
}

function queryFor(): QueryV1 {
	return {
		v: 1,
		topicId: bytesToB64url(topicId),
		includeProviders: true,
		includeSeekers: false,
		limit: 256,
		requesterId: 'self-asserted',
		timestamp: 1,
		signature: 'AA',
	};
}

async function setup(opts: { cohort: (self: string) => string[]; sizeEstimate?: number; selfServe?: Parameters<typeof createLibp2pMatchmakingTransport>[0]['selfServe'] }) {
	const key = await generateKeyPair('Ed25519');
	const selfPeerId = peerIdFromPrivateKey(key).toString();
	const transport = createLibp2pMatchmakingTransport({
		node: {} as unknown as Libp2p,
		fret: fretStub(opts.cohort(selfPeerId), opts.sizeEstimate),
		selfPeerId,
		key,
		wantK: 4,
		...(opts.selfServe !== undefined ? { selfServe: opts.selfServe } : {}),
	});
	return { key, selfPeerId, transport };
}

describe('matchmaking / query transport (client side)', () => {
	it('estimateDMax binds FRET size estimate to the db-core d_max computer (F=16)', async () => {
		// floor(log_16(4096)) − 1 = 3 − 1 = 2.
		const { transport } = await setup({ cohort: () => ['other'], sizeEstimate: 4096 });
		expect(await transport.estimateDMax(topicId)).to.equal(2);
		// A tiny network clamps to 0 (max(0, …)).
		const { transport: tiny } = await setup({ cohort: () => ['other'], sizeEstimate: 4 });
		expect(await tiny.estimateDMax(topicId)).to.equal(0);
	});

	it('verifyEntry validates a real peer-key signature and rejects a tampered image', async () => {
		const { transport, selfPeerId, key } = await setup({ cohort: () => ['other'] });
		const payload = providerSigningPayload(topicId, ['gpu'], 4);
		const sig = await signPeer(key, payload);
		expect(transport.verifyEntry(selfPeerId, payload, sig), 'a genuine signature verifies').to.equal(true);
		const tampered = providerSigningPayload(topicId, ['gpu'], 99);
		expect(transport.verifyEntry(selfPeerId, tampered, sig), 'a tampered image is rejected').to.equal(false);
	});

	it('queryCohort returns a benign empty reply when FRET assembles no primary', async () => {
		const { transport } = await setup({ cohort: () => [] });
		const reply = await transport.queryCohort(queryFor());
		expect(reply.providers).to.deep.equal([]);
		expect(reply.topicTraffic.directParticipants).to.equal(0);
	});

	it('queryCohort throws a clear error on a self-routed primary with no selfServe hook', async () => {
		const { transport } = await setup({ cohort: (self) => [self] });
		let threw: Error | undefined;
		try {
			await transport.queryCohort(queryFor());
		} catch (err) {
			threw = err as Error;
		}
		expect(threw, 'a self-primary query without selfServe throws (loud, not a silent hang)').to.not.equal(undefined);
		expect(threw!.message).to.match(/self/i);
	});

	it('queryCohort routes a self-routed primary to selfServe.query when provided', async () => {
		const served: TopicTrafficV1 = { windowSeconds: 30, arrivalsPerMin: 1, queriesPerMin: 2, directParticipants: 3, childCohortCount: 0 };
		const { transport } = await setup({
			cohort: (self) => [self],
			selfServe: { query: async () => ({ v: 1, providers: [], truncated: false, cohortEpoch: '', topicTraffic: served, signature: '' }) },
		});
		const reply = await transport.queryCohort(queryFor());
		expect(reply.topicTraffic.directParticipants, 'the selfServe reply is returned').to.equal(3);
	});

	it('walk register returns no_state when FRET assembles no primary (cold cohort)', async () => {
		const { transport } = await setup({ cohort: () => [] });
		const probe = await transport.walkTransport(topicId).register(0);
		expect(probe.result).to.equal('no_state');
	});

	it('walk register throws on a self-routed primary with no selfServe hook', async () => {
		const { transport } = await setup({ cohort: (self) => [self] });
		let threw: Error | undefined;
		try {
			await transport.walkTransport(topicId).register(0);
		} catch (err) {
			threw = err as Error;
		}
		expect(threw, 'a self-primary register without selfServe throws').to.not.equal(undefined);
		expect(threw!.message).to.match(/self/i);
	});

	it('walk register maps a selfServe accepted RegisterReplyV1 to a probe reply carrying topicTraffic', async () => {
		const accepted: RegisterReplyV1 = {
			v: 1,
			result: 'accepted',
			topicTraffic: { windowSeconds: 30, arrivalsPerMin: 5, queriesPerMin: 0, directParticipants: 2, childCohortCount: 7 },
		};
		let signedSelfVouch = false;
		const { transport } = await setup({
			cohort: (self) => [self],
			selfServe: {
				register: async (reg: RegisterV1): Promise<RegisterReplyV1> => {
					// A tier-0 walk register is a bootstrap that must carry the self-vouch reputation envelope.
					signedSelfVouch = reg.bootstrap === true && reg.bootstrapEvidence !== undefined && reg.tier === 2;
					return accepted;
				},
			},
		});
		const probe = await transport.walkTransport(topicId).register(0);
		expect(signedSelfVouch, 'the tier-0 register is a self-vouched T2 bootstrap frame').to.equal(true);
		expect(probe.result).to.equal('accepted');
		expect(probe.topicTraffic, 'accepted probe carries the cohort topicTraffic').to.not.equal(undefined);
		expect(probe.topicTraffic!.childCohortCount).to.equal(7);
	});

	// The session convenience factory is otherwise only type-checked (the e2e drives the lower-level
	// transport directly). Construction + the `query` delegation are I/O-free, so a no-primary FRET stub
	// proves the wiring: the session resolves a topic id and routes `query` through the bound transport's
	// `queryCohort` (the benign empty-reply branch), and stays walk-only (`sweepPorts` unbound).
	it('createLibp2pMatchmakingSeekerSession wires a walk-only session whose query routes through the transport', async () => {
		const key = await generateKeyPair('Ed25519');
		const selfPeerId = peerIdFromPrivateKey(key).toString();
		const session = createLibp2pMatchmakingSeekerSession({
			node: {} as unknown as Libp2p,
			fret: fretStub([]), // no primary ⇒ queryCohort resolves the benign empty reply (no dial)
			selfPeerId,
			key,
			wantK: 4,
			service: {} as unknown as CohortTopicService, // only used by session.register, which we never call
		});
		expect(session, 'the factory returns a public seeker session').to.be.instanceOf(MatchmakingSeekerSession);
		expect(session.topicIdFor({ kind: 'capability', label: 'pdf-render' }), 'the session resolves a topic id')
			.to.deep.equal(topicId);
		const reply = await session.query(queryFor());
		expect(reply.providers, 'query delegates to the transport (empty reply, no primary)').to.deep.equal([]);
	});
});
