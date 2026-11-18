import { expect } from 'chai';
import type { PrivateKey } from '@libp2p/interface';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import type { FretService } from 'p2p-fret';
import {
	b64urlToBytes,
	bytesToB64url,
	createMatchTopicAnchor,
	createTierAddressing,
	decodeCohortMessage,
	decodeQueryReplyV1,
	encodeCohortMessage,
	encodeQueryV1,
	validateRegisterReplyV1,
	verifyProviderEntry,
	DEFAULT_MIN_SIGS,
	QUERY_LIMIT_MAX,
	RingHash,
} from '@optimystic/db-core';
import { waitFor } from '@optimystic/db-core/test';
import { createLibp2pNode } from '../src/libp2p-node.js';
import type { OptimysticNode } from '../src/optimystic-node.js';
import { resolveRenew, type CohortTopicHost } from '../src/cohort-topic/host.js';
import { FretTopicRouter } from '../src/cohort-topic/topic-router.js';
import { signPeer, verifyPeerSig } from '../src/cohort-topic/peer-sig.js';
import { MatchmakingProviderSession, type MatchTopicRef } from '../src/matchmaking/module.js';
import { createLibp2pMatchmakingSeekerSession, createMatchmakingQueryHandler, type MatchmakingSelfServe } from '../src/matchmaking/query-transport.js';
import { pickLocalTcpMultiaddr } from './util/multiaddrs.js';

// GitHub #67: on a network of one, two or three machines, every matchmaking registration was refused, because a
// topic's cohort asked for a majority of the default cohort size (9 of 16) to be willing and such a network has at
// most three machines. The admission quorum is now a majority of the cohort as it is (docs/cohort-topic.md
// §Admission quorum). This runs the public matchmaking sessions over real TCP at each of those sizes with the
// cohort-topic layer at its defaults — no `wantK` or `minSigs` override, unlike every other real-socket matchmaking
// case, which sets `wantK` to the node count and so never met the defect.
//
// The seeker is bound to an in-process answer for messages its own node must serve (`selfServe`), built from the
// node's host by hand: a node does not offer one ready-made yet (backlog `feat-node-offers-matchmaking-self-serve`).
// On two and three machines the seeker walks from a node that is not the topic's routed member, so its register and
// query cross a real socket. On one machine the seeker is the provider's own node: its walk looks without registering
// (a seeker register would replace the provider's registration, one per machine per topic), and the provider must
// still be listed once the walk has ended.
//
// Gated on OPTIMYSTIC_INTEGRATION=1 like the other real-socket specs:
//   yarn workspace @optimystic/db-p2p test:integration

const GATED = process.env.OPTIMYSTIC_INTEGRATION === '1' || process.env.RUN_LONG_TESTS === '1';

/** The cohort size a node assembles when `cohortTopic.wantK` is left unset. */
const NODE_DEFAULT_WANT_K = 16;

interface Machine {
	readonly node: OptimysticNode;
	readonly key: PrivateKey;
	readonly id: string;
	readonly host: CohortTopicHost;
	readonly fret: FretService;
}

async function startMachine(networkName: string, machines: number, bootstrapNodes: string[]): Promise<Machine> {
	const key = await generateKeyPair('Ed25519');
	const node = await createLibp2pNode({
		port: 0,
		networkName,
		bootstrapNodes,
		privateKey: key,
		clusterSize: machines,
		clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
		cohortTopic: { enabled: true },
	});
	// Neither handle is on the node's typed attachment surface (backlog `debt-node-attachment-reads-bypass-typed-surface`).
	const handles = node as unknown as { cohortTopicHost: CohortTopicHost; services: { fret: FretService } };
	return { node, key, id: peerIdFromPrivateKey(key).toString(), host: handles.cohortTopicHost, fret: handles.services.fret };
}

/** Every machine connected to every other, and every machine's ring naming all of them around `coord`. */
async function meshAround(machines: Machine[], coord: Uint8Array): Promise<void> {
	const addrs = machines.map((m) => pickLocalTcpMultiaddr(m.node));
	for (const m of machines) {
		for (const addr of addrs) {
			try { await m.node.dial(multiaddr(addr)); } catch { /* self, or a peer that already dialed us */ }
		}
	}
	await waitFor(() => machines.every((m) => m.node.getPeers().length >= machines.length - 1),
		{ timeoutMs: 60_000, intervalMs: 250, description: 'the mesh fully connected' });
	await waitFor(() => machines.every((m) => new Set(m.fret.assembleCohort(coord, NODE_DEFAULT_WANT_K)).size === machines.length),
		{ timeoutMs: 90_000, intervalMs: 250, description: "every ring assembles the whole mesh as the topic's cohort" });
}

const signWith = (key: PrivateKey) => async (payload: Uint8Array): Promise<string> => bytesToB64url(await signPeer(key, payload));

/**
 * Answers for the messages a seeker's walk addresses to its own node, from that node's host: a register goes
 * through the routed admission path (FRET's activity handler, as any routed register does), a query through the
 * handler `/query` runs, a renew or withdraw through `resolveRenew`.
 */
function selfServeOn(m: Machine): MatchmakingSelfServe {
	const router = new FretTopicRouter(m.node, m.fret);
	const addressing = createTierAddressing(new RingHash());
	const answerQuery = createMatchmakingQueryHandler({ registry: m.host.registry, addressing, sign: signWith(m.key) });
	return {
		register: async (reg) => {
			const key = addressing.routeKey(reg.treeTier, b64urlToBytes(reg.participantCoord), b64urlToBytes(reg.topicId));
			const reply = await router.routeAndAct(key, encodeCohortMessage(reg), { wantK: NODE_DEFAULT_WANT_K, minSigs: DEFAULT_MIN_SIGS });
			return validateRegisterReplyV1(decodeCohortMessage(reply));
		},
		query: async (q) => {
			const frame = await answerQuery(encodeQueryV1(q), m.node.peerId);
			return frame === undefined ? undefined : decodeQueryReplyV1(frame);
		},
		renew: async (r) => resolveRenew(m.host.registry, r, Date.now()),
	};
}

/**
 * Register the provider, retrying for a bounded time: a register can be declined while its cohort's members are
 * still announcing themselves, and an application retries. Before the fix every attempt was declined.
 */
async function registerProvider(session: MatchmakingProviderSession, topic: MatchTopicRef, contactHint: string): Promise<void> {
	const refusals: string[] = [];
	await waitFor(async () => {
		try {
			await session.register(topic, { capabilities: ['transcode'], capacityBudget: 1, contactHint });
			return true;
		} catch (err) {
			refusals.push(err instanceof Error ? err.message : String(err));
			return false;
		}
	}, { timeoutMs: 30_000, intervalMs: 500, description: 'the provider registration was admitted' })
		.catch((err: unknown) => {
			throw new Error(`${err instanceof Error ? err.message : String(err)}; refusals: ${refusals.slice(-3).join(' | ')}`);
		});
	if (refusals.length > 0) {
		console.log(`      provider register admitted after ${refusals.length} refusal(s), last: ${refusals[refusals.length - 1]}`);
	}
}

(GATED ? describe : describe.skip)('matchmaking on a network smaller than one cohort (default cohort-topic configuration)', function () {
	this.timeout(240_000);

	for (const machineCount of [1, 2, 3]) {
		describe(`${machineCount} machine${machineCount === 1 ? '' : 's'}`, function () {
			const machines: Machine[] = [];

			after(async () => {
				await Promise.allSettled(machines.splice(0, machines.length).map((m) => m.node.stop()));
			});

			it('a provider session registers and a seeker session finds it', async () => {
				const networkName = `matchmaking-small-network-${machineCount}-it`;
				const seed = await startMachine(networkName, machineCount, []);
				machines.push(seed);
				const seedAddr = pickLocalTcpMultiaddr(seed.node);
				for (let i = 1; i < machineCount; i++) {
					machines.push(await startMachine(networkName, machineCount, [seedAddr]));
				}

				const topic: MatchTopicRef = { kind: 'task', label: `small-network-${machineCount}` };
				const topicId = createMatchTopicAnchor().topicId(topic.kind, topic.label);
				const coord = createTierAddressing(new RingHash()).coord0(topicId);
				await meshAround(machines, coord);

				// The seeker sits off the topic's routed member wherever there is another machine, so its walk's register
				// and query are dialed; the provider sits off the seeker, and at three machines off the routed member too.
				const routedId = seed.fret.assembleCohort(coord, NODE_DEFAULT_WANT_K)[0];
				const seeker = machines.find((m) => m.id !== routedId) ?? seed;
				const provider = machines.find((m) => m !== seeker && (machineCount < 3 || m.id !== routedId)) ?? seed;

				const providerSession = new MatchmakingProviderSession({ service: provider.host.service, sign: signWith(provider.key) });
				await registerProvider(providerSession, topic, provider.id);
				expect(providerSession.registration, 'the provider holds a live registration').to.not.equal(undefined);

				const seekerSession = createLibp2pMatchmakingSeekerSession({
					node: seeker.node,
					fret: seeker.fret,
					selfPeerId: seeker.id,
					key: seeker.key,
					wantK: NODE_DEFAULT_WANT_K,
					service: seeker.host.service,
					selfServe: selfServeOn(seeker),
				});
				const found = await seekerSession.walk(topic, { wantCount: 1, patienceMs: 15_000 });
				expect(found.map((entry) => entry.participantId), "the seeker's walk found the provider").to.include(provider.id);

				// The walk left the provider's registration in place, still a provider's: at one machine the walk was the
				// provider's own, and a seeker register or withdraw from it would have replaced or removed that record.
				const reply = await seekerSession.query({
					v: 1, topicId: bytesToB64url(topicId), includeProviders: true, includeSeekers: false,
					limit: QUERY_LIMIT_MAX, requesterId: seeker.id, timestamp: Date.now(), signature: 'AA',
				});
				const entry = (reply.providers ?? []).find((p) => p.participantId === provider.id);
				expect(entry, 'a query after the walk still lists the provider').to.not.equal(undefined);
				expect(verifyProviderEntry(topicId, entry!, verifyPeerSig), "the served entry carries the provider's own signature").to.equal(true);
			});
		});
	}
});
