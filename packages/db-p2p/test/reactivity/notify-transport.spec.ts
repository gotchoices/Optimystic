import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import {
	bytesToB64url,
	encodeNotificationV1,
	type NotificationV1,
	type PeerRef,
} from '@optimystic/db-core';
import {
	Libp2pReactivityNotifyTransport,
	registerNotifyHandler,
} from '../../src/reactivity/notify-transport.js';
import {
	DEFAULT_REACTIVITY_PROTOCOLS,
	PROTOCOL_REACTIVITY_NOTIFY,
	PROTOCOL_REACTIVITY_PUSH_STATE_GOSSIP,
	PROTOCOL_REACTIVITY_RECOVER,
	REACTIVITY_BASE,
	makeReactivityProtocols,
	reactivityProtocolList,
} from '../../src/reactivity/protocols.js';
import { makeCohortTopicProtocols } from '../../src/cohort-topic/protocols.js';
import { bytesToPeerIdString } from '../../src/cohort-topic/peer-codec.js';
import { waitFor } from '@optimystic/db-core/test';

/** A real (dialable, byte-round-trippable) peer-id string. */
async function peerIdString(): Promise<string> {
	const key = await generateKeyPair('Ed25519');
	return peerIdFromPrivateKey(key).toString();
}

const COLLECTION = new Uint8Array([1, 2, 3, 4]);
const TAIL = new Uint8Array([9, 9, 9, 9]);

const sampleNotification = (revision: number): NotificationV1 => ({
	v: 1,
	collectionId: bytesToB64url(COLLECTION),
	tailId: bytesToB64url(TAIL),
	revision,
	digest: bytesToB64url(new Uint8Array([revision & 0xff])),
	timestamp: 1_700_000_000_000 + revision,
	sig: bytesToB64url(new Uint8Array([0xaa, revision & 0xff])),
	signers: [bytesToB64url(new Uint8Array([8]))],
});

/** A captured outbound dial: which target, which protocol, and the framed bytes that were sent. */
interface SentFrame {
	target: string;
	protocol: string;
	frame: Uint8Array;
}

/**
 * A minimal libp2p stand-in for the dialer side of {@link Libp2pReactivityNotifyTransport.send}: no
 * connection cache (so `sendOneWay` always dials), and `dialProtocol` either captures the framed bytes or
 * — for a `dead` target — rejects, exercising the transport's swallow-and-continue path.
 */
function makeCapturingNode(opts: { dead?: Set<string> } = {}): { node: unknown; sent: SentFrame[] } {
	const sent: SentFrame[] = [];
	const dead = opts.dead ?? new Set<string>();
	const arr = (p: string | string[]): string[] => (Array.isArray(p) ? p : [p]);
	const node = {
		getConnections: (): unknown[] => [],
		dialProtocol: (peer: PeerId, protocols: string | string[]): Promise<unknown> => {
			const target = peer.toString();
			const protocol = arr(protocols)[0]!;
			if (dead.has(target)) {
				return Promise.reject(new Error(`unreachable: ${target}`));
			}
			return Promise.resolve({
				send: (frame: Uint8Array): void => { sent.push({ target, protocol, frame }); },
				close: (): Promise<void> => Promise.resolve(),
				abort: (): void => {},
			});
		},
	};
	return { node, sent };
}

describe('reactivity / notify transport', () => {
	it('round-trips a NotificationV1 from send through deliver (byte-identical framing)', async () => {
		const { node, sent } = makeCapturingNode();
		const tx = new Libp2pReactivityNotifyTransport(node as never);
		const target = await peerIdString();

		const n = sampleNotification(42);
		await tx.send(target, n);

		expect(sent, 'one dial was made').to.have.length(1);
		expect(sent[0]!.target).to.equal(target);
		expect(sent[0]!.protocol).to.equal(PROTOCOL_REACTIVITY_NOTIFY);
		expect([...sent[0]!.frame], 'the framed bytes are exactly encodeNotificationV1(n)').to.deep.equal([...encodeNotificationV1(n)]);

		// Feed the captured frame back through deliver — the decoded notification must be byte-identical.
		const received: Array<{ from: PeerRef; n: NotificationV1 }> = [];
		tx.onNotification((from, m) => received.push({ from, n: m }));
		const fromPeer = await peerIdString();
		tx.deliver(fromPeer, sent[0]!.frame);

		expect(received, 'the subscriber saw the delivered notification').to.have.length(1);
		expect(received[0]!.n, 'decode is faithful to the originally-sent notification').to.deep.equal(n);
		expect(bytesToPeerIdString(received[0]!.from.id), 'from carries the inbound peer id as substrate bytes').to.equal(fromPeer);
	});

	it('fans a delivered notification to every subscriber and honors unsubscribe', () => {
		const { node } = makeCapturingNode();
		const tx = new Libp2pReactivityNotifyTransport(node as never);
		const a: number[] = [];
		const b: number[] = [];
		const offA = tx.onNotification((_from, n) => a.push(n.revision));
		tx.onNotification((_from, n) => b.push(n.revision));

		tx.deliver('peer-x', encodeNotificationV1(sampleNotification(1)));
		offA();
		tx.deliver('peer-x', encodeNotificationV1(sampleNotification(2)));

		expect(a, 'unsubscribed handler stopped after offA').to.deep.equal([1]);
		expect(b, 'still-subscribed handler saw both').to.deep.equal([1, 2]);
	});

	it('drops a malformed inbound frame: no throw, no handler fire', () => {
		const { node } = makeCapturingNode();
		const tx = new Libp2pReactivityNotifyTransport(node as never);
		let fired = 0;
		tx.onNotification(() => { fired++; });

		expect(() => tx.deliver('peer-y', new Uint8Array([0xff, 0x00, 0x01, 0x02]))).to.not.throw();
		expect(fired, 'an undecodable frame fires no subscriber').to.equal(0);
	});

	it('swallows an unreachable target; a later send to a live target still fires (failure isolation)', async () => {
		const deadId = await peerIdString();
		const liveId = await peerIdString();
		const { node, sent } = makeCapturingNode({ dead: new Set([deadId]) });
		const tx = new Libp2pReactivityNotifyTransport(node as never);

		// The dead target's rejection is swallowed — send resolves rather than rejecting the fan-out.
		await tx.send(deadId, sampleNotification(1));
		expect(sent, 'a dead target captures nothing').to.have.length(0);

		// A subsequent send to a live target still fires: one dead subscriber never breaks the loop.
		await tx.send(liveId, sampleNotification(2));
		expect(sent).to.have.length(1);
		expect(sent[0]!.target).to.equal(liveId);
	});

	it('never dials self when selfPeerId is set', async () => {
		const selfId = await peerIdString();
		const { node, sent } = makeCapturingNode();
		const tx = new Libp2pReactivityNotifyTransport(node as never, { selfPeerId: selfId });

		await tx.send(selfId, sampleNotification(1));
		expect(sent, 'self target is never dialed').to.have.length(0);

		const other = await peerIdString();
		await tx.send(other, sampleNotification(2));
		expect(sent, 'a non-self target is still dialed').to.have.length(1);
		expect(sent[0]!.target).to.equal(other);
	});

	it('registerNotifyHandler reads one inbound frame and delivers it — one-way, no reply frame', async () => {
		const handlers = new Map<string, (stream: unknown, connection: { remotePeer: PeerId }) => void>();
		const handleNode = {
			handle: (protocol: string | string[], handler: (stream: unknown, connection: { remotePeer: PeerId }) => void): Promise<void> => {
				for (const p of (Array.isArray(protocol) ? protocol : [protocol])) handlers.set(p, handler);
				return Promise.resolve();
			},
		};
		const { node: dialNode } = makeCapturingNode();
		const tx = new Libp2pReactivityNotifyTransport(dialNode as never);
		const received: NotificationV1[] = [];
		tx.onNotification((_from, n) => received.push(n));
		registerNotifyHandler(handleNode as never, PROTOCOL_REACTIVITY_NOTIFY, tx);

		const handler = handlers.get(PROTOCOL_REACTIVITY_NOTIFY);
		expect(handler, 'the notify protocol handler was registered').to.be.a('function');

		const fromPeer = await peerIdString();
		const n = sampleNotification(7);
		const frame = encodeNotificationV1(n);
		let replied = false;
		const stream = {
			[Symbol.asyncIterator]: async function* (): AsyncGenerator<Uint8Array> { yield frame; },
			send: (): void => { replied = true; },
			close: (): Promise<void> => Promise.resolve(),
			abort: (): void => {},
		};
		handler!(stream, { remotePeer: peerIdFromString(fromPeer) });
		// The handler reads + delivers on a fire-and-forget async IIFE; poll for the delivered notification.
		await waitFor(() => received.length > 0, { description: 'the inbound frame was decoded and delivered' });

		expect(received, 'the inbound frame was decoded and delivered').to.deep.equal([n]);
		expect(replied, 'notify is one-way — the handler sends no reply frame').to.equal(false);
	});

	it('registerNotifyHandler aborts the stream and delivers nothing when the bounded read fails', async () => {
		const handlers = new Map<string, (stream: unknown, connection: { remotePeer: PeerId }) => void>();
		const handleNode = {
			handle: (protocol: string | string[], handler: (stream: unknown, connection: { remotePeer: PeerId }) => void): Promise<void> => {
				for (const p of (Array.isArray(protocol) ? protocol : [protocol])) handlers.set(p, handler);
				return Promise.resolve();
			},
		};
		const { node: dialNode } = makeCapturingNode();
		const tx = new Libp2pReactivityNotifyTransport(dialNode as never);
		let fired = 0;
		tx.onNotification(() => { fired++; });
		// A tiny read ceiling forces readAllBounded to reject the (larger) inbound frame.
		registerNotifyHandler(handleNode as never, PROTOCOL_REACTIVITY_NOTIFY, tx, 4);

		const handler = handlers.get(PROTOCOL_REACTIVITY_NOTIFY);
		const fromPeer = await peerIdString();
		const frame = encodeNotificationV1(sampleNotification(11));
		expect(frame.length, 'the frame is larger than the read ceiling').to.be.greaterThan(4);
		let aborted = false;
		const stream = {
			[Symbol.asyncIterator]: async function* (): AsyncGenerator<Uint8Array> { yield frame; },
			send: (): void => {},
			close: (): Promise<void> => Promise.resolve(),
			abort: (): void => { aborted = true; },
		};
		handler!(stream, { remotePeer: peerIdFromString(fromPeer) });
		// The bounded read rejects on the async IIFE and the catch aborts the stream; poll that observable state.
		await waitFor(() => aborted, { description: 'a failed bounded read aborts the stream' });

		expect(aborted, 'a failed read aborts the stream').to.equal(true);
		expect(fired, 'an oversized/failed read delivers nothing to subscribers').to.equal(0);
	});
});

describe('reactivity / protocol family', () => {
	it('the canonical DEFAULT_* ids omit the network segment', () => {
		expect(REACTIVITY_BASE).to.equal('/optimystic/reactivity/1.0.0');
		expect(PROTOCOL_REACTIVITY_NOTIFY).to.equal('/optimystic/reactivity/1.0.0/notify');
		expect(PROTOCOL_REACTIVITY_PUSH_STATE_GOSSIP).to.equal('/optimystic/reactivity/1.0.0/push-state-gossip');
		expect(DEFAULT_REACTIVITY_PROTOCOLS.notify).to.equal(PROTOCOL_REACTIVITY_NOTIFY);
		expect(DEFAULT_REACTIVITY_PROTOCOLS.pushStateGossip).to.equal(PROTOCOL_REACTIVITY_PUSH_STATE_GOSSIP);
	});

	it('makeReactivityProtocols inserts the network segment, matching the cohort-topic convention', () => {
		const r = makeReactivityProtocols('default');
		expect(r.notify).to.equal('/optimystic/default/reactivity/1.0.0/notify');
		expect(r.pushStateGossip).to.equal('/optimystic/default/reactivity/1.0.0/push-state-gossip');
		// Same namespacing shape as the cohort-topic family (segment inserted even for "default").
		expect(makeCohortTopicProtocols('default').gossip).to.equal('/optimystic/default/cohort-topic/1.0.0/cohort-gossip');
		// A named network namespaces the same way.
		expect(makeReactivityProtocols('mainnet').notify).to.equal('/optimystic/mainnet/reactivity/1.0.0/notify');
		// The namespaced ids do NOT equal the canonical (segment-less) defaults.
		expect(r.notify).to.not.equal(DEFAULT_REACTIVITY_PROTOCOLS.notify);
	});

	it('reactivityProtocolList enumerates the family for node.handle / unhandle', () => {
		expect(reactivityProtocolList(DEFAULT_REACTIVITY_PROTOCOLS)).to.deep.equal([
			PROTOCOL_REACTIVITY_NOTIFY,
			PROTOCOL_REACTIVITY_PUSH_STATE_GOSSIP,
			PROTOCOL_REACTIVITY_RECOVER,
		]);
	});
});
