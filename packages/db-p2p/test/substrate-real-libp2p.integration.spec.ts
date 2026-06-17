import { expect } from 'chai';
import type { Libp2p } from 'libp2p';
import type { PrivateKey, PeerId } from '@libp2p/interface';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { multiaddr } from '@multiformats/multiaddr';
import { hashPeerId } from 'p2p-fret';
import {
	createTierAddressing,
	createSlotAssigner,
	RingHash,
	reactivityTopicId,
	membershipCertSigningPayload,
	registerSigningPayload,
	renewSigningPayload,
	subscribeAppPayloadBytes,
	createNotificationVerifier,
	bytesToB64url,
	b64urlToBytes,
	bytesEqual,
	Tier,
	type RingCoord,
	type MembershipCertV1,
	type RegisterV1,
	type RenewV1,
	type NotificationV1,
	type CommitCert,
	type CollectionChangeEvent,
	type BlockId,
	type ActionId,
} from '@optimystic/db-core';
import { createLibp2pNode, type NodeOptions } from '../src/libp2p-node.js';
import { peerIdToBytes, bytesToPeerIdString } from '../src/cohort-topic/peer-codec.js';
import { signPeer } from '../src/cohort-topic/peer-sig.js';
import { sendOneWay } from '../src/cohort-topic/stream-util.js';
import { DEFAULT_COHORT_TOPIC_PROTOCOLS } from '../src/cohort-topic/protocols.js';
import { signedWillingness, type Member } from '../src/testing/cohort-topic-mesh-harness.js';
import { createReactivitySelfMembershipGate, reactivityTailBytes } from '../src/cohort-topic/reactivity-membership-gate.js';
import type { CohortTopicHost, CoordEngine } from '../src/cohort-topic/host.js';

/**
 * **Substrate real-libp2p e2e tier** — the high-fidelity, small-N counterpart to the three mock-tier
 * suites (`cohort-topic/cohort-topic-scale-*.spec.ts`, `reactivity/mesh-*.spec.ts`,
 * `matchmaking/mesh-*.spec.ts`). The mock tier proves behavioral correctness at scale with deterministic
 * in-process routing; this tier proves the substrate behaves over **real TCP/libp2p transport + real FRET
 * stabilization** at small N (3–16 nodes). Scale is explicitly out of scope — that is the mock tier's and
 * the simulator's job.
 *
 * Each node is a production `createLibp2pNode({ cohortTopic: { enabled: true } })` — so the five
 * cohort-topic protocols (`register`, `cohort-gossip`, `promote`, `membership`, `sign`) run over real
 * sockets, FRET two-sided stabilization assembles the cohort for real, and the participant
 * `CohortTopicService` + `MembershipVerifier` are the production wiring. Assertions use bounded polling
 * with generous timeouts (no fixed sleeps); tolerances reflect real network timing, not the simulator's
 * exact bounds.
 *
 * **What is real over the wire here vs. what is honestly deferred.** The piece the mock mesh *stubs* — real
 * FRET cohort assembly + coordinate derivation, the `/sign` threshold-signature collection, the
 * `/membership` cert serve+fetch, and `/cohort-gossip` record replication — is exercised end-to-end over
 * real TCP. Two scenarios in the parent ticket need **production seams that are not yet wired** and are
 * tagged `it.skip` with their tracking tickets rather than faked:
 *   - reactivity notification *socket delivery* (the origination bridge fires `onLocalCommit` and the
 *     verify path is real, but no emit transport / subscriber-delivery protocol is registered in
 *     production — `libp2p-node-base.ts` "installing the origination manager + emit transport is a sibling
 *     ticket"); and
 *   - the matchmaking hang-out walk *converging to a match* (no `QueryV1` RPC handler is registered on a
 *     real node — the seeker walk's `query()` seam is unbound in production).
 * The real, wired pieces of both (the reactivity origination membership gate over real FRET; a matchmaking
 * provider record landing in + replicating across a real cohort) ARE exercised.
 *
 * Gated on `OPTIMYSTIC_INTEGRATION=1` (or `RUN_LONG_TESTS=1`) so the default `yarn test` stays fast. Run:
 *   OPTIMYSTIC_INTEGRATION=1 yarn test:integration   (db-p2p)
 * Windows (PowerShell):
 *   $env:OPTIMYSTIC_INTEGRATION=1; yarn test:integration
 */

const GATED = process.env.OPTIMYSTIC_INTEGRATION === '1' || process.env.RUN_LONG_TESTS === '1';

const NETWORK_NAME = 'substrate-real-libp2p-it';
const GOSSIP_PROTOCOL = DEFAULT_COHORT_TOPIC_PROTOCOLS.gossip;

function clampN(n: number): number {
	if (!Number.isInteger(n) || n < 3) return 3;
	return n > 16 ? 16 : n;
}

// Small N, high fidelity. wantK = N → the tier-0 cohort is the whole mesh, so `assembleCohort(coord, N)`
// converges once FRET has discovered every peer — the live-tier milestone shape, now over real sockets.
// Override N (3–16) via env for a wider real run; the substrate logic is identical, only slower to stabilize.
const N = clampN(Number.parseInt(process.env.OPTIMYSTIC_SUBSTRATE_N ?? '4', 10));
const WANT_K = N;
const MIN_SIGS = N - 1; // (N-1)-of-N quorum (the production minSigs = 14 path is identical, just larger)
// The willingness admission needs a strict-majority quorum (`defaultQuorum(N)`); self counts via live
// willingness, so the gossip view must carry at least `quorum − 1 = floor(N/2)` willing siblings.
const WILLING_SIBLINGS_NEEDED = Math.floor(WANT_K / 2);

// A topic whose tier-0 cohort is the whole mesh; fixed bytes keep coord derivation reproducible.
const TOPIC = Uint8Array.from({ length: 32 }, (_v, i) => (i * 9 + 5) & 0xff);
// A collection tail id used for the reactivity-topic anchor derivation.
const TAIL_ID = 'optimystic/collection/tail-real-libp2p';

const addressing = createTierAddressing(new RingHash());
const slots = createSlotAssigner(new RingHash());
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `predicate` until it returns true or `timeoutMs` elapses (no fixed sleeps; bounded async settle). */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 150): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return true;
		if (Date.now() >= deadline) return false;
		await delay(intervalMs);
	}
}

function slotPrimary(participantBytes: Uint8Array, cohortEpoch: Uint8Array, members: readonly Uint8Array[]): Uint8Array {
	return slots.assignSlots(participantBytes, cohortEpoch, members as Uint8Array[]).primary;
}

/** Stable bogus member bytes for the stale-cert priming (a peer-id-shaped, never-a-real-member value). */
function staleMemberBytes(): Uint8Array {
	return Uint8Array.from({ length: 34 }, (_v, i) => (i * 17 + 3) & 0xff);
}

interface SignedRegisterOptions {
	readonly tier?: number;
	readonly treeTier?: number;
	readonly bootstrap?: boolean;
	readonly ttl?: number;
}

// Signed register/renew builders for real participants (mirror the mock harness's, but kept local so the
// real-transport spec does not pull the whole mock-mesh surface — `buildMesh`, `MockNode`, … — into scope).
async function signedRegister(participant: Member, topic: Uint8Array, now: number, correlationId: string, opts: SignedRegisterOptions = {}): Promise<RegisterV1> {
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

async function signedReattach(participant: Member, topic: Uint8Array, now: number, correlationId = 'reattach'): Promise<RenewV1> {
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

/** One real libp2p substrate node: the running node, its retained key/peer-id, the cohort-topic host, FRET. */
interface RealNode {
	readonly node: Libp2p;
	readonly key: PrivateKey;
	readonly peerId: PeerId;
	readonly idStr: string;
	/** A {@link Member} view so the shared harness's signed-frame builders work against a real node. */
	readonly member: Member;
	readonly host: CohortTopicHost;
	readonly fret: { assembleCohort(coord: Uint8Array, wants: number): string[] };
}

async function memberOf(key: PrivateKey, peerId: PeerId): Promise<Member> {
	return { key, peerId, idStr: peerId.toString(), bytes: peerIdToBytes(peerId), ringPos: await hashPeerId(peerId) };
}

(GATED ? describe : describe.skip)('substrate over real libp2p (cohort-topic / reactivity / matchmaking fidelity)', function () {
	// Boot of N nodes (TCP + noise + FRET + arachnode + cohort-topic host each) plus FRET stabilization
	// dominates; individual substrate ops finish in well under a second once the mesh is up.
	this.timeout(120_000);

	const nodes: RealNode[] = [];
	let coord0: RingCoord;
	// Published ONCE in `before` after stabilization: the membership publisher is stateful per engine
	// (it republishes only when the first k−x members change), so a second `onStabilized` is a no-op. The
	// cert stays SERVED on the primary's `/membership` handler, so every remote fetch below resolves it.
	let coord0Cert: MembershipCertV1;

	async function spawnNode(overrides: Partial<NodeOptions> = {}): Promise<RealNode> {
		const key = await generateKeyPair('Ed25519');
		const peerId = peerIdFromPrivateKey(key);
		const node = await createLibp2pNode({
			port: 0,
			networkName: NETWORK_NAME,
			bootstrapNodes: [],
			privateKey: key,
			clusterSize: 1,
			clusterPolicy: { allowDownsize: true, sizeTolerance: 1.0 },
			arachnode: { enableRingZulu: true },
			cohortTopic: {
				enabled: true,
				wantK: WANT_K,
				host: {
					minSigs: MIN_SIGS,
					// Park the periodic driver far out: this suite pumps gossip / membership deterministically so a
					// background tick cannot race the bounded-poll assertions (mirrors the mock harness default).
					gossipIntervalMs: 3_600_000,
				},
			},
			...overrides,
		});
		const real: RealNode = {
			node,
			key,
			peerId,
			idStr: peerId.toString(),
			member: await memberOf(key, peerId),
			host: (node as unknown as { cohortTopicHost: CohortTopicHost }).cohortTopicHost,
			fret: (node as unknown as { services: { fret: { assembleCohort(coord: Uint8Array, wants: number): string[] } } }).services.fret,
		};
		nodes.push(real);
		return real;
	}

	function pickLocalTcpMultiaddr(node: Libp2p): string {
		const addrs = node.getMultiaddrs().map((a) => a.toString());
		const local = addrs.find((a) => a.startsWith('/ip4/127.0.0.1/tcp/')) ?? addrs.find((a) => a.includes('/tcp/') && a.includes('/p2p/'));
		if (!local) throw new Error(`No usable TCP multiaddr; have: ${addrs.join(', ')}`);
		return local;
	}

	/** Instantiate every node's tier-0 cohort engine for `coord` (so each has a live `/cohort-gossip` sub). */
	function engines(coord: RingCoord): CoordEngine[] {
		return nodes.map((n) => n.host.registry.forCoord(coord, 0 as Tier, n.member.bytes));
	}

	/** This node's tier-0 cohort engine for `coord`. */
	function engineOf(n: RealNode, coord: RingCoord): CoordEngine {
		return n.host.registry.forCoord(coord, 0 as Tier, n.member.bytes);
	}

	/** The full mesh peer-id set — what the whole-network tier-0 cohort must converge to. */
	function fullIdSet(): Set<string> {
		return new Set(nodes.map((n) => n.idStr));
	}

	/** The FRET-nearest member to `coord` (the routed primary): `assembleCohort(coord, N)[0]`, mapped to its node. */
	function primaryFor(coord: RingCoord): RealNode {
		const primaryId = nodes[0]!.fret.assembleCohort(coord, WANT_K)[0]!;
		return nodes.find((n) => n.idStr === primaryId) ?? nodes[0]!;
	}

	/** Seed the willingness quorum for `coord`: every member signs+sends a willingness frame to every other. */
	async function seedWillingness(coord: RingCoord): Promise<void> {
		const epoch = engineOf(nodes[0]!, coord).cohort().cohortEpoch;
		const now = Date.now();
		const sends: Promise<void>[] = [];
		for (const from of nodes) {
			const frame = await signedWillingness(from.member, coord, epoch, now);
			for (const to of nodes) {
				if (to.idStr === from.idStr) continue;
				sends.push(sendOneWay(from.node, to.peerId, GOSSIP_PROTOCOL, frame).catch(() => { /* best-effort; next round recovers */ }));
			}
		}
		await Promise.allSettled(sends);
		await delay(300); // let the async inbound /cohort-gossip handlers merge the willingness contributions
	}

	/** Seed willingness for `coord` and wait until the primary's view carries the strict-majority quorum. */
	async function quorumOn(primaryEngine: CoordEngine, coord: RingCoord): Promise<boolean> {
		await seedWillingness(coord);
		const ok = await waitFor(() => primaryEngine.cohortView().all().size >= WILLING_SIBLINGS_NEEDED, 20_000, 200);
		if (ok) return true;
		// One more seed wave in case some first-round dials lost the race to a not-yet-open stream.
		await seedWillingness(coord);
		return waitFor(() => primaryEngine.cohortView().all().size >= WILLING_SIBLINGS_NEEDED, 20_000, 200);
	}

	/** Publish a coord's membership cert, retrying past transient sub-quorum `/sign` rounds (real RPC settle). */
	async function publishCohortCert(coord: RingCoord): Promise<MembershipCertV1> {
		const primaryEngine = engineOf(primaryFor(coord), coord);
		let lastErr: unknown;
		for (let attempt = 0; attempt < 40; attempt++) {
			try {
				const cert = await primaryEngine.onStabilized(Date.now());
				if (cert !== undefined) return cert;
			} catch (err) {
				// Transient: a `/sign` round that gathered < minSigs before all warm connections settled. The
				// publisher published nothing (it threshold-signs before publishing), so a retry is a clean first
				// publish. Once it succeeds, `onStabilized` returns the cert; a later no-op return never reaches here.
				lastErr = err;
			}
			await delay(500);
		}
		throw lastErr ?? new Error('membership cert never reached quorum');
	}

	/** A fresh real-keyed participant whose deterministic slot-primary (under `engine`'s epoch) is the routed primary. */
	async function participantPrimaryAt(engine: CoordEngine, coord: RingCoord): Promise<Member> {
		const primary = primaryFor(coord);
		const { members, cohortEpoch } = engine.cohort();
		for (let attempt = 0; attempt < 8192; attempt++) {
			const key = await generateKeyPair('Ed25519');
			const member = await memberOf(key, peerIdFromPrivateKey(key));
			if (bytesEqual(slotPrimary(member.bytes, cohortEpoch, members), primary.member.bytes)) return member;
		}
		throw new Error('could not derive a participant pinned to the routed primary');
	}

	before(async function () {
		// Star topology to bootstrap discovery: nodes[0] is the bootstrap; the rest dial it.
		const seed = await spawnNode();
		const bootstrapAddr = pickLocalTcpMultiaddr(seed.node);
		const dialAddrs = [bootstrapAddr];
		for (let i = 1; i < N; i++) {
			const n = await spawnNode({ bootstrapNodes: [bootstrapAddr], fretProfile: 'core' });
			dialAddrs.push(pickLocalTcpMultiaddr(n.node));
		}

		// Establish an explicit FULL MESH of warm connections: every node dials every other's TCP addr. The
		// cohort-topic RPCs (`/sign` threshold collection, `/membership` fetch, `/cohort-gossip` fan-out) dial
		// arbitrary cohort members, so whichever member FRET routes to as the primary must already have a warm,
		// address-resolved connection to the rest — a star (leaf→bootstrap only) leaves leaf↔leaf `/sign` dials
		// to resolve cold and intermittently fall short of quorum.
		for (const n of nodes) {
			for (let j = 0; j < nodes.length; j++) {
				if (nodes[j]!.idStr === n.idStr) continue;
				try { await n.node.dial(multiaddr(dialAddrs[j]!)); } catch { /* a peer already dialed us covers this edge */ }
			}
		}
		const connected = await waitFor(() => nodes.every((n) => n.node.getPeers().length >= N - 1), 60_000, 250);
		expect(connected, `the ${N}-node full mesh did not fully connect within the bound`).to.equal(true);

		coord0 = addressing.coord0(TOPIC);

		// Instantiate the tier-0 engine on every node up front so each has a live `/cohort-gossip`
		// subscription for coord_0 before any willingness / record gossip is sent.
		engines(coord0);

		// Wait for real FRET two-sided stabilization: every node's tier-0 cohort around coord_0 must be the
		// whole-mesh set. Generous bound — real FRET discovery gossip is non-instant.
		const expected = fullIdSet();
		const stabilized = await waitFor(() => {
			for (const n of nodes) {
				const members = new Set(engineOf(n, coord0).cohort().members.map(bytesToPeerIdString));
				if (members.size !== N) return false;
				for (const id of expected) if (!members.has(id)) return false;
			}
			return true;
		}, 90_000, 250);
		expect(stabilized, `FRET did not stabilize the ${N}-node tier-0 cohort within the bound`).to.equal(true);

		// Publish the coord_0 cohort's membership cert once (real (N-1)-of-N multisig collected over `/sign`);
		// it stays served on the routed primary's `/membership` handler for the verify + stale-refetch tests.
		coord0Cert = await publishCohortCert(coord0);
	});

	after(async () => {
		const toStop = nodes.splice(0, nodes.length);
		await Promise.allSettled(toStop.map((n) => n.node.stop()));
	});

	// --- 1. FRET cohort assembly + coordinate derivation (real two-sided stabilization) ---
	it('FRET assembles the tier-0 cohort = the whole mesh, with one identical coord/epoch on every node', () => {
		const expected = fullIdSet();
		const epochs = new Set<string>();
		for (const n of nodes) {
			const snap = engineOf(n, coord0).cohort();
			const members = new Set(snap.members.map(bytesToPeerIdString));
			expect(members, `node ${n.idStr} assembled the whole-mesh cohort around coord_0`).to.deep.equal(expected);
			expect(engineOf(n, coord0).treeTier, 'instantiated at tier 0').to.equal(0);
			epochs.add(bytesToB64url(snap.cohortEpoch));
		}
		// The deterministic coord_0 epoch is what the threshold-signature collection depends on: a fragmented
		// cohort (nodes disagreeing on the member set) could never quorum. Real FRET converges to one epoch.
		expect(epochs.size, 'all N nodes derive one identical cohort epoch for coord_0').to.equal(1);
	});

	// --- 2. MembershipCertV1: real k−x threshold sig over /sign, served over /membership, verified remotely ---
	it('a cohort publishes a real threshold-signed MembershipCertV1 that a remote participant verifies end-to-end', async () => {
		// `coord0Cert` was assembled in `before` by the routed primary collecting a genuine (N-1)-of-N multisig
		// over the real `/sign` RPC; it stays served on that primary's real `/membership` protocol.
		const primary = primaryFor(coord0);
		const cert = coord0Cert;
		expect(cert.signers.length, 'at least minSigs distinct signers').to.be.at.least(MIN_SIGS);
		expect(new Set(cert.signers).size, 'signers are distinct').to.equal(cert.signers.length);
		const certMembers = new Set(cert.members);
		expect(cert.signers.every((s) => certMembers.has(s)), 'every signer is a cohort member').to.equal(true);

		// A *different* node's participant verifier fetches the cert over the real `/membership` protocol and
		// verifies the real collected multisig for real.
		const participant = nodes.find((n) => n.idStr !== primary.idStr)!;
		const certPayload = membershipCertSigningPayload(cert);
		const verdict = await participant.host.service.verifier().verifyMessage(cert.signers.map(b64urlToBytes), coord0, 0, certPayload, b64urlToBytes(cert.thresholdSig));
		expect(verdict, 'a participant verifies the real threshold-signed cert end-to-end over /membership').to.equal('verified');

		// Negative: the interim shape — a single-signer "threshold" sig — is rejected at minSigs = N-1.
		const forgedSig = await signPeer(primary.member.key, certPayload);
		const forged = await participant.host.service.verifier().verifyMessage([primary.member.bytes], coord0, 0, certPayload, forgedSig);
		expect(forged, 'a forged single-signer cert is untrusted').to.equal('untrusted');
	});

	it('the verifier does a one-fetch-and-retry over /membership when its cached cert is stale', async () => {
		const primary = primaryFor(coord0);
		const cert = coord0Cert;

		const participant = nodes.find((n) => n.idStr !== primary.idStr)!;
		const verifier = participant.host.service.verifier();

		// Prime the verifier with a STALE cert for coord_0: a different member set, so the real message's
		// signers are not a subset of it → the cached-cert attempt fails and forces exactly one real
		// `/membership` refetch, which returns the fresh cohort cert and verifies.
		const stale = [bytesToB64url(staleMemberBytes())];
		const staleCert: MembershipCertV1 = {
			v: 1,
			cohortCoord: bytesToB64url(coord0),
			cohortEpoch: bytesToB64url(new Uint8Array([9, 9, 9])),
			members: stale,
			stabilizedAt: Date.now() - 1_000_000,
			thresholdSig: bytesToB64url(new Uint8Array([0])),
			signers: stale,
		};
		verifier.cache(staleCert);

		const certPayload = membershipCertSigningPayload(cert);
		const verdict = await verifier.verifyMessage(cert.signers.map(b64urlToBytes), coord0, 0, certPayload, b64urlToBytes(cert.thresholdSig));
		expect(verdict, 'a stale cached cert triggers one /membership refetch, then verifies').to.equal('verified');
	});

	// --- 3. Cohort-gossip record replication + handoff readiness over real /cohort-gossip ---
	it('a record accepted on the routed primary replicates into a sibling store over real /cohort-gossip (no loss across a touch)', async () => {
		const primary = primaryFor(coord0);
		const primaryEngine = engineOf(primary, coord0);
		const sibling = nodes.find((n) => n.idStr !== primary.idStr)!;
		const siblingEngine = engineOf(sibling, coord0);

		// Bootstrap the willingness quorum the cohort admission needs: an idle engine builds no willingness
		// frame, so the first registration needs this seed (exactly as the mock-tier `setupTopic` does).
		expect(await quorumOn(primaryEngine, coord0), 'the willingness quorum converged on the primary over real gossip').to.equal(true);

		// A participant whose deterministic slot-primary is the routed primary, so the served ping/re-attach
		// touches the record into the gossip deltas (an arbitrary participant lands on the primary only ~1/k).
		const participant = await participantPrimaryAt(primaryEngine, coord0);
		const now = Date.now();
		const accept = await primaryEngine.engine.handleRegister(await signedRegister(participant, TOPIC, now, 'real-repl'), { followOn: false, treeTier: 0 }, now);
		expect(accept.result, 'the cohort admitted the registration over the real willingness quorum').to.equal('accepted');
		expect(primaryEngine.engine.handleRenew(await signedReattach(participant, TOPIC, now), now).result, 'reattach touches the record').to.equal('ok');

		// One gossip round broadcasts the touched record to the cohort over real `/cohort-gossip`.
		const g = await primaryEngine.gossipRound(now);
		expect(g?.records?.length, 'the round carries the touched record').to.be.at.least(1);

		const replicated = await waitFor(() => siblingEngine.holds(TOPIC, participant.bytes), 20_000, 150);
		expect(replicated, 'the sibling replicated the record over real /cohort-gossip').to.equal(true);
		// Handoff readiness: the sibling now *serves the topic*, so it is a viable warm-failover target for the
		// participant's primary — the cohort-side half of primary handoff. (The full FRET-departure-driven epoch
		// rotation is timing-bound on real churn detection; see the suite header + the review handoff.)
		expect(siblingEngine.servesTopic(TOPIC), 'a sibling now serves the topic (warm-failover target exists)').to.equal(true);
	});

	// --- 4. Reactivity origination membership gate over real FRET + bridge wiring present ---
	it('the production reactivity origination bridge is wired and its membership gate matches the real FRET cohort', () => {
		// The node-base activation replaced the bare change-notifier with the origination-decorating bridge and
		// exposed the host (`libp2p-node-base.ts` §Cohort-topic origination activation).
		for (const n of nodes) {
			expect((n.node as unknown as { cohortTopicHost?: unknown }).cohortTopicHost, 'cohort-topic host exposed').to.exist;
			expect((n.node as unknown as { blockChangeNotifier?: unknown }).blockChangeNotifier, 'change-notifier bridge installed').to.exist;
		}

		// The real `selfIsCohortMember` gate over real FRET agrees with `assembleCohort(coord_0(reactivityTopicId(tail)))`.
		const reactivityCoord = addressing.coord0(reactivityTopicId(reactivityTailBytes(TAIL_ID)));
		const expectedMembers = new Set(nodes[0]!.fret.assembleCohort(reactivityCoord, WANT_K));
		for (const n of nodes) {
			const gate = createReactivitySelfMembershipGate({ fret: n.fret, selfPeerId: n.idStr, wantK: WANT_K });
			const isMember = gate({ collectionId: 'c', blockIds: [], actionId: 'a', rev: 1, tailId: TAIL_ID });
			expect(isMember, `node ${n.idStr} gate agrees with its membership in the reactivity cohort`).to.equal(expectedMembers.has(n.idStr));
		}
		// At wantK = N the whole mesh is the reactivity cohort, so every node originates for this tail.
		expect(expectedMembers.size, 'reactivity tier-0 cohort = whole mesh at wantK = N').to.equal(N);
	});

	// reactivity notification *socket delivery* end-to-end is now LIVE in production (12.33): the node wires
	// ReactivityOriginationManager.emit → forwarder host → the notify protocol, and a node-level subscriber
	// registry receives inbound frames. A committed change on a tail-cohort member fires a NotificationV1 that
	// reaches a remote subscriber over a real socket; the subscriber verifies it with real Ed25519 against the
	// tail cohort's membership. (Rotation-specific redirect is 12.5; the Quereus Database.watch app-bridge that
	// CONSTRUCTS managers stays the backlog optimystic-network-reactive-watch-integration-test — here the
	// subscriber is constructed directly against the remote node's registry.)
	it('a commit on a real cohort member delivers a NotificationV1 to a remote subscriber over a real socket', async () => {
		const tailBytes = reactivityTailBytes(TAIL_ID);
		const topicId = reactivityTopicId(tailBytes);
		const reactivityCoord = addressing.coord0(topicId);

		// Instantiate every node's reactivity cohort engine + converge willingness so the primary can admit the
		// subscriber registration (mirrors the matchmaking provider test's pre-steps).
		engines(reactivityCoord);
		const origin = primaryFor(reactivityCoord);
		const originEngine = engineOf(origin, reactivityCoord);
		expect(await quorumOn(originEngine, reactivityCoord), 'willingness converged for the reactivity topic').to.equal(true);

		// The remote subscriber is a different real node; register it as a direct reactivity subscriber on the
		// origin's cohort engine so origin's `directSubscribers(topicId)` → [remote] and origin dials it.
		const remote = nodes.find((n) => n.idStr !== origin.idStr)!;
		const collectionIdB64 = bytesToB64url(new TextEncoder().encode('rx-socket-collection'));
		const now = Date.now();
		const appPayload = subscribeAppPayloadBytes({
			collectionId: collectionIdB64,
			tailIdAtAttach: bytesToB64url(tailBytes),
			lastKnownRev: 0,
			deltaMaxBytes: 0,
		});
		const regBody: Omit<RegisterV1, 'signature'> = {
			v: 1,
			topicId: bytesToB64url(topicId),
			tier: Tier.T3,
			treeTier: 0,
			participantCoord: bytesToB64url(remote.member.bytes),
			ttl: 90_000,
			bootstrap: true,
			timestamp: now,
			correlationId: bytesToB64url(new TextEncoder().encode('rx-socket-sub')),
			appPayload: bytesToB64url(appPayload),
		};
		const reg: RegisterV1 = { ...regBody, signature: bytesToB64url(await signPeer(remote.member.key, registerSigningPayload(regBody))) };
		const accept = await originEngine.engine.handleRegister(reg, { followOn: false, treeTier: 0 }, now);
		expect(accept.result, 'the reactivity subscriber registration was admitted on the origin cohort engine').to.equal('accepted');
		expect(
			originEngine.records(topicId).some((r) => r.appState !== undefined && bytesEqual(r.participantId, remote.member.bytes)),
			'origin holds the remote reactivity subscriber record (direct-subscriber read)',
		).to.equal(true);

		// Cache the tail cohort's MembershipCertV1 (whole mesh at wantK = N) into every node's verifier, so the
		// origin's own forwarder receive AND the remote subscriber's verify are real Ed25519 against the
		// membership (cache() trusts the membership list; the notification's own threshold sig is verified).
		const members = nodes.map((n) => bytesToB64url(n.member.bytes));
		const cert: MembershipCertV1 = {
			v: 1,
			cohortCoord: bytesToB64url(reactivityCoord),
			cohortEpoch: bytesToB64url(new TextEncoder().encode(`rx:${TAIL_ID}`)),
			members,
			stabilizedAt: now,
			thresholdSig: bytesToB64url(new Uint8Array([0])),
			signers: members,
		};
		for (const n of nodes) {
			n.host.service.verifier().cache(cert);
		}

		// Register the remote subscriber in the remote node's reactivity subscriber registry, verifying each
		// inbound notification with the production notification verifier (real collected-multisig at T3).
		const received: NotificationV1[] = [];
		const verdicts: string[] = [];
		const verifier = createNotificationVerifier({ verifier: remote.host.service.verifier(), tier: Tier.T3 });
		const registry = (remote.node as unknown as { reactivitySubscribers: { register(topicId: Uint8Array, h: (n: NotificationV1) => void): () => void } }).reactivitySubscribers;
		const off = registry.register(topicId, (n) => {
			received.push(n);
			void verifier.verify(n).then((r) => verdicts.push(r));
		});

		try {
			// Build a REAL threshold commit cert over the cohort: every member signs utf8(commitHash+":approve")
			// with its real Ed25519 key. signers are sorted by peer-id string so each aligns with its 64-byte
			// chunk of the concatenated threshold sig (mirrors buildCommitCert / the mesh harness's buildTailCert).
			const commitHash = `${collectionIdB64}:1`;
			const signedPayload = new TextEncoder().encode(`${commitHash}:approve`);
			const sortedSigners = [...nodes].sort((a, b) => (a.idStr < b.idStr ? -1 : a.idStr > b.idStr ? 1 : 0));
			const chunks: Uint8Array[] = [];
			for (const n of sortedSigners) {
				chunks.push(await n.key.sign(signedPayload));
			}
			const thresholdSig = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
			let offset = 0;
			for (const c of chunks) {
				thresholdSig.set(c, offset);
				offset += c.length;
			}
			const commitCert: CommitCert = { thresholdSig, signers: sortedSigners.map((n) => n.idStr), minSigs: MIN_SIGS, signedPayload };

			// Fire origination on the origin: the production onLocalCommit hook builds the NotificationV1 and
			// emits it → forwarder host → notify socket → the remote node's subscriber registry.
			const event: CollectionChangeEvent = {
				collectionId: collectionIdB64 as unknown as BlockId,
				blockIds: [],
				actionId: 'rx-socket-action' as ActionId,
				rev: 1,
				tailId: TAIL_ID as BlockId,
			};
			expect(typeof origin.host.service.onLocalCommit, 'origination hook installed on the origin').to.equal('function');
			origin.host.service.onLocalCommit!(event, commitCert);

			const delivered = await waitFor(() => received.length >= 1, 20_000, 150);
			expect(delivered, 'the remote subscriber received a NotificationV1 over the real notify socket').to.equal(true);
			expect(received[0]!.revision, 'the delivered notification carries the committed revision').to.equal(1);
			expect(received[0]!.tailId, 'the delivered notification anchors on the committed tail').to.equal(bytesToB64url(tailBytes));

			const verified = await waitFor(() => verdicts.length >= 1, 5_000, 50);
			expect(verified, 'the subscriber ran the verify path on the delivered notification').to.equal(true);
			expect(verdicts[0], 'the delivered notification verified end-to-end (real Ed25519 against the tail cohort)').to.equal('verified');
		} finally {
			off();
		}
	});

	// --- 5. Matchmaking: a provider record lands in + replicates across a real cohort ---
	it('a matchmaking provider registration lands in the real cohort and replicates over /cohort-gossip', async () => {
		const matchTopic = Uint8Array.from({ length: 32 }, (_v, i) => (i * 7 + 11) & 0xff);
		const matchCoord = addressing.coord0(matchTopic);
		// Instantiate + stabilize willingness for this topic's cohort (whole mesh at wantK = N).
		engines(matchCoord);
		const matchPrimary = primaryFor(matchCoord);
		const matchPrimaryEngine = engineOf(matchPrimary, matchCoord);
		expect(await quorumOn(matchPrimaryEngine, matchCoord), 'willingness converged for the matchmaking topic').to.equal(true);

		const provider = await participantPrimaryAt(matchPrimaryEngine, matchCoord);
		const now = Date.now();
		// A matchmaking provider rides the cohort-topic register at the matchmaking application tier (T2).
		const accept = await matchPrimaryEngine.engine.handleRegister(await signedRegister(provider, matchTopic, now, 'mm-provider', { tier: 2 }), { followOn: false, treeTier: 0 }, now);
		expect(accept.result, 'the cohort admitted the provider registration over real transport').to.equal('accepted');
		expect(matchPrimaryEngine.records(matchTopic).length, 'the primary holds the provider record (the matchmaking QueryV1 read)').to.be.at.least(1);

		// Touch + gossip so a sibling replicates the provider record (the cohort-side read a remote seeker query
		// would serve from). The seeker *walk* over real sockets needs the unwired QueryV1 RPC (next test).
		expect(matchPrimaryEngine.engine.handleRenew(await signedReattach(provider, matchTopic, now), now).result).to.equal('ok');
		await matchPrimaryEngine.gossipRound(now);
		const sibling = nodes.find((n) => n.idStr !== matchPrimary.idStr)!;
		const siblingEngine = engineOf(sibling, matchCoord);
		const replicated = await waitFor(() => siblingEngine.records(matchTopic).length >= 1, 20_000, 150);
		expect(replicated, 'the provider record replicated to a sibling cohort member over real /cohort-gossip').to.equal(true);
	});

	// The matchmaking hang-out walk *converging to a match* over real sockets needs the QueryV1 RPC handler,
	// which is not registered on a production node (the seeker walk's `query()` seam is unbound). The hang-out
	// *decision* logic is mock-tier-validated (`matchmaking/mesh-walk.spec.ts`). Tagged, not faked.
	it.skip('[requires production wiring: matchmaking QueryV1 RPC handler — tracked by backlog matchmaking-real-libp2p-query-transport] a seeker hang-out walk queries real cohorts over real sockets and converges to a match', () => {
		/* deferred: no /matchmaking/query protocol handler is registered; handleMatchmakingQuery has no production dialer (seeker walk query() seam unbound) */
	});

	// --- 6. Cluster-formation / same-FRET-ring consistency ---
	it('the cohort-topic cohort and the transaction layer derive from the SAME FRET ring, deterministically agreed across nodes', () => {
		// Both the cohort-topic substrate and the transaction/cluster layer assemble cohorts from the one FRET
		// ring via `fret.assembleCohort(coord, k)`. The consistency invariant is: for any coord, every node's
		// assembly agrees (a single ring, not per-node disagreement) — so a cohort-topic cohort and a
		// transaction cluster keyed at the same coord are byte-identical, and keyed at different coords they are
		// each a deterministic slice of the same ring. (The reactivity topic coord and a block's transaction key
		// hash to *different* coords, so they are different cohorts BY DESIGN; what must hold is same-ring
		// determinism, which is what a real cross-layer read depends on.)
		const probes: RingCoord[] = [
			coord0,
			addressing.coord0(reactivityTopicId(reactivityTailBytes(TAIL_ID))),
			addressing.coord0(Uint8Array.from({ length: 32 }, (_v, i) => (i * 13 + 1) & 0xff)),
		];
		for (const coord of probes) {
			const reference = nodes[0]!.fret.assembleCohort(coord, WANT_K).slice().sort();
			for (const n of nodes) {
				const seen = n.fret.assembleCohort(coord, WANT_K).slice().sort();
				expect(seen, `node ${n.idStr} agrees on the cohort for a coord (single FRET ring)`).to.deep.equal(reference);
			}
		}
	});

	// participant `service.register` full FRET-routed walk over real sockets: exercised at the cohort-admission
	// level above (handleRegister over the real willingness quorum + real /cohort-gossip replication). The full
	// router-driven walk-toward-root is FRET-routing-timing-sensitive over real TCP at small N and is covered
	// deterministically by the mock tier (`live-tier.spec.ts` test 2); see the review handoff for the rationale.
	it.skip('[covered at cohort-admission + replication level here; full FRET-routed participant walk is mock-tier-deterministic] a participant service.register() walk over real sockets resolves an accepted handle', () => {
		/* deferred to avoid FRET-routing flakiness at small N; the cohort-side admission it would drive is asserted above */
	});
});
