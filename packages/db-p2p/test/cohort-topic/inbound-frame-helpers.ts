import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToNumberLE, concatBytes, hexToBytes, numberToBytesLE } from '@noble/curves/utils.js';
import { sha512 } from '@noble/hashes/sha2.js';
import {
	bytesToB64url,
	b64urlToBytes,
	decodeCohortMessage,
	encodeCohortMessage,
	type RegisterV1,
	type RenewV1,
} from '@optimystic/db-core';
import { createCohortTopicHost, type CohortTopicHost } from '../../src/cohort-topic/host.js';
import { requestResponse } from '../../src/cohort-topic/stream-util.js';
import { makeMember, MockNode, PROTOCOLS, type Member } from '../../src/testing/cohort-topic-mesh-harness.js';

/** How far ahead of the clock a privileged frame is stamped: newer than any `lastPing`, inside the 5 s forward-skew allowance. */
export const FRESH_AHEAD_MS = 1_000;

/** A curve point of order 8, the torsion component that separates the two verification equations. */
const ORDER_8_POINT = ed25519.Point.fromBytes(hexToBytes('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05'), false);

/**
 * A signature over `message` that noble's cofactored ZIP215 equation accepts and the cofactorless RFC 8032 one
 * refuses. It is an ordinary Ed25519 signature whose `R` carries an order-8 component: multiplying through by the
 * cofactor removes it, and nothing else does. So a frame carrying it is accepted only by a path using `verifyPeerSig`.
 */
export function nobleOnlySignature(key: PrivateKey, message: Uint8Array): Uint8Array {
	const seed = key.raw.subarray(0, 32);
	const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(seed);
	const order = ed25519.Point.Fn.ORDER;
	const r = bytesToNumberLE(sha512(concatBytes(seed, message))) % order;
	const nonce = ed25519.Point.BASE.multiply(r).add(ORDER_8_POINT).toBytes();
	const challenge = bytesToNumberLE(sha512(concatBytes(nonce, pointBytes, message))) % order;
	return concatBytes(nonce, numberToBytesLE((r + challenge * scalar) % order, 32));
}

const randomBytes = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length));

/** A fresh topic id, so one test's coord has no engine until a frame makes one. */
export const randomTopic = (): Uint8Array => randomBytes(32);

/** An unsigned cold-start register body, in the shape a decoded frame has. */
export function registerBody(participant: Member, topic: Uint8Array, flags: { readonly probe?: true } = {}): Omit<RegisterV1, 'signature'> {
	return {
		v: 1,
		topicId: bytesToB64url(topic),
		tier: 0,
		treeTier: 0,
		participantCoord: bytesToB64url(participant.bytes),
		ttl: 90_000,
		...(flags.probe === true ? { probe: true as const } : { bootstrap: true }),
		timestamp: Date.now(),
		correlationId: bytesToB64url(randomBytes(16)),
	};
}

/** An unsigned plain-ping body at `timestamp`; a caller adds `reattach` or `withdraw`. */
export function renewBody(participant: Member, topic: Uint8Array, timestamp: number): Omit<RenewV1, 'signature'> {
	return {
		v: 1,
		topicId: bytesToB64url(topic),
		participantId: bytesToB64url(participant.bytes),
		correlationId: bytesToB64url(randomBytes(16)),
		timestamp,
	};
}

/** A register or renew frame as a test sends it. */
export type InboundFrame = RegisterV1 | RenewV1;

/** What the tests read off a register or renew reply. */
export interface FrameAnswer {
	readonly result: string;
}

/** A cohort-topic host, and the two ways a frame from another machine reaches it. */
export interface InboundHost {
	readonly self: Member;
	readonly node: MockNode;
	readonly host: CohortTopicHost;
	/** Deliver `frame` through the real `/register` protocol handler, from another machine. */
	overStream(frame: InboundFrame): Promise<FrameAnswer>;
	/** Deliver `frame` through the callback FRET runs for a routed activity. */
	overActivity(frame: InboundFrame): Promise<FrameAnswer>;
}

type ActivityHandler = (activity: string, cohort: string[]) => Promise<{ commitCertificate: string }>;

/** A host on a mock node whose FRET cohort at every coordinate is itself plus `others`; `keyed: false` builds it with no node key. */
export async function createInboundHost(opts: { readonly keyed?: boolean; readonly others?: readonly Member[] } = {}): Promise<InboundHost> {
	const self = await makeMember();
	const others = opts.others ?? [];
	const nodes = new Map<string, MockNode>();
	const node = new MockNode(self.peerId, nodes, new Set());
	nodes.set(self.idStr, node);
	const sender = new MockNode(peerIdFromPrivateKey(await generateKeyPair('Ed25519')), nodes, new Set());
	let activityHandler: ActivityHandler | undefined;
	const fret = {
		assembleCohort: (): string[] => others.map((m) => m.idStr),
		setActivityHandler: (handler: ActivityHandler): void => { activityHandler = handler; },
		getNetworkSizeEstimate: (): { size_estimate: number; confidence: number; sources: number } => ({ size_estimate: 50, confidence: 1, sources: 1 }),
		routeAct: (): Promise<{ commitCertificate: string }> => Promise.resolve({ commitCertificate: '' }),
	};
	const host = await createCohortTopicHost(node as never, fret as never, {
		...(opts.keyed === false ? {} : { privateKey: self.key }),
		wantK: 1 + others.length,
		gossipIntervalMs: 3_600_000,
	});
	return {
		self,
		node,
		host,
		overStream: async (frame: InboundFrame): Promise<FrameAnswer> => {
			const reply = await requestResponse(sender as never, self.peerId, PROTOCOLS.register, encodeCohortMessage(frame));
			return decodeCohortMessage(reply!) as FrameAnswer;
		},
		overActivity: async (frame: InboundFrame): Promise<FrameAnswer> => {
			const { commitCertificate } = await activityHandler!(bytesToB64url(encodeCohortMessage(frame)), [self.idStr, ...others.map((m) => m.idStr)]);
			return decodeCohortMessage(b64urlToBytes(commitCertificate)) as FrameAnswer;
		},
	};
}
