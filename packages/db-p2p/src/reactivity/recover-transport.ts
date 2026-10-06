/**
 * Reactivity recover RPC transport — the live libp2p backfill/resume recovery protocol
 * (`docs/reactivity.md` §Backfill RPC, §Resume).
 *
 * This is the **pull** companion to the one-way notify transport: a subscriber that detected a gap (or
 * woke from sleep) asks a serving cohort member "what did I miss?" and is brought current. The protocol is
 * **request-reply** — one {@link RecoverRequestV1} frame out, one {@link RecoverReplyV1} frame back over a
 * single stream — so it rides the cohort-topic {@link requestResponse} / {@link handleRequestResponse}
 * helpers (NOT the one-way notify helpers, which would desync the dialer).
 *
 * Two pieces live here, both decoupled from the live node assembly so they unit-test in isolation:
 *
 *  - {@link Libp2pReactivityRecoverTransport} — the **outbound** side. Supplies the two db-core seams
 *    (`BackfillTransport` / `ResumeTransport`) against one node: pick a target (sticky cohort-hint primary
 *    first for the one-RT happy path, else a member of the tail's root group — the storage group that
 *    serves the topic's push state), frame the request, exchange it over the recover protocol, and return
 *    the inner reply. The wire exchange is injected as a {@link RecoverDialer} so the target-selection +
 *    framing logic tests without a real socket; {@link createLibp2pRecoverDialer} is the production
 *    libp2p-backed implementation.
 *  - {@link createRecoverRequestHandler} / {@link registerRecoverHandler} — the **inbound** serve handler.
 *    Decode (bounded) → verify the request's peer-key signature against the dialing peer → reject a
 *    replay/stale request → resolve the live `PushState` → `serveBackfill` / `serveResume` → reply. Any
 *    failure **declines** rather than throwing out of the handler: the member sends a zero-length reply (no
 *    result), and the dialing transport falls through to the next cohort candidate.
 *
 * ## Dial-target encoding bridge (load-bearing)
 *
 * The sticky {@link import("@optimystic/db-core").ReactivityCohortHint}`.primary` is **base64url of
 * cohort member-id bytes** (`base64url(utf8(peerIdString))`), per its db-core JSDoc, whereas
 * {@link requestResponse} needs a `peerIdFromString`-parseable peer-id **string**. Feeding the raw
 * base64url straight to `peerIdFromString` throws → the dial is swallowed → recovery silently never
 * reaches the cohort. {@link decodeCohortHintTarget} pins the conversion
 * (`bytesToPeerIdString(b64urlToBytes(primary))`); the `resolveCohort` root-group read, by contrast,
 * already returns peer-id strings (the key network's serving-cohort space) and is used as-is.
 */

import type { Libp2p } from "libp2p";
import type { PeerId, PrivateKey } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import {
	b64urlToBytes,
	bytesToB64url,
	serveBackfill,
	serveResume,
	backfillSigningPayload,
	resumeSigningPayload,
	encodeRecoverRequestV1,
	decodeRecoverRequestV1,
	encodeRecoverReplyV1,
	decodeRecoverReplyV1,
	type BackfillV1,
	type BackfillReplyV1,
	type BackfillSignable,
	type ResumeV1,
	type ResumeSignable,
	type RecoverKind,
	type RecoverReplyV1,
	type BackfillTransport,
	type PushState,
	type StickyCohortHintCache,
	type CorrelationReplayGuard,
	type RotationRedirectV1,
} from "@optimystic/db-core";
import { requestResponse, handleRequestResponse, NoResultReplyError, DEFAULT_STREAM_MAX_BYTES } from "../cohort-topic/stream-util.js";
import { verifyPeerSig, signPeerSig } from "../cohort-topic/peer-sig.js";
import { peerIdToBytes, bytesToPeerIdString } from "../cohort-topic/peer-codec.js";
import { PROTOCOL_REACTIVITY_RECOVER } from "./protocols.js";
import type { ResumeTransport } from "./subscription-manager.js";
import { createLogger } from "../logger.js";
import type { StreamOpenDeadlines } from "../rpc-deadline.js";

const log = createLogger("reactivity-recover");

/**
 * Decode a sticky-cohort-hint `primary` (base64url of member-id bytes = `base64url(utf8(peerIdString))`)
 * back to the dialable peer-id string. The inverse trap of feeding the raw value to `peerIdFromString`
 * (which expects a peer-id string, not base64url-of-its-utf8) — pinned by the dial-target encoding test.
 */
export function decodeCohortHintTarget(primary: string): string {
	return bytesToPeerIdString(b64urlToBytes(primary));
}

// --- subscriber request signing (the manager's synchronous signer seam) ---

/**
 * The synchronous request-signing seam the production subscribe factory feeds a
 * {@link import("./subscription-manager.js").ReactivitySubscriptionManager}: it builds a
 * {@link BackfillV1} / {@link ResumeV1} signature (base64url) over the unsigned image.
 */
export interface RecoverRequestSigners {
	/** Sign a {@link BackfillV1} over {@link backfillSigningPayload} of its unsigned image. */
	readonly signBackfill: (unsigned: BackfillSignable) => string;
	/** Sign a {@link ResumeV1} over {@link resumeSigningPayload} of its unsigned image. */
	readonly signResume: (unsigned: ResumeSignable) => string;
}

/**
 * Build the subscriber's recover request signers from the node's libp2p Ed25519 private key.
 *
 * This resolves the recover wiring's one design point: the subscription-manager `signBackfill` /
 * `signResume` ports are **synchronous** (`(unsigned) => string`) — the db-core driver builds the
 * unsigned image internally, so a pre-signed value is impossible — but libp2p `PrivateKey.sign` is
 * **async**. Rather than make the seam (and `createBackfillRequester`'s `sign`, a db-core change) async,
 * sign with the synchronous {@link signPeerSig} (noble, over the raw Ed25519 seed) over db-core's
 * canonical signing payloads. The produced signature verifies on the serving side under
 * {@link verifyPeerSig} over the same bytes (both noble, RFC8032), so the round trip is symmetric.
 */
export function createRecoverRequestSigners(privateKey: PrivateKey): RecoverRequestSigners {
	return {
		signBackfill: (unsigned: BackfillSignable): string => bytesToB64url(signPeerSig(privateKey, backfillSigningPayload(unsigned))),
		signResume: (unsigned: ResumeSignable): string => bytesToB64url(signPeerSig(privateKey, resumeSigningPayload(unsigned))),
	};
}

// --- outbound transport ---

/**
 * Thrown out of {@link Libp2pReactivityRecoverTransport.backfillTransport} / `resumeTransport` when the
 * dialed cohort answered with a `kind: "rotated"` recover reply: the outgoing tail this request reached has
 * rotated and is draining, so it bounced the request to the new root (`docs/reactivity.md` §Tail rotation).
 * It carries the {@link RotationRedirectV1} so the subscription manager can move itself to the successor.
 *
 * A `kind: "rotated"` reply is **terminal** for the cohort-walk — the dialed member spoke authoritatively for
 * the cohort, so the transport stops rather than falling through to the next target (contrast a *dial
 * failure*, which still falls through). The subscriber honors it like a notification-driven rotation.
 */
export class RotationRedirectError extends Error {
	/** The drain-window redirect the serving cohort returned (`newTailId` / `newTopicId` / `effectiveAtRevision`). */
	readonly redirect: RotationRedirectV1;
	constructor(redirect: RotationRedirectV1) {
		super(`reactivity recover: cohort rotated to tail ${redirect.newTailId} (effectiveAtRevision ${redirect.effectiveAtRevision})`);
		this.name = "RotationRedirectError";
		this.redirect = redirect;
	}
}

/** The wire exchange seam: open the recover protocol to `target`, send `frame`, return the bounded reply. */
export interface RecoverDialer {
	/**
	 * Exchange one request frame for one reply frame with `target` (peer-id string). Resolves `undefined` when
	 * the member declined (no served state, a failed signature / replay check, an undecodable request) — the
	 * same contract as {@link requestResponse}. Rejects on a dial failure.
	 */
	exchange(target: string, frame: Uint8Array): Promise<Uint8Array | undefined>;
}

/**
 * Build the production libp2p-backed {@link RecoverDialer} over {@link requestResponse}. `streamOpen` is
 * the stream-open delays each exchange dials under: the node's `LinkDeadlines` where the host has them.
 */
export function createLibp2pRecoverDialer(
	node: Libp2p,
	recoverProtocol: string = PROTOCOL_REACTIVITY_RECOVER,
	maxBytes: number = DEFAULT_STREAM_MAX_BYTES,
	streamOpen?: StreamOpenDeadlines,
): RecoverDialer {
	return {
		exchange: (target, frame) => requestResponse(node, peerIdFromString(target), recoverProtocol, frame, maxBytes, streamOpen),
	};
}

/** Construction inputs for a {@link Libp2pReactivityRecoverTransport}. */
export interface Libp2pReactivityRecoverTransportOptions {
	/** Wire exchange (e.g. {@link createLibp2pRecoverDialer} over the live node). */
	readonly dialer: RecoverDialer;
	/** This node's peer-id string (`node.peerId.toString()`); never dialed — a co-located serve is the node wiring's. */
	readonly selfPeerId: string;
	/** Sticky cohort-hint cache, shared with the subscription manager (the one-RT primary for the happy path). */
	readonly cohortHintCache: StickyCohortHintCache;
	/**
	 * Root-group fallback: the tail's routing key bytes → the dialable peer-id strings of the group that
	 * stores that tail block (the topic's root, which holds its gossiped push state). Async because it reads
	 * the key network; a rejection fails the recover like an empty group does.
	 */
	readonly resolveCohort: (tailId: Uint8Array) => Promise<readonly string[]>;
	/** Per-frame ceiling for encode/decode; default {@link DEFAULT_STREAM_MAX_BYTES}. */
	readonly maxBytes?: number;
}

/**
 * The outbound recover transport: one instance per node, exposing the two db-core function seams against it.
 * Each returned transport dials the **sticky primary first** (one round trip after a brief flap), falling
 * back to the **root group's** members on a dial failure *or* when the dialed member declines (any member that
 * holds the topic's gossiped `PushState` can answer, so one member with nothing to serve must not end the
 * walk). A kind mismatch, an undecodable reply, or every target failing / declining surfaces as a rejection
 * so the caller's retry/escalation policy (the subscription manager's backfill escalation, or
 * `manager.resume()`'s caller) takes over.
 *
 * Both seams take a **tail getter**, not a fixed tail or a topic id: the root group is derived from the tail's
 * routing key (a topic id cannot be inverted), and a subscription follows its collection's tail as the log
 * moves, so each request resolves the root group of the tail the subscription has followed most recently.
 */
export class Libp2pReactivityRecoverTransport {
	private readonly dialer: RecoverDialer;
	private readonly selfPeerId: string;
	private readonly cohortHintCache: StickyCohortHintCache;
	private readonly resolveCohort: (tailId: Uint8Array) => Promise<readonly string[]>;
	private readonly maxBytes: number;

	constructor(options: Libp2pReactivityRecoverTransportOptions) {
		this.dialer = options.dialer;
		this.selfPeerId = options.selfPeerId;
		this.cohortHintCache = options.cohortHintCache;
		this.resolveCohort = options.resolveCohort;
		this.maxBytes = options.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
	}

	/**
	 * The db-core {@link BackfillTransport} for a collection subscription — frames + dials a signed
	 * {@link BackfillV1}. `tail` is read per request: the routing-key bytes of the tail the subscription
	 * currently follows, whose root group is the fallback target.
	 */
	backfillTransport(tail: () => Uint8Array, collectionId: string): BackfillTransport {
		return async (req: BackfillV1): Promise<BackfillReplyV1> => {
			const frame = encodeRecoverRequestV1({ v: 1, kind: "backfill", backfill: req }, this.maxBytes);
			const reply = await this.exchange("backfill", frame, tail(), collectionId);
			if (reply.backfillReply === undefined) {
				throw new Error("reactivity recover: backfill reply missing its body");
			}
			return reply.backfillReply;
		};
	}

	/** The {@link ResumeTransport} for a collection subscription — frames + dials a signed {@link ResumeV1}; `tail` as for {@link backfillTransport}. */
	resumeTransport(tail: () => Uint8Array, collectionId: string): ResumeTransport {
		return async (req: ResumeV1) => {
			const frame = encodeRecoverRequestV1({ v: 1, kind: "resume", resume: req }, this.maxBytes);
			const reply = await this.exchange("resume", frame, tail(), collectionId);
			if (reply.resumeReply === undefined) {
				throw new Error("reactivity recover: resume reply missing its body");
			}
			return reply.resumeReply;
		};
	}

	/**
	 * Exchange one recover frame with the first target that answers: sticky primary, then each root-group
	 * member. A **dial failure** and a **declined** request (the member had no result — no served state, a
	 * failed signature / replay check, an undecodable request) both fall through to the next candidate. A
	 * reply frame is **terminal** (the member answered for the cohort): a `kind: "rotated"` redirect throws
	 * {@link RotationRedirectError}, and a reply that fails to decode or decodes to the wrong `kind` is a
	 * protocol error. When no candidate answers, throws the last candidate's outcome — a
	 * {@link NoResultReplyError} if it declined, its dial error if it failed to dial.
	 */
	private async exchange(kind: RecoverKind, frame: Uint8Array, tailId: Uint8Array, collectionId: string): Promise<RecoverReplyV1> {
		const targets = await this.selectTargets(tailId, collectionId);
		if (targets.length === 0) {
			throw new Error("reactivity recover: no serving cohort target resolved");
		}
		let lastErr: unknown;
		for (const target of targets) {
			let replyFrame: Uint8Array | undefined;
			try {
				replyFrame = await this.dialer.exchange(target, frame);
			} catch (err) {
				lastErr = err; // dial failure → fall back to the next candidate (sticky → walk)
				log("recover dial to %s failed, trying next target: %o", target, err);
				continue;
			}
			if (replyFrame === undefined) {
				// Declined → fall back to the next candidate, resending the same signed frame.
				// NOTE: the resend is admissible only because each node's `CorrelationReplayGuard` is node-local
				// (`RecoverServeDeps.replayGuard`). If the guard is ever shared across a cohort, the retried frame
				// would be rejected everywhere as a replay, and each fallthrough would need a freshly signed request.
				lastErr = new NoResultReplyError(`reactivity recover ${kind} from ${target}`);
				log("recover %s declined by %s, trying next target", kind, target);
				continue;
			}
			const reply = decodeRecoverReplyV1(replyFrame, this.maxBytes); // a decode failure here is terminal
			// A rotated cohort answered authoritatively: surface the redirect and stop the walk (terminal, never
			// a fallthrough — the dialed member spoke for the cohort).
			if (reply.kind === "rotated") {
				throw new RotationRedirectError(reply.rotated!);
			}
			if (reply.kind !== kind) {
				throw new Error(`reactivity recover: reply kind "${reply.kind}" does not match request kind "${kind}"`);
			}
			return reply;
		}
		throw lastErr ?? new Error("reactivity recover: all targets failed");
	}

	/**
	 * Ordered dial candidates for a recover: the sticky primary (decoded from its base64url-of-bytes form)
	 * first, then the tail's root-group members. Self is never dialed (a co-located serve is the node
	 * wiring's concern), and duplicates collapse.
	 */
	private async selectTargets(tailId: Uint8Array, collectionId: string): Promise<string[]> {
		const seen = new Set<string>();
		const targets: string[] = [];
		const add = (target: string | undefined): void => {
			if (target === undefined || target === this.selfPeerId || seen.has(target)) {
				return;
			}
			seen.add(target);
			targets.push(target);
		};
		const hint = this.cohortHintCache.get(collectionId);
		if (hint?.primary !== undefined) {
			try {
				add(decodeCohortHintTarget(hint.primary));
			} catch (err) {
				log("recover: malformed sticky primary for %s, skipping to cohort-walk: %o", collectionId, err);
			}
		}
		for (const member of await this.resolveCohort(tailId)) {
			add(member);
		}
		return targets;
	}
}

// --- inbound serve handler ---

/** Live `PushState` resolvers + replay guard the recover serve handler dispatches against. */
export interface RecoverServeDeps {
	/**
	 * Resolve the `PushState` this node serves for the root at the tail whose bytes are `tail`
	 * (`reactivityTailBytes(tail)`) — resume's stale-tail lookup.
	 */
	readonly pushStateForRoot: (tail: Uint8Array) => PushState | undefined;
	/** Resolve the served `PushState` for a collection id — the current tail (backfill, and rotated resume). */
	readonly pushStateForCollection: (collectionId: string) => PushState | undefined;
	/** Node-level freshness + anti-replay gate keyed on the request signature bytes. */
	readonly replayGuard: CorrelationReplayGuard;
	/**
	 * The drain-window redirect for a request that reached an **outgoing (rotated)** root still in its drain
	 * window, or `undefined` if the resolved root never rotated / has drained. The node wiring binds this to
	 * `ReactivityForwarderHost.rotationRedirectFor`, resolving the old root from the request: a **resume**
	 * carries it as `tailId` (the bytes of its `latestKnownTailId`); for a **backfill** (no `tailId`) the binding
	 * resolves the collection's current served root. When it returns a redirect the serve replies
	 * `kind: "rotated"` instead of serving data, moving the subscriber to the new root. Absent ⇒ never redirect.
	 */
	readonly rotationFor?: (req: { tailId?: Uint8Array; collectionId: string }, now: number) => RotationRedirectV1 | undefined;
	/** Unix-ms clock for the replay-guard window. Default `Date.now`. */
	readonly clock?: () => number;
	/** Per-frame decode ceiling; default {@link DEFAULT_STREAM_MAX_BYTES}. */
	readonly maxBytes?: number;
}

/**
 * Verify the request's peer-key signature against the dialing peer, then admit it through the freshness +
 * anti-replay guard. The dialing peer's id **is** the signer (no signer-id field on the wire); the signature
 * bytes are the anti-replay key (globally unique + authenticated). Returns `false` (decline) on a
 * bad signature, a stale/future timestamp, or a replay.
 */
function verifyAndAdmit(deps: RecoverServeDeps, signerId: string, payload: Uint8Array, signatureB64: string, timestamp: number, now: number): boolean {
	const signature = b64urlToBytes(signatureB64);
	if (!verifyPeerSig(signerId, payload, signature)) {
		log("recover serve: signature verification failed for %s (declined)", signerId);
		return false;
	}
	if (!deps.replayGuard.accept(signature, peerIdToBytes(signerId), timestamp, now)) {
		log("recover serve: replay/stale request from %s (declined)", signerId);
		return false;
	}
	return true;
}

/**
 * Serve a backfill from the collection's current served tail, or `undefined` if this node serves none. When
 * the node serves **only** the outgoing (draining) tail, `rotationFor` returns the drain redirect and the
 * reply is `kind: "rotated"` instead — a best-effort secondary path (the primary mechanism for an active
 * subscriber is notify-driven detection). Once both tails coexist `pushStateForCollection` resolves the new
 * tail, so the redirect is emitted only while the old tail is the sole served state (see §Tail rotation).
 */
function serveBackfillReply(deps: RecoverServeDeps, req: BackfillV1, now: number): Uint8Array | undefined {
	const maxBytes = deps.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
	const redirect = deps.rotationFor?.({ collectionId: req.collectionId }, now);
	if (redirect !== undefined) {
		return encodeRecoverReplyV1({ v: 1, kind: "rotated", rotated: redirect }, maxBytes);
	}
	const ps = deps.pushStateForCollection(req.collectionId);
	if (ps === undefined) {
		return undefined; // not a serving member for this collection → decline (the subscriber tries the next member)
	}
	const backfillReply = serveBackfill(ps.replayBuffer, req, ps.collectionId);
	return encodeRecoverReplyV1({ v: 1, kind: "backfill", backfillReply }, maxBytes);
}

/**
 * Serve a resume against the live `PushState`. A resume reaching the **outgoing (draining)** root — its
 * `latestKnownTailId` names a tail this node has marked rotated — is answered with the drain redirect
 * (`kind: "rotated"`), moving the subscriber to the new root. Otherwise prefer the root at the request's
 * `latestKnownTailId` (so a non-rotated subscriber classifies into backfill/checkpoint/out_of_window); if this
 * node no longer serves that root, fall back to the collection's current tail so the cohort can still answer
 * `tail_rotated` (its `currentTailId` differs from the request's stale tail) or, for a span that crosses a
 * rotation, serve from the new tail's `inheritedCheckpoint`. `undefined` ⇒ no served state.
 */
function serveResumeReply(deps: RecoverServeDeps, req: ResumeV1, now: number): Uint8Array | undefined {
	const maxBytes = deps.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
	const staleTail = b64urlToBytes(req.latestKnownTailId);
	const redirect = deps.rotationFor?.({ tailId: staleTail, collectionId: req.collectionId }, now);
	if (redirect !== undefined) {
		return encodeRecoverReplyV1({ v: 1, kind: "rotated", rotated: redirect }, maxBytes);
	}
	const ps = deps.pushStateForRoot(staleTail) ?? deps.pushStateForCollection(req.collectionId);
	if (ps === undefined) {
		return undefined;
	}
	const resumeReply = serveResume(req, {
		buffer: ps.replayBuffer,
		checkpoint: ps.checkpoint,
		inheritedCheckpoint: ps.inheritedCheckpoint,
		currentTailId: ps.tailIdAtJoin,
		currentRevision: ps.lastRevision,
		rotationRevision: ps.lastRevision,
		expectedCollectionId: ps.collectionId,
	});
	return encodeRecoverReplyV1({ v: 1, kind: "resume", resumeReply }, maxBytes);
}

/**
 * Build the recover serve callback for {@link handleRequestResponse}: it returns the reply frame, or
 * `undefined` on a decode/verify/replay/resolve failure. It never throws out of the handler.
 *
 * `undefined` reaches the dialer as a zero-length frame, which {@link requestResponse} resolves as no result
 * and {@link Libp2pReactivityRecoverTransport} treats as a decline — it tries the next cohort candidate.
 */
export function createRecoverRequestHandler(deps: RecoverServeDeps): (frame: Uint8Array, fromPeer: PeerId) => Promise<Uint8Array | undefined> {
	const maxBytes = deps.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
	const clock = deps.clock ?? ((): number => Date.now());
	return (frame: Uint8Array, fromPeer: PeerId): Promise<Uint8Array | undefined> => {
		try {
			const req = decodeRecoverRequestV1(frame, maxBytes);
			const signerId = fromPeer.toString();
			const now = clock();
			if (req.kind === "backfill") {
				const b = req.backfill;
				if (b === undefined || !verifyAndAdmit(deps, signerId, backfillSigningPayload(b), b.signature, b.timestamp, now)) {
					return Promise.resolve(undefined);
				}
				return Promise.resolve(serveBackfillReply(deps, b, now));
			}
			const r = req.resume;
			if (r === undefined || !verifyAndAdmit(deps, signerId, resumeSigningPayload(r), r.signature, r.timestamp, now)) {
				return Promise.resolve(undefined);
			}
			return Promise.resolve(serveResumeReply(deps, r, now));
		} catch (err) {
			// A malformed/foreign request (decode failure, foreign collectionId from serve*) must never throw
			// out of the stream handler: log + decline (a zero-length reply; the dialer tries the next member).
			log("recover serve: dropping request (declined): %o", err);
			return Promise.resolve(undefined);
		}
	};
}

/** Register the inbound recover protocol handler on `node` (request-reply over the recover protocol). */
export function registerRecoverHandler(node: Libp2p, protocol: string, deps: RecoverServeDeps): void {
	const maxBytes = deps.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
	handleRequestResponse(node, protocol, createRecoverRequestHandler(deps), maxBytes);
}
