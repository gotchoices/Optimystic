/**
 * Cohort-topic **mock-transport mesh harness** — the in-process, many-logical-node test substrate for
 * the cohort-topic layer (`docs/cohort-topic.md`). It stands up an `N`-node mesh of real-Ed25519-keyed
 * {@link CohortTopicHost}s over a mock libp2p transport and a shared FRET facade that routes the five
 * cohort-topic protocols (`register`, `cohort-gossip`, `promote`, `membership`, `sign`) plus FRET's
 * `routeAct` / `assembleCohort` directly between the in-process node engines — no real sockets, so a
 * 50–200-node mesh runs fast and deterministically.
 *
 * This is the extracted, generalized form of the harness first written inline in
 * `test/cohort-topic/live-tier.spec.ts`; that milestone spec and the at-scale suites
 * (`cohort-topic-scale-*.spec.ts`) both drive it. It is a *sibling* of the cluster
 * {@link import("./mesh-harness.js")} (which builds `ClusterMember` / coordinator-repo nodes over a
 * different mock transport) — the two share no infrastructure, so they stay separate modules under
 * `src/testing/` rather than one file.
 *
 * **What it is NOT.** It is not a wall-clock simulator. TTL eviction, renewal touches, gossip rounds,
 * and demotion hysteresis are all driven by an *explicit* `now` passed to the engine methods
 * (`handleRegister(reg, ctx, now)`, `gossipRound(now)`, `sweepStale(now)`, `demotionTick(now)`), so a
 * suite advances virtual time by choosing timestamps — never by sleeping. The only real-time waits are
 * the tiny async-settle polls ({@link waitFor}) the in-process gossip handlers need to drain.
 */

import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey, PeerId } from '@libp2p/interface';
import { hashPeerId, type RouteAndMaybeActV1, type NearAnchorV1 } from 'p2p-fret';
import {
	RingHash,
	createSlotAssigner,
	createTierAddressing,
	coreProfile,
	edgeProfile,
	bytesEqual,
	bytesToB64url,
	b64urlToBytes,
	encodeCohortMessage,
	decodeCohortMessage,
	decodeRegisterReplyV1,
	cohortGossipSigningPayload,
	registerSigningPayload,
	renewSigningPayload,
	type CohortGossipV1,
	type NodeProfile,
	type PromotionConfig,
	type RegisterResult,
	type RegisterV1,
	type RenewV1,
	type RingCoord,
	type Tier,
	type WalkTrace,
} from '@optimystic/db-core';
import { createCohortTopicHost, type CohortTopicAntiDosOptions, type CohortTopicHost, type CoordEngine } from '../cohort-topic/host.js';
import { peerIdToBytes, bytesToPeerIdString } from '../cohort-topic/peer-codec.js';
import { signPeer } from '../cohort-topic/peer-sig.js';
import { DEFAULT_COHORT_TOPIC_PROTOCOLS as PROTOCOLS } from '../cohort-topic/protocols.js';

export { PROTOCOLS };

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `predicate` until true or `timeoutMs` elapses (deterministic-but-not-flaky async settle). */
export async function waitFor(predicate: () => boolean, timeoutMs = 2_000, intervalMs = 5): Promise<boolean> {
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
export interface Member {
	readonly key: PrivateKey;
	readonly peerId: PeerId;
	readonly idStr: string;
	/** Dialable member id (UTF-8 of the peer-id string) — the `participantCoord` / signer wire form. */
	readonly bytes: Uint8Array;
	/** Ring position `H(peerId)` — what FRET routes / assembles around. */
	readonly ringPos: RingCoord;
}

export async function makeMember(): Promise<Member> {
	const key = await generateKeyPair('Ed25519');
	const peerId = peerIdFromPrivateKey(key);
	return { key, peerId, idStr: peerId.toString(), bytes: peerIdToBytes(peerId), ringPos: await hashPeerId(peerId) };
}

export async function makeMembers(n: number): Promise<Member[]> {
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
export class MockStreamEnd {
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

export function streamPair(): [MockStreamEnd, MockStreamEnd] {
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
 * `requestResponse` / `sendOneWay` from one host drives the target host's real protocol handler. A node
 * in the shared `down` set rejects inbound dials (crash / unreachable simulation).
 */
export class MockNode {
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

export interface HostNode {
	readonly member: Member;
	readonly node: MockNode;
	readonly host: CohortTopicHost;
}

export interface MeshOptions {
	readonly wantK: number;
	readonly minSigs: number;
	/** Lowered `cap_promote` to drive promotion with a small participant count (live-tier / promotion suites). */
	readonly capPromote?: number;
	/**
	 * Extra {@link PromotionConfig} fields merged onto every node's lifecycle (alongside {@link capPromote}).
	 * Lets a virtual-time harness neutralise the wall-clock-rate heuristics (e.g. `tPromoteLookaheadMs: 0`
	 * to disable slope-based pre-promotion, which is meaningless when `now` is a fixed virtual instant).
	 */
	readonly promotion?: Partial<PromotionConfig>;
	/** Peers that reject inbound dials (crash / unreachable). They stay in FRET assembly (epoch unchanged). */
	readonly downNodes?: readonly string[];
	/** FRET network-size estimate (drives the walk start tier `d_max`). Default 256 → `d_max = 1`. */
	readonly sizeEstimate?: number;
	/** Per-node tier profile by index. Default all {@link coreProfile}. `'edge'` → {@link edgeProfile} (T0/T1 only). */
	readonly profiles?: readonly ('edge' | 'core')[];
	/** Gossip-driver cadence (ms). Default parks the timer far out so suites pump gossip deterministically. */
	readonly gossipIntervalMs?: number;
	/** Anti-DoS wiring applied to every node (e.g. a reputation view to force cold-root bootstrap denial). */
	readonly antiDos?: CohortTopicAntiDosOptions;
}

/** One routed probe: the coord key it was issued at and the reply classification the walk saw. */
export interface RouteTraceEntry {
	readonly key: string;
	readonly result: RegisterResult;
}

export class CohortMesh {
	readonly nodes: HostNode[] = [];
	/** Coords every `routeAct` was keyed at (a walk's probe trail); a test clears + inspects it. */
	readonly routeKeys: string[] = [];
	/** Per-probe (key, reply-result) trace — richer than {@link routeKeys} for anti-flood walk assertions. */
	readonly routeTrace: RouteTraceEntry[] = [];
	private readonly registry = new Map<string, MockNode>();
	private readonly activity = new Map<string, (activity: string, cohort: string[], minSigs: number, correlationId: string) => Promise<{ commitCertificate: string }>>();
	private readonly down: Set<string>;
	/** Members removed from FRET assembly (a membership change for rotation tests). They stay dialable. */
	private readonly excluded = new Set<string>();

	constructor(private readonly members: Member[], private readonly sizeEstimate: number, down: readonly string[]) {
		this.down = new Set(down);
	}

	/**
	 * Drop `idStr` from FRET cohort assembly — the cohort serving any coord that included it now resolves to
	 * a different member set (a new `cohortEpoch`), which is the membership change that drives an epoch
	 * rotation. Unlike {@link crashNode}, the node stays dialable (it still answers `/sign`), so the outgoing
	 * cohort can co-sign the hand-off. Used by the rotation-attestation tests.
	 */
	excludeFromAssembly(idStr: string): void {
		this.excluded.add(idStr);
	}

	/** Restore `idStr` to FRET cohort assembly. */
	includeInAssembly(idStr: string): void {
		this.excluded.delete(idStr);
	}

	/** Deterministic FRET assembly: live (non-excluded) members sorted by XOR distance of ring position to `coord`. */
	private sortedByDistance(coord: Uint8Array): Member[] {
		return [...this.members].filter((m) => !this.excluded.has(m.idStr)).sort((a, b) => xorCompare(a.ringPos, b.ringPos, coord));
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

	/** Crash `idStr`: it rejects inbound dials but stays in FRET assembly, so `cohortEpoch` is unchanged. */
	crashNode(idStr: string): void {
		this.down.add(idStr);
	}

	/** Revive a previously-crashed node. */
	reviveNode(idStr: string): void {
		this.down.delete(idStr);
	}

	private async routeAct(msg: RouteAndMaybeActV1): Promise<NearAnchorV1 | { commitCertificate: string }> {
		const key = b64urlToBytes(msg.key);
		this.routeKeys.push(msg.key);
		const target = this.nearest(key);
		const handler = this.activity.get(target.idStr);
		if (handler === undefined || this.down.has(target.idStr)) {
			// No in-cluster activity to run (cold / unreachable target) → a bare anchor hint; the walk
			// treats it as `no_state`.
			this.routeTrace.push({ key: msg.key, result: 'no_state' });
			return { v: 1, anchors: [], cohort_hint: [], estimated_cluster_size: this.members.length, confidence: 1 };
		}
		const cohort = this.assembleCohort(key, msg.want_k);
		const reply = await handler(msg.activity ?? '', cohort, msg.min_sigs, msg.correlation_id);
		this.routeTrace.push({ key: msg.key, result: replyResult(reply) });
		return reply;
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
		this.routeTrace.length = 0;
	}

	async stop(): Promise<void> {
		await Promise.all(this.nodes.map((n) => n.host.stop()));
	}
}

/** The reply classification a `routeAct` resolved with: decode the commit certificate's `RegisterReplyV1`. */
function replyResult(reply: NearAnchorV1 | { commitCertificate: string }): RegisterResult {
	if ('commitCertificate' in reply) {
		try {
			return decodeRegisterReplyV1(b64urlToBytes(reply.commitCertificate)).result;
		} catch {
			return 'no_state';
		}
	}
	return 'no_state';
}

/** Compare XOR distance of `a` vs `b` to `target` (big-endian) — a total order over distinct ring positions. */
export function xorCompare(a: Uint8Array, b: Uint8Array, target: Uint8Array): number {
	for (let i = 0; i < target.length; i++) {
		const da = (a[i] ?? 0) ^ target[i]!;
		const db = (b[i] ?? 0) ^ target[i]!;
		if (da !== db) {
			return da - db;
		}
	}
	return 0;
}

function profileAt(profiles: readonly ('edge' | 'core')[] | undefined, index: number): NodeProfile {
	return profiles?.[index] === 'edge' ? edgeProfile() : coreProfile();
}

/** Build and start an N-node cohort mesh: one real-keyed node + FRET facade + cohort-topic host each. */
export async function buildMesh(members: Member[], opts: MeshOptions): Promise<CohortMesh> {
	const mesh = new CohortMesh(members, opts.sizeEstimate ?? 256, opts.downNodes ?? []);
	let index = 0;
	for (const member of members) {
		const node = mesh.registerNode(member);
		const host = await createCohortTopicHost(node as never, mesh.fretFor(member.idStr) as never, {
			privateKey: member.key,
			wantK: opts.wantK,
			minSigs: opts.minSigs,
			profile: profileAt(opts.profiles, index),
			// Park the periodic driver by default; tests pump gossip / membership / promotion deterministically.
			gossipIntervalMs: opts.gossipIntervalMs ?? 3_600_000,
			// Virtual time: tests drive publish `stabilizedAt` from explicit (often future-advanced) timestamps,
			// not wall clock, so the `/sign` membership endorser's far-future `stabilizedAt` bound must not trip
			// on them. An infinite clock disables that bound while leaving the finiteness check intact.
			now: (): number => Number.POSITIVE_INFINITY,
			...((opts.capPromote === undefined && opts.promotion === undefined)
				? {}
				: { promotion: { ...(opts.capPromote === undefined ? {} : { capPromote: opts.capPromote }), ...(opts.promotion ?? {}) } }),
			...(opts.antiDos === undefined ? {} : { antiDos: opts.antiDos }),
		});
		mesh.nodes.push({ member, node, host });
		index++;
	}
	return mesh;
}

// --- signed frame builders (real participant peer-key signatures) ---

export async function signedWillingness(from: Member, coord: Uint8Array, epoch: Uint8Array, now: number, willingnessBits = 'f'): Promise<Uint8Array> {
	const g: CohortGossipV1 = {
		v: 1,
		fromMember: bytesToB64url(from.bytes),
		coord: bytesToB64url(coord),
		cohortEpoch: bytesToB64url(epoch),
		willingnessBits, // default 'f' → willing at every tier
		loadBuckets: [0, 0, 0, 0],
		windowSeconds: 60,
		topicSummaries: [],
		timestamp: now,
		signature: '',
	};
	g.signature = bytesToB64url(await signPeer(from.key, cohortGossipSigningPayload(g)));
	return encodeCohortMessage(g);
}

export interface SignedRegisterOptions {
	readonly tier?: number;
	readonly treeTier?: number;
	readonly bootstrap?: boolean;
	readonly ttl?: number;
}

export async function signedRegister(participant: Member, topic: Uint8Array, now: number, correlationId: string, opts: SignedRegisterOptions = {}): Promise<RegisterV1> {
	const body: Omit<RegisterV1, 'signature'> = {
		v: 1,
		topicId: bytesToB64url(topic),
		tier: opts.tier ?? 0,
		treeTier: opts.treeTier ?? 0,
		participantCoord: bytesToB64url(participant.bytes),
		ttl: opts.ttl ?? 90_000,
		bootstrap: opts.bootstrap ?? true,
		timestamp: now,
		correlationId: bytesToB64url(new TextEncoder().encode(correlationId)),
	};
	return { ...body, signature: bytesToB64url(await signPeer(participant.key, registerSigningPayload(body))) };
}

/** A plain ping (no `reattach`) — touches `lastPing` only when it lands on the computed primary / override. */
export async function signedPing(participant: Member, topic: Uint8Array, now: number, correlationId: string): Promise<RenewV1> {
	const body: Omit<RenewV1, 'signature'> = {
		v: 1,
		topicId: bytesToB64url(topic),
		participantId: bytesToB64url(participant.bytes),
		correlationId: bytesToB64url(new TextEncoder().encode(correlationId)),
		timestamp: now,
	};
	return { ...body, signature: bytesToB64url(await signPeer(participant.key, renewSigningPayload(body))) };
}

/** A signed crash-failover re-attach (`reattach: true` in the signed body) — promotes a backup. */
export async function signedReattach(participant: Member, topic: Uint8Array, now: number, correlationId = 'reattach'): Promise<RenewV1> {
	const body: Omit<RenewV1, 'signature'> = {
		v: 1,
		topicId: bytesToB64url(topic),
		participantId: bytesToB64url(participant.bytes),
		correlationId: bytesToB64url(new TextEncoder().encode(correlationId)),
		timestamp: now,
		reattach: true,
	};
	return { ...body, signature: bytesToB64url(await signPeer(participant.key, renewSigningPayload(body))) };
}

export const slots = createSlotAssigner(new RingHash());
export const addressing = createTierAddressing(new RingHash());

// --- walk-trace reconstruction (feeds the db-core anti-flood invariant predicates) ---

/**
 * Map each tier coordinate `coord_d(participant, topic)` for `d ∈ [0, dMax]` to its tier `d` (base64url
 * key → tier). A real walk's routed keys are matched against this map to recover the per-probe tier, so
 * the {@link import("@optimystic/db-core").WalkTrace}-shaped trace can be fed to `outwardMovesArePromoted`
 * / `inwardStepsFollowNoState` / `retriesRestartAtDMax`. `coord_0` is participant-independent (it equals
 * `coord0(topic)`); the bootstrap re-issue at the root reuses that same key, so both root probes map to 0.
 */
export function coordTierMap(participant: Member, topic: Uint8Array, dMax: number, tierAddr = addressing): Map<string, number> {
	const map = new Map<string, number>();
	// Walk inward so the participant-independent coord_0 wins the key if a deeper coord ever aliased it.
	for (let d = dMax; d >= 0; d--) {
		map.set(bytesToB64url(tierAddr.coord(d, participant.bytes, topic)), d);
	}
	return map;
}

/** Reconstruct a {@link WalkTrace} from the mesh's recorded `routeTrace`, keeping only this walk's coords. */
export function walkTraceFrom(routeTrace: readonly RouteTraceEntry[], tierMap: Map<string, number>, dMax: number): WalkTrace {
	const probes = routeTrace
		.filter((e) => tierMap.has(e.key))
		.map((e) => ({ treeTier: tierMap.get(e.key)!, result: e.result }));
	return { dMax, probes };
}

/**
 * Generate a real-keyed participant whose deterministic slot-**primary** (under `engine`'s cohort epoch
 * + member set) is `primaryNode`. The cohort-side renewal only serves a plain ping / `reattach` with
 * `ok` (the path that touches the record into the gossip deltas) when it lands on the participant's
 * computed primary or a backup; for an arbitrary participant the node nearest `coord_0` is that primary
 * only ~1/k of the time, so seeding/replication via a fixed deciding node is non-deterministic without
 * pinning the participant to it.
 */
export async function participantPrimaryAt(primaryNode: HostNode, engine: CoordEngine): Promise<Member> {
	const { members, cohortEpoch } = engine.cohort();
	for (;;) {
		const p = await makeMember();
		if (bytesEqual(slots.assignSlots(p.bytes, cohortEpoch, members).primary, primaryNode.member.bytes)) {
			return p;
		}
	}
}

/**
 * Generate a real-keyed participant whose computed primary is `primaryNode` **and** whose `backups[0]`
 * is `backupNode` (under `engine`'s epoch + member set). The crash-failover suite needs a participant
 * whose first warm backup is a known sibling so a `reattach` landing there promotes deterministically.
 */
export async function participantPrimaryBackupAt(primaryNode: HostNode, backupNode: HostNode, engine: CoordEngine): Promise<Member> {
	const { members, cohortEpoch } = engine.cohort();
	for (;;) {
		const p = await makeMember();
		const slot = slots.assignSlots(p.bytes, cohortEpoch, members);
		if (bytesEqual(slot.primary, primaryNode.member.bytes) && slot.backups[0] !== undefined && bytesEqual(slot.backups[0], backupNode.member.bytes)) {
			return p;
		}
	}
}

// --- topic setup (instantiate coord-0 engines on the cohort + seed willingness quorum) ---

export interface TopicSetup {
	readonly coord0: RingCoord;
	/** Engine on every coord-0 cohort member, keyed by member id string. */
	readonly engines: Map<string, CoordEngine>;
	/** The routed primary for `coord_0` (where `routeAct` lands a bootstrap register). */
	readonly deciding: HostNode;
	readonly decidingEngine: CoordEngine;
	/** The coord-0 cohort member id strings (the `wantK` nearest to `coord_0`). */
	readonly cohortIds: readonly string[];
}

/**
 * Instantiate the tier-0 coord engine for `topic` on every **coord-0 cohort member** and seed each one's
 * coord-0 gossip view with every *other* cohort member's willingness, so any cohort member (in
 * particular the routed primary) meets the willingness quorum and can admit. Mirrors the willingness
 * bootstrap the gossip-cadence tests do — an idle engine builds no willingness frame, so the first
 * registration needs a seed. Operating on the cohort (not all `N` nodes) keeps setup `O(wantK²)` at
 * scale; for a whole-network cohort (`wantK = N`) it covers every node, matching the live-tier milestone.
 */
export async function setupTopic(mesh: CohortMesh, topic: Uint8Array, tierAddr = addressing): Promise<TopicSetup> {
	const coord0 = tierAddr.coord0(topic);
	const seedParticipant = mesh.nodes[0]!.member.bytes; // dummy participantCoord (unused at tier 0)
	// Resolve the cohort the host actually assembles around coord_0 from any node (they all agree).
	const decidingNode = mesh.nodeNearest(coord0);
	const probeEngine = decidingNode.host.registry.forCoord(coord0, 0 as Tier, seedParticipant);
	const cohortIds = probeEngine.cohort().members.map((m) => bytesToPeerIdString(m));
	const cohortNodes = cohortIds.map((id) => mesh.nodeOf(id)).filter((n): n is HostNode => n !== undefined);

	const engines = new Map<string, CoordEngine>();
	for (const node of cohortNodes) {
		engines.set(node.member.idStr, node.host.registry.forCoord(coord0, 0 as Tier, seedParticipant));
	}
	const now = Date.now();
	for (const node of cohortNodes) {
		const epoch = engines.get(node.member.idStr)!.cohort().cohortEpoch;
		for (const other of cohortNodes) {
			if (other.member.idStr === node.member.idStr) {
				continue;
			}
			node.node.receive(PROTOCOLS.gossip, await signedWillingness(other.member, coord0, epoch, now), other.member.peerId);
		}
	}
	await delay(20); // let the async gossip handlers merge the willingness contributions
	return { coord0, engines, deciding: decidingNode, decidingEngine: engines.get(decidingNode.member.idStr)!, cohortIds };
}
