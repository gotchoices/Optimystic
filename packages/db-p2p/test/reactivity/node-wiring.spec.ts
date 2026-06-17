import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import { bytesToB64url } from '@optimystic/db-core';
import { createLibp2pNode } from '../../src/libp2p-node.js';
import { DEFAULT_REACTIVITY_PROTOCOLS } from '../../src/reactivity/protocols.js';
import { ReactivitySubscriberRegistry } from '../../src/reactivity/subscriber-registry.js';
import { Libp2pReactivityRecoverTransport } from '../../src/reactivity/recover-transport.js';
import { peerIdToBytes, bytesToPeerIdString } from '../../src/cohort-topic/peer-codec.js';
import { edgeProfile } from '@optimystic/db-core';
import type { CohortTopicHost } from '../../src/cohort-topic/host.js';

const NOTIFY = DEFAULT_REACTIVITY_PROTOCOLS.notify;
const PUSH_STATE_GOSSIP = DEFAULT_REACTIVITY_PROTOCOLS.pushStateGossip;
const RECOVER = DEFAULT_REACTIVITY_PROTOCOLS.recover;

/**
 * **Reactivity node-wiring** (`12.33-reactivity-notification-transport`). A `cohortTopic`-enabled production
 * node assembles the reactivity notify + push-state-gossip protocol handlers, the forwarder host, the
 * origination hook, the push-state-gossip cadence timer, and the node-level subscriber registry; `node.stop()`
 * tears the handlers + timer down before the transports close. The per-piece behavior (fan-out, Edge gate,
 * dedupe, gossip convergence, the timer lifecycle) is unit-tested in `forwarder-host.spec.ts` /
 * `push-state-gossip.spec.ts`; this spec proves the *assembly + teardown* on a real production node, and
 * end-to-end socket delivery is the env-gated `substrate-real-libp2p.integration.spec.ts`.
 */
describe('reactivity / node wiring (real libp2p, solo forming node)', function () {
	// Real libp2p boot + FRET seeding dominate; ops finish in seconds.
	this.timeout(40_000);

	it('a cohortTopic-enabled Core node registers the reactivity protocols + subscriber registry; node.stop() unhandles them', async () => {
		const node: any = await createLibp2pNode({
			port: 0,
			networkName: 'reactivity-wiring-core',
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 1,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: false },
			cohortTopic: { enabled: true },
		});
		try {
			const protocols: string[] = node.getProtocols();
			expect(protocols, 'notify handler registered').to.include(NOTIFY);
			expect(protocols, 'push-state-gossip handler registered').to.include(PUSH_STATE_GOSSIP);
			expect(protocols, 'recover handler registered').to.include(RECOVER);

			// The node-level subscriber registry is exposed so a subscribe factory can register managers.
			expect(node.reactivitySubscribers, 'subscriber registry exposed on the node').to.be.instanceOf(ReactivitySubscriberRegistry);

			// The recover seams are exposed for the deferred subscribe factory (the Quereus Database.watch bridge):
			// the outbound transport, the request signers, and the shared sticky cohort-hint cache.
			expect(node.reactivityRecover, 'recover transport exposed on the node').to.be.instanceOf(Libp2pReactivityRecoverTransport);
			expect(node.reactivityRecoverSigners, 'recover request signers exposed').to.be.an('object');
			expect(typeof node.reactivityRecoverSigners.signBackfill, 'signBackfill seam present').to.equal('function');
			expect(typeof node.reactivityRecoverSigners.signResume, 'signResume seam present').to.equal('function');
			expect(node.reactivityCohortHintCache, 'sticky cohort-hint cache exposed').to.be.an('object');
			expect(typeof node.reactivityCohortHintCache.get, 'cohort-hint cache get seam present').to.equal('function');

			// The origination hook is installed on the cohort-topic service (overwrites any prior onLocalCommit).
			const host = node.cohortTopicHost as CohortTopicHost;
			expect(host, 'cohort-topic host exposed').to.exist;
			expect(typeof host.service.onLocalCommit, 'origination manager installed onLocalCommit').to.equal('function');
			expect(host.profile.kind, 'default cohort profile is Core (forwards reactivity)').to.equal('core');
		} finally {
			await node.stop();
		}

		// After stop the reactivity protocols are unhandled (teardown ran before the transports closed).
		const afterStop: string[] = node.getProtocols();
		expect(afterStop, 'notify handler unregistered on stop').to.not.include(NOTIFY);
		expect(afterStop, 'push-state-gossip handler unregistered on stop').to.not.include(PUSH_STATE_GOSSIP);
		expect(afterStop, 'recover handler unregistered on stop').to.not.include(RECOVER);
	});

	it('an Edge-profile node assembles subscriber-only: notify handler present, profile is edge', async () => {
		const node: any = await createLibp2pNode({
			port: 0,
			networkName: 'reactivity-wiring-edge',
			bootstrapNodes: [],
			fretProfile: 'edge',
			clusterSize: 1,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: false },
			cohortTopic: { enabled: true, host: { profile: edgeProfile() } },
		});
		try {
			const host = node.cohortTopicHost as CohortTopicHost;
			expect(host.profile.kind, 'Edge profile threaded through to the reactivity wiring').to.equal('edge');
			// An Edge node is a subscriber-only reactivity participant: it still registers the notify handler so
			// it RECEIVES notifications (the forwarder-only gate — never instantiates a PushState, never fans out
			// — is unit-tested in forwarder-host.spec.ts). The push-state-gossip handler is registered too, but an
			// Edge node has no live PushState so its rounds broadcast nothing.
			const protocols: string[] = node.getProtocols();
			expect(protocols, 'Edge still receives over the notify protocol').to.include(NOTIFY);
			expect(node.reactivitySubscribers, 'subscriber registry exposed (Edge is a subscriber)').to.be.instanceOf(ReactivitySubscriberRegistry);
		} finally {
			await node.stop();
		}
	});

	it('cohortTopic disabled (default): no reactivity protocols, no subscriber registry', async () => {
		const node: any = await createLibp2pNode({
			port: 0,
			networkName: 'reactivity-wiring-off',
			bootstrapNodes: [],
			fretProfile: 'edge',
			arachnode: { enableRingZulu: false },
		});
		try {
			const protocols: string[] = node.getProtocols();
			expect(protocols, 'no notify handler when cohortTopic disabled').to.not.include(NOTIFY);
			expect(protocols, 'no push-state-gossip handler when cohortTopic disabled').to.not.include(PUSH_STATE_GOSSIP);
			expect(protocols, 'no recover handler when cohortTopic disabled').to.not.include(RECOVER);
			expect(node.reactivitySubscribers, 'no subscriber registry when disabled').to.equal(undefined);
			expect(node.reactivityRecover, 'no recover transport when disabled').to.equal(undefined);
			expect(node.reactivityRecoverSigners, 'no recover signers when disabled').to.equal(undefined);
			expect(node.reactivityCohortHintCache, 'no cohort-hint cache when disabled').to.equal(undefined);
			expect(node.cohortTopicHost, 'no host when disabled').to.equal(undefined);
		} finally {
			await node.stop();
		}
	});
});

/**
 * **Dial-target encoding regression** (the analogue of the tail-bytes coord-equality test, one layer down).
 * The notify transport dials with `peerIdFromString(target)`, so the `directSubscribers` / `resolveChildPrimary`
 * / `selfPeerId` space MUST be the canonical peer-id string. A cohort member id is carried as
 * `peerIdToBytes(peerId) = utf8(peerIdString)`; the production `directSubscribers` decodes it with
 * `bytesToPeerIdString`, NOT `bytesToB64url`. Feeding base64url-of-bytes to `peerIdFromString` throws → the
 * transport swallows it → origination silently never dials. Pin both directions.
 */
describe('reactivity / dial-target encoding (peer-id-string space)', () => {
	it('bytesToPeerIdString(participantId) round-trips through the transport\'s peerIdFromString; base64url does NOT', async () => {
		const peerStr = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
		const participantId = peerIdToBytes(peerStr); // how cohort member ids are carried (utf8 of the peer-id string)

		// The CORRECT decode (what reactivityDirectSubscribers / the node wiring emit): a dialable peer-id string.
		const dialTarget = bytesToPeerIdString(participantId);
		expect(dialTarget, 'decodes back to the canonical peer-id string').to.equal(peerStr);
		expect(() => peerIdFromString(dialTarget), 'the dial target is a valid peer-id string').to.not.throw();

		// The WRONG encoding (base64url of the member bytes): NOT a peer-id string — peerIdFromString rejects it,
		// which inside the transport is swallowed as a dropped send (a silent no-dial regression).
		const wrongTarget = bytesToB64url(participantId);
		expect(wrongTarget, 'base64url-of-bytes differs from the peer-id string').to.not.equal(peerStr);
		expect(() => peerIdFromString(wrongTarget), 'a base64url-of-bytes target is NOT dialable').to.throw();
	});
});
