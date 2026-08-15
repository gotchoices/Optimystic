/**
 * Protocol clients must KEEP the addresses their responses already carry.
 *
 * `RedirectPayload` carries `{ id, addrs }` and `ClusterRecord.peers` carries `multiaddrs`, but
 * both clients used to narrow the response to a shape without them, so the addresses were
 * structurally discarded — which is why a cohort member that had never met a relay-only sibling
 * could never dial it (see `relay-third-party-address-gap.spec.ts` for the libp2p-level premise).
 *
 * The ORDER matters as much as the fact: a merge placed after the redirect dial fixes nothing for
 * the hop that needs it, so these tests assert the interleaving against a recorded event log, not
 * merely that `recordPeerAddresses` was called.
 */
import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { pipe } from 'it-pipe';
import { encode as lpEncode } from 'it-length-prefixed';
import type { PeerId } from '@libp2p/interface';
import type { IPeerNetwork, PeerId as CorePeerId, ClusterRecord, ClusterPeers, RepoMessage, BlockGets } from '@optimystic/db-core';
import { RepoClient } from '../src/repo/client.js';
import { ClusterClient } from '../src/cluster/client.js';

async function makePeerId(): Promise<PeerId> {
	return peerIdFromPrivateKey(await generateKeyPair('Ed25519'));
}

/** Length-prefix encode a JSON value into the byte chunks a libp2p stream yields. */
async function encodeJson(value: unknown): Promise<Uint8Array[]> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of pipe([new TextEncoder().encode(JSON.stringify(value))], lpEncode)) {
		chunks.push(chunk.subarray());
	}
	return chunks;
}

/** A fake libp2p stream that replays `chunks` to the response reader. */
function streamReplaying(chunks: Uint8Array[]) {
	return {
		send: () => {},
		close: async () => {},
		abort: () => {},
		async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
	};
}

type Event =
	| { kind: 'dial', peer: string }
	| { kind: 'record', peer: string, addrs: string[] };

/**
 * Fake IPeerNetwork whose FIRST dial replies with `first` and whose later dials reply with
 * `terminal`. Every dial and every `recordPeerAddresses` lands in one ordered event log, so a
 * test can assert the merge happened BEFORE the dial it is supposed to enable.
 */
function makeNetwork(first: unknown, terminal: unknown) {
	const events: Event[] = [];
	let dials = 0;
	const network = {
		async connect(peer: CorePeerId, _proto: string) {
			events.push({ kind: 'dial', peer: peer.toString() });
			const payload = dials === 0 ? first : terminal;
			dials += 1;
			return streamReplaying(await encodeJson(payload)) as unknown;
		},
		recordPeerAddresses(peer: CorePeerId, addrs: string[]) {
			events.push({ kind: 'record', peer: peer.toString(), addrs });
		},
		// The clients also hit this on the redirect path; record nothing, it has its own spec.
		recordCoordinator() {},
	} as unknown as IPeerNetwork;
	return { network, events };
}

const RELAY_CIRCUIT = (relay: string): string => `/ip4/127.0.0.1/tcp/60609/ws/p2p/${relay}/p2p-circuit`;

const makeRecord = (peers: ClusterPeers, message?: RepoMessage): ClusterRecord => ({
	messageHash: 'hash-1',
	peers,
	message: message ?? ({ operations: [] } as unknown as RepoMessage),
	promises: {},
	commits: {},
});

// A near-future expiration keeps RepoClient's internal timeout timer from lingering after the
// (instant) stub responds.
const soonExpiring = () => ({ expiration: Date.now() + 2000 });

describe('protocol clients learn peer addresses from their own messages', () => {
	describe('RepoClient redirect ingress', () => {
		it('records the redirect target\'s addrs BEFORE dialing it', async () => {
			const startPeer = await makePeerId();
			const relay = await makePeerId();
			const target = await makePeerId();
			const addr = RELAY_CIRCUIT(relay.toString());

			const { network, events } = makeNetwork(
				{ redirect: { peers: [{ id: target.toString(), addrs: [addr] }], reason: 'not_in_cluster' } },
				{}
			);
			const client = RepoClient.create(startPeer, network, '/optimystic/test');

			await client.get({ blockIds: ['block-A'] } as BlockGets, soonExpiring());

			const record = events.findIndex(e => e.kind === 'record' && e.peer === target.toString());
			const secondDial = events.findIndex(e => e.kind === 'dial' && e.peer === target.toString());
			expect(record, 'the carried addrs must be recorded').to.be.greaterThan(-1);
			expect(secondDial, 'the redirect must have been followed').to.be.greaterThan(-1);
			expect(record, 'recording AFTER the dial would not help the hop that needs it').to.be.lessThan(secondDial);
			expect((events[record] as Extract<Event, { kind: 'record' }>).addrs).to.deep.equal([addr]);
		});

		it('tolerates a redirect payload with no addrs (offers an empty list, still dials)', async () => {
			const startPeer = await makePeerId();
			const target = await makePeerId();
			const { network, events } = makeNetwork(
				{ redirect: { peers: [{ id: target.toString() }], reason: 'not_in_cluster' } },
				{}
			);
			const client = RepoClient.create(startPeer, network, '/optimystic/test');

			await client.get({ blockIds: ['block-A'] } as BlockGets, soonExpiring());

			expect(events.filter(e => e.kind === 'dial')).to.have.length(2);
			const recorded = events.find(e => e.kind === 'record') as Extract<Event, { kind: 'record' }> | undefined;
			expect(recorded?.addrs).to.deep.equal([]);
		});
	});

	describe('ClusterClient redirect ingress', () => {
		it('records the redirect target\'s addrs BEFORE dialing it', async () => {
			const startPeer = await makePeerId();
			const relay = await makePeerId();
			const target = await makePeerId();
			const addr = RELAY_CIRCUIT(relay.toString());
			const message: RepoMessage = {
				operations: [{ commit: { blockIds: ['block-A'], actionId: 'a1', tailId: 'block-A', rev: 1 } }],
			};
			const record = makeRecord({}, message);

			const { network, events } = makeNetwork(
				{ redirect: { peers: [{ id: target.toString(), addrs: [addr] }], reason: 'not_in_cluster' } },
				record
			);
			const client = ClusterClient.create(startPeer, network, '/optimystic/test');

			await client.update(record);

			const recordIdx = events.findIndex(e => e.kind === 'record' && e.peer === target.toString());
			const secondDial = events.findIndex(e => e.kind === 'dial' && e.peer === target.toString());
			expect(recordIdx, 'the carried addrs must be recorded').to.be.greaterThan(-1);
			expect(secondDial, 'the redirect must have been followed').to.be.greaterThan(-1);
			expect(recordIdx, 'recording AFTER the dial would not help the hop that needs it').to.be.lessThan(secondDial);
			expect((events[recordIdx] as Extract<Event, { kind: 'record' }>).addrs).to.deep.equal([addr]);
		});
	});

	describe('ClusterClient record ingress', () => {
		it('records every addressed peer from the ClusterRecord a member returns', async () => {
			const startPeer = await makePeerId();
			const relay = await makePeerId();
			const relayOnly = await makePeerId();
			const direct = await makePeerId();
			const addressless = await makePeerId();
			const circuit = RELAY_CIRCUIT(relay.toString());

			const returned = makeRecord({
				[relayOnly.toString()]: { multiaddrs: [circuit], publicKey: 'k1' },
				[direct.toString()]: { multiaddrs: ['/ip4/10.0.0.5/tcp/5001'], publicKey: 'k2' },
				[addressless.toString()]: { multiaddrs: [], publicKey: 'k3' },
			});
			// No redirect: the FIRST dial already returns the member's record.
			const { network, events } = makeNetwork(returned, returned);
			const client = ClusterClient.create(startPeer, network, '/optimystic/test');

			await client.update(makeRecord({}));

			const recorded = events.filter(e => e.kind === 'record') as Array<Extract<Event, { kind: 'record' }>>;
			const byPeer = new Map(recorded.map(e => [e.peer, e.addrs]));
			expect(byPeer.get(relayOnly.toString()), 'the relay-only member is the whole point').to.deep.equal([circuit]);
			expect(byPeer.get(direct.toString())).to.deep.equal(['/ip4/10.0.0.5/tcp/5001']);
			expect(byPeer.has(addressless.toString()), 'a member with no addresses has nothing to offer').to.equal(false);
		});

		it('skips unparseable peer ids without throwing', async () => {
			const startPeer = await makePeerId();
			const good = await makePeerId();
			const returned = makeRecord({
				'not-a-peer-id': { multiaddrs: ['/ip4/10.0.0.5/tcp/5001'], publicKey: 'k1' },
				[good.toString()]: { multiaddrs: ['/ip4/10.0.0.6/tcp/5002'], publicKey: 'k2' },
			});
			const { network, events } = makeNetwork(returned, returned);
			const client = ClusterClient.create(startPeer, network, '/optimystic/test');

			await client.update(makeRecord({}));

			const recorded = events.filter(e => e.kind === 'record') as Array<Extract<Event, { kind: 'record' }>>;
			expect(recorded.map(e => e.peer)).to.deep.equal([good.toString()]);
		});
	});

	describe('networks without an address book', () => {
		it('both clients work unchanged when recordPeerAddresses is absent', async () => {
			const startPeer = await makePeerId();
			const target = await makePeerId();
			const dialed: string[] = [];
			const bare = {
				async connect(peer: CorePeerId, _proto: string) {
					const first = dialed.length === 0;
					dialed.push(peer.toString());
					const payload = first
						? { redirect: { peers: [{ id: target.toString(), addrs: ['/ip4/127.0.0.1/tcp/4001'] }], reason: 'not_in_cluster' } }
						: {};
					return streamReplaying(await encodeJson(payload)) as unknown;
				},
			} as unknown as IPeerNetwork;

			const client = RepoClient.create(startPeer, bare, '/optimystic/test');
			await client.get({ blockIds: ['block-A'] } as BlockGets, soonExpiring());

			expect(dialed).to.deep.equal([startPeer.toString(), target.toString()]);
		});
	});
});
