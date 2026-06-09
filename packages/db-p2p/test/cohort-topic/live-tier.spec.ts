/**
 * Cohort-topic **live-tier** end-to-end milestone (`tickets/.../cohort-topic-live-tier-e2e`).
 *
 * Stands up an `N ≥ minSigs` in-process multi-node cohort over **real Ed25519 keys** (one
 * `generateKeyPair('Ed25519')` per node) and a **mock transport** that routes the five cohort-topic
 * protocols (`register`, `cohort-gossip`, `promote`, `membership`, `sign`) plus FRET's
 * `routeAct` / `assembleCohort` directly between the in-process node engines — no real libp2p sockets.
 * It proves the prereq machinery *composes*:
 *
 *  1. **Real cohort** — the cohort serving a topic at tier 0 is `assembleCohort(coord_0(topicId))` =
 *     all N nodes, computed identically (member set + epoch) on every node (per-coord scoping +
 *     deterministic assembly).
 *  2. **Register through the walk** — `service.register` resolves an `accepted` handle whose `primary`
 *     is a cohort member and whose `cohortMembers` is the N-node set, after a real walk-toward-root.
 *  3. **Real threshold signature** — the cohort publishes a `MembershipCertV1` whose collected `k − x`
 *     multisig a participant's `verifier().verifyMessage(...)` accepts (`"verified"`); a forged
 *     single-signer cert (the interim shape) is rejected (`"untrusted"`).
 *  4. **Promotion end-to-end** — past `cap_promote`, the tier-0 cohort threshold-signs a
 *     `PromotionNoticeV1`, broadcasts it over `promote`, a node that did **not** originate it
 *     verify-applies it, and a later registration walk gets `Promoted(1)`, recomputes `coord_1`, gets
 *     `no_state`, walks back to 0, and terminates within `maxSteps` (single-cohort termination).
 *  5. **Gossip replication** — a record accepted on the routed primary replicates into a sibling's
 *     store in one gossip round; an eviction converges.
 *
 * Plus the negative: with one node dropped below quorum, the cohort signature is **not** produced (no
 * single-signer fallback — assembly throws).
 *
 * The mock-tier unit coverage (`service.spec.ts`, per-coord scoping with a fret returning a different
 * set per coord) stays; this is the real-multi-node composition on top of it.
 */

import { expect } from 'chai';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey, PeerId } from '@libp2p/interface';
import { hashPeerId, type RouteAndMaybeActV1, type NearAnchorV1 } from 'p2p-fret';
import {
	RingHash,
	createTierAddressing,
	bytesToB64url,
	b64urlToBytes,
	encodeCohortMessage,
	cohortGossipSigningPayload,
	registerSigningPayload,
	renewSigningPayload,
	membershipCertSigningPayload,
	CohortBackoffError,
	type CohortGossipV1,
	type MembershipCertV1,
	type RegisterV1,
	type RenewV1,
	type RingCoord,
	type Tier,
} from '@optimystic/db-core';
import { createCohortTopicHost, type CohortTopicHost, type CoordEngine } from '../../src/cohort-topic/host.js';
import { peerIdToBytes, bytesToPeerIdString } from '../../src/cohort-topic/peer-codec.js';
import { signPeer } from '../../src/cohort-topic/peer-sig.js';
import { DEFAULT_COHORT_TOPIC_PROTOCOLS as PROTOCOLS } from '../../src/cohort-topic/protocols.js';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `predicate` until true or `timeoutMs` elapses (deterministic-but-not-flaky async settle). */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000, intervalMs = 5): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return true;
		}
		await delay(intervalMs);
	}
	return predicate();
}

// --- members (real Ed25519 keys) ---

/** A real cohort node identity: its libp2p key, peer-id, peer-id string, dialable member bytes, ring position. */
interface Member {
	readonly key: PrivateKey;
	readonly peerId: PeerId;
	readonly idStr: string;
	/** Dialable member id (UTF-8 of the peer-id string) — the `participantCoord` / signer wire form. */
	readonly bytes: Uint8Array;
	/** Ring position `H(peerId)` — what FRET routes / assembles around. */
	readonly ringPos: RingCoord;
}

async function makeMember(): Promise<Member> {
	const key = await generateKeyPair('Ed25519');
	const peerId = peerIdFromPrivateKey(key);
	return { key, peerId, idStr: peerId.toString(), bytes: peerIdToBytes(peerId), ringPos: await hashPeerId(peerId) };
}

async function makeMembers(n: number): Promise<Member[]> {
	const out: Member[] = [];
	for (let i = 0; i < n; i++) {
		out.push(await makeMember());
	}
	return out;
}

// --- in-process duplex stream (what readAllBounded iterates) ---

/**
 * One end of an in-memory duplex pipe. `send` enqueues a frame onto the *peer's* inbox; `close`
 * (half-close-write) signals EOF to the peer's reader. The async iterator yields this end's inbox until
 * the peer closed its write and the buffer drains — so `p2p-fret`'s `readAllBounded` reads exactly the
 * frames the other end wrote, then completes promptly on EOF (no idle-timeout wait).
 */
class MockStreamEnd {
	private readonly inbox: Uint8Array[] = [];
	private inboundClosed = false;
	private waiter: (() => void) | undefined;
	public peer!: MockStreamEnd;

	send(frame: Uint8Array): void {
		this.peer.accept(frame);
	}

	close(): Promise<void> {
		this.peer.endInbound();
		return Promise.resolve();
	}

	abort(_err?: unknown): void {
		this.peer.endInbound();
	}

	private accept(frame: Uint8Array): void {
		this.inbox.push(frame);
		this.wake();
	}

	private endInbound(): void {
		this.inboundClosed = true;
		this.wake();
	}

	private wake(): void {
		const w = this.waiter;
		this.waiter = undefined;
		w?.();
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
		for (;;) {
			if (this.inbox.length > 0) {
				yield this.inbox.shift()!;
				continue;
			}
			if (this.inboundClosed) {
				return;
			}
			await new Promise<void>((resolve) => {
				this.waiter = resolve;
			});
		}
	}
}

function streamPair(): [MockStreamEnd, MockStreamEnd] {
	const a = new MockStreamEnd();
	const b = new MockStreamEnd();
	a.peer = b;
	b.peer = a;
	return [a, b];
}

// --- in-process libp2p stand-in ---

type ProtocolHandler = (stream: MockStreamEnd, connection: { remotePeer: PeerId }) => void;
const asList = (p: string | string[]): string[] => (Array.isArray(p) ? p : [p]);

/**
 * A minimal libp2p node the cohort-topic host runs on. `dialProtocol` resolves the target node in the
 * shared registry, hands its protocol handler one end of a fresh duplex, and returns the other — so a
 * `requestResponse` / `sendOneWay` from one host drives the target host's real protocol handler.
 */
class MockNode {
	public readonly handlers = new Map<string, ProtocolHandler>();

	constructor(
		public readonly peerId: PeerId,
		private readonly registry: Map<string, MockNode>,
		private readonly down: Set<string>,
	) {}

	handle(protocol: string | string[], handler: ProtocolHandler): Promise<void> {
		for (const p of asList(protocol)) {
			this.handlers.set(p, handler);
		}
		return Promise.resolve();
	}

	unhandle(protocol: string | string[]): Promise<void> {
		for (const p of asList(protocol)) {
			this.handlers.delete(p);
		}
		return Promise.resolve();
	}

	getConnections(_peer?: PeerId): unknown[] {
		return [];
	}

	dialProtocol(peer: PeerId, protocols: string | string[]): Promise<MockStreamEnd> {
		const targetId = peer.toString();
		if (this.down.has(targetId)) {
			return Promise.reject(new Error(`peer ${targetId} is down`));
		}
		const target = this.registry.get(targetId);
		if (target === undefined) {
			return Promise.reject(new Error(`unknown peer ${targetId}`));
		}
		const handler = target.handlers.get(asList(protocols)[0]!);
		if (handler === undefined) {
			return Promise.reject(new Error(`no handler for ${asList(protocols)[0]} on ${targetId}`));
		}
		const [dialerEnd, handlerEnd] = streamPair();
		handler(handlerEnd, { remotePeer: this.peerId });
		return Promise.resolve(dialerEnd);
	}

	/** Inject a one-way frame as if `from` had sent it over `protocol` (the inbound transport seam). */
	receive(protocol: string, frame: Uint8Array, from: PeerId): void {
		const handler = this.handlers.get(protocol);
		if (handler === undefined) {
			throw new Error(`no handler for ${protocol}`);
		}
		const [dialerEnd, handlerEnd] = streamPair();
		handler(handlerEnd, { remotePeer: from });
		dialerEnd.send(frame);
		void dialerEnd.close();
	}
}

// --- mesh + shared FRET ---

interface HostNode {
	readonly member: Member;
	readonly node: MockNode;
	readonly host: CohortTopicHost;
}

interface MeshOptions {
	readonly wantK: number;
	readonly minSigs: number;
	readonly capPromote?: number;
	readonly downNodes?: readonly string[];
	/** FRET network-size estimate (drives the walk start tier `d_max`). Default 256 → `d_max = 1`. */
	readonly sizeEstimate?: number;
}

class CohortMesh {
	readonly nodes: HostNode[] = [];
	/** Coords every `routeAct` was keyed at (a walk's probe trail); a test clears + inspects it. */
	readonly routeKeys: string[] = [];
	private readonly registry = new Map<string, MockNode>();
	private readonly activity = new Map<string, (activity: string, cohort: string[], minSigs: number, correlationId: string) => Promise<{ commitCertificate: string }>>();
	private readonly down: Set<string>;

	constructor(private readonly members: Member[], private readonly sizeEstimate: number, down: readonly string[]) {
		this.down = new Set(down);
	}

	/** Deterministic FRET assembly: all members sorted by XOR distance of their ring position to `coord`. */
	private sortedByDistance(coord: Uint8Array): Member[] {
		return [...this.members].sort((a, b) => xorCompare(a.ringPos, b.ringPos, coord));
	}

	assembleCohort(coord: Uint8Array, wants: number): string[] {
		return this.sortedByDistance(coord).slice(0, wants).map((m) => m.idStr);
	}

	/** The single node nearest `coord` — where `routeAct` runs the activity (the routed primary). */
	nearest(coord: Uint8Array): Member {
		return this.sortedByDistance(coord)[0]!;
	}

	nodeNearest(coord: Uint8Array): HostNode {
		const id = this.nearest(coord).idStr;
		return this.nodes.find((n) => n.member.idStr === id)!;
	}

	nodeOf(idStr: string): HostNode {
		return this.nodes.find((n) => n.member.idStr === idStr)!;
	}

	private async routeAct(msg: RouteAndMaybeActV1): Promise<NearAnchorV1 | { commitCertificate: string }> {
		const key = b64urlToBytes(msg.key);
		this.routeKeys.push(msg.key);
		const target = this.nearest(key);
		const handler = this.activity.get(target.idStr);
		if (handler === undefined) {
			// No in-cluster activity to run → a bare anchor hint; the walk treats it as `no_state`.
			return { v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: this.members.length, confidence: 1 };
		}
		const cohort = this.assembleCohort(key, msg.want_k);
		return handler(msg.activity ?? '', cohort, msg.min_sigs, msg.correlation_id);
	}

	/** A FRET facade for one node, delegating routing/assembly to the shared mesh. */
	fretFor(idStr: string): unknown {
		return {
			assembleCohort: (coord: Uint8Array, wants: number): string[] => this.assembleCohort(coord, wants),
			setActivityHandler: (h: (activity: string, cohort: string[], minSigs: number, correlationId: string) => Promise<{ commitCertificate: string }>): void => {
				this.activity.set(idStr, h);
			},
			routeAct: (msg: RouteAndMaybeActV1): Promise<NearAnchorV1 | { commitCertificate: string }> => this.routeAct(msg),
			getNetworkSizeEstimate: (): { size_estimate: number; confidence: number; sources: number } => ({ size_estimate: this.sizeEstimate, confidence: 1, sources: 1 }),
		};
	}

	registerNode(member: Member): MockNode {
		const node = new MockNode(member.peerId, this.registry, this.down);
		this.registry.set(member.idStr, node);
		return node;
	}

	clearRouteLog(): void {
		this.routeKeys.length = 0;
	}

	async stop(): Promise<void> {
		await Promise.all(this.nodes.map((n) => n.host.stop()));
	}
}

/** Compare XOR distance of `a` vs `b` to `target` (big-endian) — a total order over distinct ring positions. */
function xorCompare(a: Uint8Array, b: Uint8Array, target: Uint8Array): number {
	for (let i = 0; i < target.length; i++) {
		const da = (a[i] ?? 0) ^ target[i]!;
		const db = (b[i] ?? 0) ^ target[i]!;
		if (da !== db) {
			return da - db;
		}
	}
	return 0;
}

/** Build and start an N-node cohort mesh: one real-keyed node + FRET facade + cohort-topic host each. */
async function buildMesh(members: Member[], opts: MeshOptions): Promise<CohortMesh> {
	const mesh = new CohortMesh(members, opts.sizeEstimate ?? 256, opts.downNodes ?? []);
	for (const member of members) {
		const node = mesh.registerNode(member);
		const host = await createCohortTopicHost(node as never, mesh.fretFor(member.idStr) as never, {
			privateKey: member.key,
			wantK: opts.wantK,
			minSigs: opts.minSigs,
			// Park the periodic driver; tests pump gossip / membership / promotion deterministically.
			gossipIntervalMs: 3_600_000,
			...(opts.capPromote === undefined ? {} : { promotion: { capPromote: opts.capPromote } }),
		});
		mesh.nodes.push({ member, node, host });
	}
	return mesh;
}

// --- signed frame builders (real participant peer-key signatures) ---

async function signedWillingness(from: Member, coord: Uint8Array, epoch: Uint8Array, now: number): Promise<Uint8Array> {
	const g: CohortGossipV1 = {
		v: 1,
		fromMember: bytesToB64url(from.bytes),
		coord: bytesToB64url(coord),
		cohortEpoch: bytesToB64url(epoch),
		willingnessBits: 'f', // willing at every tier
		loadBuckets: [0, 0, 0, 0],
		windowSeconds: 60,
		topicSummaries: [],
		timestamp: now,
		signature: '',
	};
	g.signature = bytesToB64url(await signPeer(from.key, cohortGossipSigningPayload(g)));
	return encodeCohortMessage(g);
}

async function signedRegister(participant: Member, topic: Uint8Array, now: number, correlationId: string): Promise<RegisterV1> {
	const body: Omit<RegisterV1, 'signature'> = {
		v: 1,
		topicId: bytesToB64url(topic),
		tier: 0,
		treeTier: 0,
		participantCoord: bytesToB64url(participant.bytes),
		ttl: 90_000,
		bootstrap: true,
		timestamp: now,
		correlationId: bytesToB64url(new TextEncoder().encode(correlationId)),
	};
	return { ...body, signature: bytesToB64url(await signPeer(participant.key, registerSigningPayload(body))) };
}

async function signedReattach(participant: Member, topic: Uint8Array, now: number): Promise<RenewV1> {
	const body: Omit<RenewV1, 'signature'> = {
		v: 1,
		topicId: bytesToB64url(topic),
		participantId: bytesToB64url(participant.bytes),
		correlationId: bytesToB64url(new TextEncoder().encode('reattach')),
		timestamp: now,
		reattach: true,
	};
	return { ...body, signature: bytesToB64url(await signPeer(participant.key, renewSigningPayload(body))) };
}

// --- topic setup (instantiate coord-0 engines + seed willingness quorum) ---

interface TopicSetup {
	readonly coord0: RingCoord;
	readonly engines: Map<string, CoordEngine>;
	readonly deciding: HostNode;
	readonly decidingEngine: CoordEngine;
}

/**
 * Instantiate the tier-0 coord engine for `topic` on every node and seed each node's coord-0 gossip
 * view with every *other* member's willingness, so any node (in particular the routed primary) meets
 * the willingness quorum and can admit. Mirrors the willingness bootstrap the gossip-cadence tests do
 * — an idle engine builds no willingness frame, so the first registration needs a seed.
 */
async function setupTopic(mesh: CohortMesh, topic: Uint8Array, addressing: ReturnType<typeof createTierAddressing>): Promise<TopicSetup> {
	const coord0 = addressing.coord0(topic);
	const seedParticipant = mesh.nodes[0]!.member.bytes; // dummy participantCoord (unused at tier 0)
	const engines = new Map<string, CoordEngine>();
	for (const node of mesh.nodes) {
		engines.set(node.member.idStr, node.host.registry.forCoord(coord0, 0 as Tier, seedParticipant));
	}
	const now = Date.now();
	for (const node of mesh.nodes) {
		const epoch = engines.get(node.member.idStr)!.cohort().cohortEpoch;
		for (const other of mesh.nodes) {
			if (other.member.idStr === node.member.idStr) {
				continue;
			}
			node.node.receive(PROTOCOLS.gossip, await signedWillingness(other.member, coord0, epoch, now), other.member.peerId);
		}
	}
	await delay(20); // let the async gossip handlers merge the willingness contributions
	const deciding = mesh.nodeNearest(coord0);
	return { coord0, engines, deciding, decidingEngine: engines.get(deciding.member.idStr)! };
}

// --- the milestone ---

const addressing = createTierAddressing(new RingHash());
const TOPIC = Uint8Array.from({ length: 32 }, (_v, i) => (i * 9 + 5) & 0xff);
const N = 5;
const WANT_K = N;
const MIN_SIGS = N - 1; // 4-of-5 quorum (the production minSigs = 14 path is identical, just larger)

describe('cohort-topic: live-tier end-to-end milestone', () => {
	it('1. the cohort serving the topic at tier 0 is assembleCohort(coord_0(topic)) = all N nodes, computed identically everywhere', async () => {
		const members = await makeMembers(N);
		const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS });
		try {
			const { coord0, engines } = await setupTopic(mesh, TOPIC, addressing);

			const expected = new Set(mesh.assembleCohort(coord0, WANT_K));
			expect(expected.size, 'wantK = N → the tier-0 cohort is the whole network').to.equal(N);
			expect(expected, 'cohort = every node').to.deep.equal(new Set(members.map((m) => m.idStr)));

			// Every node independently computes the SAME cohort member set AND the same epoch for coord_0 —
			// the determinism the threshold-signature collection depends on (a fragmented cohort can't quorum).
			const epochs = new Set<string>();
			for (const node of mesh.nodes) {
				const engine = engines.get(node.member.idStr)!;
				const members0 = new Set(engine.cohort().members.map(bytesToPeerIdString));
				expect(members0, `node ${node.member.idStr} assembles the whole-network cohort around coord_0`).to.deep.equal(expected);
				expect(engine.treeTier, 'instantiated at tier 0').to.equal(0);
				epochs.add(bytesToB64url(engine.cohort().cohortEpoch));
			}
			expect(epochs.size, 'all N nodes derive one identical cohort epoch for coord_0').to.equal(1);
		} finally {
			await mesh.stop();
		}
	});

	it('2. a participant registers through the walk → accepted handle (primary ∈ cohort, cohortMembers = the N-node set)', async () => {
		const members = await makeMembers(N);
		const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS });
		try {
			const { coord0 } = await setupTopic(mesh, TOPIC, addressing);

			// nodes[0] is the participant; its service drives the real walk-toward-root over the mock router.
			const handle = await mesh.nodes[0]!.host.service.register({ topicId: TOPIC, tier: 0 as Tier });

			const cohortIds = new Set(handle.cohortMembers.map(bytesToPeerIdString));
			expect(cohortIds, 'the accepted reply carries the full N-node cohort').to.deep.equal(new Set(members.map((m) => m.idStr)));
			expect(cohortIds.has(bytesToPeerIdString(handle.primary)), 'the assigned primary is a cohort member').to.equal(true);
			expect(bytesToB64url(handle.cohortEpoch), 'the handle epoch is the deterministic coord_0 epoch').to.equal(bytesToB64url(mesh.nodeNearest(coord0).host.registry.forCoord(coord0, 0 as Tier, members[0]!.bytes).cohort().cohortEpoch));
		} finally {
			await mesh.stop();
		}
	});

	it('3. the cohort publishes a real k − x threshold-signed cert a participant verifier accepts; a forged single-signer cert is untrusted', async () => {
		const members = await makeMembers(N);
		const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS });
		try {
			const { coord0, decidingEngine, deciding } = await setupTopic(mesh, TOPIC, addressing);

			// The routed-primary cohort assembles a genuine collected k − x multisig over its membership and
			// serves it on the `membership` protocol.
			const cert = await decidingEngine.onStabilized(Date.now());
			expect(cert, 'the cohort published a membership cert').to.not.equal(undefined);
			expect(cert!.signers.length, 'at least minSigs distinct signers').to.be.at.least(MIN_SIGS);
			expect(new Set(cert!.signers).size, 'signers are distinct').to.equal(cert!.signers.length);
			const certMembers = new Set(cert!.members);
			expect(cert!.signers.every((s) => certMembers.has(s)), 'every signer is a cohort member').to.equal(true);

			// A *different* node's participant verifier fetches the cert over the `membership` protocol and
			// verifies the real multisig for real.
			const participant = mesh.nodes.find((n) => n.member.idStr !== deciding.member.idStr)!;
			const verifier = participant.host.service.verifier();
			const certPayload = membershipCertSigningPayload(cert!);
			expect(
				await verifier.verifyMessage(cert!.signers.map(b64urlToBytes), coord0, 0, certPayload, b64urlToBytes(cert!.thresholdSig)),
				'a participant verifies the real threshold-signed cert end-to-end',
			).to.equal('verified');

			// The interim shape — a single-signer "threshold" sig — must be rejected at minSigs = 4.
			const forgedSig = await signPeer(members[0]!.key, certPayload);
			expect(
				await verifier.verifyMessage([members[0]!.bytes], coord0, 0, certPayload, forgedSig),
				'a forged single-signer cert is untrusted',
			).to.equal('untrusted');
		} finally {
			await mesh.stop();
		}
	});

	it('4. promotion end-to-end: the cohort threshold-signs + broadcasts a notice, a non-originator verify-applies it, and a later walk gets Promoted(1) and terminates', async function () {
		this.timeout(15_000);
		const capPromote = 4;
		const members = await makeMembers(N);
		const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS, capPromote });
		try {
			const { coord0, decidingEngine, deciding, engines } = await setupTopic(mesh, TOPIC, addressing);

			// Publish the coord-0 cert on the routed primary so a sibling can fetch it to verify the notice.
			await decidingEngine.onStabilized(Date.now());

			// Seed one replicated record into every sibling (register + reattach to force a gossip touch, then
			// one round broadcasts it), so a sibling *serves the topic* and can apply an inbound promotion.
			const now = Date.now();
			const seedP = await makeMember();
			expect((await decidingEngine.engine.handleRegister(await signedRegister(seedP, TOPIC, now, 'seed'), { followOn: false, treeTier: 0 }, now)).result).to.equal('accepted');
			expect(decidingEngine.engine.handleRenew(await signedReattach(seedP, TOPIC, now), now).result).to.equal('ok');
			await decidingEngine.gossipRound(now);
			await delay(30);
			const sibling = mesh.nodes.find((n) => n.member.idStr !== deciding.member.idStr)!;
			const siblingEngine = engines.get(sibling.member.idStr)!;
			expect(siblingEngine.servesTopic(TOPIC), 'a sibling replicated the seed record and now serves the topic').to.equal(true);
			expect(siblingEngine.isPromoted(TOPIC), 'not promoted yet').to.equal(false);

			// Drive direct participants up to cap_promote on the routed primary (the seed already counts as 1,
			// so `cap_promote − 1` more cross the threshold). The cap-crossing arrival still replies `accepted`
			// (promotion fires fire-and-forget after the record lands) and asynchronously threshold-signs a
			// real PromotionNoticeV1 the host broadcasts over `promote` to the cohort.
			for (let i = 0; i < capPromote - 1; i++) {
				const p = await makeMember();
				const reply = await decidingEngine.engine.handleRegister(await signedRegister(p, TOPIC, now, `promote-${i}`), { followOn: false, treeTier: 0 }, now);
				expect(reply.result, `bulk register ${i} admitted`).to.equal('accepted');
			}

			// The originator adopts promoted mode once the threshold-sign round completes; a node that did NOT
			// originate the notice verify-applies it (over the `promote` + `membership` protocols).
			expect(await waitFor(() => decidingEngine.isPromoted(TOPIC), 8_000), 'the originating cohort is promoted').to.equal(true);
			expect(await waitFor(() => siblingEngine.isPromoted(TOPIC), 8_000), 'a non-originating cohort node verify-applied the promotion notice').to.equal(true);

			// One more registration past cap_promote now gets the cheap Promoted(d+1) redirect, not an accept.
			const past = await makeMember();
			const redirect = await decidingEngine.engine.handleRegister(await signedRegister(past, TOPIC, now, 'past-cap'), { followOn: false, treeTier: 0 }, now);
			expect(redirect.result, 'a registration past cap_promote is redirected onward').to.equal('promoted');
			expect(redirect.targetTier, 'redirected to the next tier').to.equal(1);

			// A subsequent registration walk now gets Promoted(1) at coord_0, recomputes coord_1, gets no_state
			// (no tier-1 cohort), walks back to 0, and terminates within maxSteps (single-cohort termination).
			mesh.clearRouteLog();
			const walker = mesh.nodes.find((n) => n.member.idStr !== deciding.member.idStr)!;
			let backoff: unknown;
			try {
				await walker.host.service.register({ topicId: TOPIC, tier: 0 as Tier });
			} catch (err) {
				backoff = err;
			}
			expect(backoff, 'the post-promotion walk terminates with a temporal back-off, not a hang').to.be.instanceOf(CohortBackoffError);
			const coord1 = addressing.coord(1, walker.member.bytes, TOPIC);
			expect(mesh.routeKeys.includes(bytesToB64url(coord1)), 'the walk recomputed coord_1 and probed it').to.equal(true);
			expect(mesh.routeKeys.includes(bytesToB64url(coord0)), 'the walk also (re)probed coord_0 (the promoted redirect)').to.equal(true);
		} finally {
			await mesh.stop();
		}
	});

	it('5. gossip replication: a record accepted on the routed primary replicates into a sibling store; an eviction converges', async () => {
		const members = await makeMembers(N);
		const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: MIN_SIGS });
		try {
			const { decidingEngine, deciding, engines } = await setupTopic(mesh, TOPIC, addressing);
			const sibling = mesh.nodes.find((n) => n.member.idStr !== deciding.member.idStr)!;
			const siblingEngine = engines.get(sibling.member.idStr)!;

			const participant = await makeMember();
			const now = Date.now();
			expect((await decidingEngine.engine.handleRegister(await signedRegister(participant, TOPIC, now, 'repl'), { followOn: false, treeTier: 0 }, now)).result).to.equal('accepted');
			expect(decidingEngine.engine.handleRenew(await signedReattach(participant, TOPIC, now), now).result, 'reattach touches the record').to.equal('ok');

			// One gossip round broadcasts the touched record to the cohort over the `cohort-gossip` protocol.
			const g = await decidingEngine.gossipRound(now);
			expect(g?.records?.length, 'the round carries the touched record').to.equal(1);
			await delay(30);
			expect(siblingEngine.holds(TOPIC, participant.bytes), 'the sibling replicated the record in one round').to.equal(true);

			// Let the record go stale, sweep it on the primary, and gossip the eviction — the sibling converges.
			const later = now + 90_000 + 1;
			const gEvict = await decidingEngine.gossipRound(later);
			expect(gEvict?.evicted?.length, 'the stale record was swept and queued as an eviction').to.equal(1);
			await delay(30);
			expect(siblingEngine.holds(TOPIC, participant.bytes), 'the sibling converged on the eviction').to.equal(false);
		} finally {
			await mesh.stop();
		}
	});

	it('6. (negative) with one node dropped below quorum the cohort signature is NOT produced — no single-signer fallback', async () => {
		const members = await makeMembers(N);
		// minSigs = N: every member must endorse, so one unreachable node makes the quorum unreachable.
		const downMember = members[N - 1]!;
		const mesh = await buildMesh(members, { wantK: WANT_K, minSigs: N, downNodes: [downMember.idStr] });
		try {
			const coord0 = addressing.coord0(TOPIC);
			// Assemble from a reachable node (it can dial out; only dials TO the down node fail).
			const assembler = mesh.nodes.find((n) => n.member.idStr !== downMember.idStr)!;
			const engine = assembler.host.registry.forCoord(coord0, 0 as Tier, assembler.member.bytes);

			let threw = false;
			try {
				await engine.onStabilized(Date.now());
			} catch {
				threw = true;
			}
			expect(threw, 'sub-quorum assembly throws rather than fabricating a single-signer cert').to.equal(true);
		} finally {
			await mesh.stop();
		}
	});
});
