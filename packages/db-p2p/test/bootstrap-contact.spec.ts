import { expect } from 'chai';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair } from '@libp2p/crypto/keys';
import type { Connection, PeerId } from '@libp2p/interface';
import { BootstrapContactTracker, planBootstrapTargets } from '../src/network/bootstrap-contact.js';
import { identifyOnConnectionOpen, type IdentifyOnOpenHost, type IdentifyOutcome } from '../src/network/identify-on-open.js';

const makePeerId = async (): Promise<PeerId> => peerIdFromPrivateKey(await generateKeyPair('Ed25519'));

describe('bootstrap contact', () => {
	describe('planBootstrapTargets', () => {
		it('names the peer each address reaches: the partner behind a relay, not the relay', async () => {
			const relay = await makePeerId();
			const partner = await makePeerId();
			const targets = planBootstrapTargets([
				`/ip4/10.0.0.1/tcp/4001/p2p/${relay.toString()}/p2p-circuit/p2p/${partner.toString()}`,
				`/ip4/10.0.0.2/tcp/4001/p2p/${partner.toString()}`,
				'/ip4/10.0.0.3/tcp/4001'
			]);
			expect(targets.map(t => t.peerId.toString()), 'one target, the partner; the address naming no peer is skipped')
				.to.deep.equal([partner.toString()]);
			expect(targets[0]!.addrs.length, 'both addresses that reach it').to.equal(2);
		});
	});

	describe('BootstrapContactTracker', () => {
		it('never counts this node itself as a peer to hear from', async () => {
			const self = await makePeerId();
			const other = await makePeerId();
			const targets = planBootstrapTargets([
				`/ip4/10.0.0.1/tcp/4001/p2p/${self.toString()}`,
				`/ip4/10.0.0.2/tcp/4001/p2p/${other.toString()}`
			]);
			expect(new BootstrapContactTracker(self, targets).peerIds).to.deep.equal([other.toString()]);
		});

		it('takes an answer from identify only: a failed exchange is none, and the first answer stands', async () => {
			const self = await makePeerId();
			const partner = await makePeerId();
			const stranger = await makePeerId();
			const tracker = new BootstrapContactTracker(self, planBootstrapTargets([`/ip4/10.0.0.2/tcp/4001/p2p/${partner.toString()}`]));
			const id = partner.toString();

			tracker.started(partner);
			expect(tracker.inFlight(), 'identify with a bootstrap peer is in flight').to.equal(1);
			let woken = false;
			void tracker.nextSettled().then(() => { woken = true; });
			tracker.settled(partner, 'failed');
			await Promise.resolve();
			expect(woken, 'a settling exchange wakes whoever waits').to.equal(true);
			expect(tracker.inFlight()).to.equal(0);
			expect(tracker.answerOf(id), 'a failed exchange established nothing').to.equal(undefined);

			tracker.started(partner);
			tracker.settled(partner, 'identified');
			tracker.started(partner);
			tracker.settled(partner, 'foreign');
			expect(tracker.answerOf(id), 'the first answer stands').to.equal('identified');

			tracker.started(stranger);
			tracker.settled(stranger, 'identified');
			expect(tracker.inFlight(), 'a peer that is not a bootstrap peer is not counted').to.equal(0);
			expect(tracker.answerOf(stranger.toString())).to.equal(undefined);
		});
	});

	describe('identifyOnConnectionOpen', () => {
		/** A node whose identify service ends as `ending` says, and the outcomes an observer was told. */
		async function identifyEnding(ending: () => Promise<void>): Promise<IdentifyOutcome[]> {
			const peer = await makePeerId();
			let open!: (evt: CustomEvent<Connection>) => void;
			const node: IdentifyOnOpenHost = {
				addEventListener: (_type, listener) => { open = listener; },
				services: { identify: { identify: async () => { await ending(); return {} as never; } } }
			};
			const outcomes: IdentifyOutcome[] = [];
			let settle!: () => void;
			const settled = new Promise<void>(resolve => { settle = resolve; });
			identifyOnConnectionOpen(node, {
				started: () => {},
				settled: (_peerId, outcome) => { outcomes.push(outcome); settle(); }
			});
			open({ detail: { remotePeer: peer } as Connection } as CustomEvent<Connection>);
			await settled;
			return outcomes;
		}

		const named = (name: string): Error => Object.assign(new Error(name), { name });

		it('reports a completed exchange, a refusal of this network\'s identify, and any other failure apart', async () => {
			expect(await identifyEnding(async () => {})).to.deep.equal(['identified']);
			expect(await identifyEnding(async () => { throw named('UnsupportedProtocolError'); })).to.deep.equal(['foreign']);
			expect(await identifyEnding(async () => { throw named('TimeoutError'); })).to.deep.equal(['failed']);
		});
	});
});
