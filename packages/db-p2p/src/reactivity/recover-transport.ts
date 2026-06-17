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
 *    first for the one-RT happy path, else a cohort-walk member), frame the request, exchange it over the
 *    recover protocol, and return the inner reply. The wire exchange is injected as a {@link RecoverDialer}
 *    so the target-selection + framing logic tests without a real socket; {@link createLibp2pRecoverDialer}
 *    is the production libp2p-backed implementation.
 *  - {@link createRecoverRequestHandler} / {@link registerRecoverHandler} — the **inbound** serve handler.
 *    Decode (bounded) → verify the request's peer-key signature against the dialing peer → reject a
 *    replay/stale request → resolve the live `PushState` → `serveBackfill` / `serveResume` → reply. Any
 *    failure produces **no reply** (the stream aborts) rather than throwing out of the handler.
 *
 * ## Dial-target encoding bridge (load-bearing)
 *
 * The sticky {@link import("@optimystic/db-core").ReactivityCohortHint}`.primary` is **base64url of
 * cohort member-id bytes** (`base64url(utf8(peerIdString))`), per its db-core JSDoc, whereas
 * {@link requestResponse} needs a `peerIdFromString`-parseable peer-id **string**. Feeding the raw
 * base64url straight to `peerIdFromString` throws → the dial is swallowed → recovery silently never
 * reaches the cohort. {@link decodeCohortHintTarget} pins the conversion
 * (`bytesToPeerIdString(b64urlToBytes(primary))`); the `resolveCohort` walk, by contrast, already returns
 * peer-id strings (the cohort-topic `CohortPeerResolver` space) and is used as-is.
 */

import type { Libp2p } from "libp2p";
import type { PeerId } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import {
	b64urlToBytes,
	reactivityTopicId,
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
	type ResumeV1,
	type RecoverKind,
	type RecoverReplyV1,
	type BackfillTransport,
	type PushState,
	type StickyCohortHintCache,
	type CorrelationReplayGuard,
} from "@optimystic/db-core";
import { requestResponse, handleRequestResponse, DEFAULT_STREAM_MAX_BYTES } from "../cohort-topic/stream-util.js";
import { verifyPeerSig } from "../cohort-topic/peer-sig.js";
import { peerIdToBytes, bytesToPeerIdString } from "../cohort-topic/peer-codec.js";
import { PROTOCOL_REACTIVITY_RECOVER } from "./protocols.js";
import type { ResumeTransport } from "./subscription-manager.js";
import { createLogger } from "../logger.js";

const log = createLogger("reactivity-recover");

/**
 * Decode a sticky-cohort-hint `primary` (base64url of member-id bytes = `base64url(utf8(peerIdString))`)
 * back to the dialable peer-id string. The inverse trap of feeding the raw value to `peerIdFromString`
 * (which expects a peer-id string, not base64url-of-its-utf8) — pinned by the dial-target encoding test.
 */
export function decodeCohortHintTarget(primary: string): string {
	return bytesToPeerIdString(b64urlToBytes(primary));
}

// --- outbound transport ---

/** The wire exchange seam: open the recover protocol to `target`, send `frame`, return the bounded reply. */
export interface RecoverDialer {
	/** Exchange one request frame for one reply frame with `target` (peer-id string). Rejects on a dial failure. */
	exchange(target: string, frame: Uint8Array): Promise<Uint8Array>;
}

/** Build the production libp2p-backed {@link RecoverDialer} over {@link requestResponse}. */
export function createLibp2pRecoverDialer(node: Libp2p, recoverProtocol: string = PROTOCOL_REACTIVITY_RECOVER, maxBytes: number = DEFAULT_STREAM_MAX_BYTES): RecoverDialer {
	return {
		exchange: (target, frame) => requestResponse(node, peerIdFromString(target), recoverProtocol, frame, maxBytes),
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
	/** FRET cohort-walk fallback: a topic id → dialable cohort member peer-id strings. */
	readonly resolveCohort: (topicId: Uint8Array) => string[];
	/** Per-frame ceiling for encode/decode; default {@link DEFAULT_STREAM_MAX_BYTES}. */
	readonly maxBytes?: number;
}

/**
 * The outbound recover transport: one instance per node, exposing the two db-core function seams against it.
 * Each returned transport dials the **sticky primary first** (one round trip after a brief flap), falling
 * back to a **cohort-walk** member on a dial failure (any member that holds the topic's gossiped `PushState`
 * can answer). A kind mismatch or all-targets-failed surfaces as a rejection so the caller's retry/escalation
 * policy (the subscription manager's backfill escalation, or `manager.resume()`'s caller) takes over.
 */
export class Libp2pReactivityRecoverTransport {
	private readonly dialer: RecoverDialer;
	private readonly selfPeerId: string;
	private readonly cohortHintCache: StickyCohortHintCache;
	private readonly resolveCohort: (topicId: Uint8Array) => string[];
	private readonly maxBytes: number;

	constructor(options: Libp2pReactivityRecoverTransportOptions) {
		this.dialer = options.dialer;
		this.selfPeerId = options.selfPeerId;
		this.cohortHintCache = options.cohortHintCache;
		this.resolveCohort = options.resolveCohort;
		this.maxBytes = options.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
	}

	/** The db-core {@link BackfillTransport} for `(topicId, collectionId)` — frames + dials a signed {@link BackfillV1}. */
	backfillTransport(topicId: Uint8Array, collectionId: string): BackfillTransport {
		return async (req: BackfillV1): Promise<BackfillReplyV1> => {
			const frame = encodeRecoverRequestV1({ v: 1, kind: "backfill", backfill: req }, this.maxBytes);
			const reply = await this.exchange("backfill", frame, topicId, collectionId);
			if (reply.backfillReply === undefined) {
				throw new Error("reactivity recover: backfill reply missing its body");
			}
			return reply.backfillReply;
		};
	}

	/** The {@link ResumeTransport} for `(topicId, collectionId)` — frames + dials a signed {@link ResumeV1}. */
	resumeTransport(topicId: Uint8Array, collectionId: string): ResumeTransport {
		return async (req: ResumeV1) => {
			const frame = encodeRecoverRequestV1({ v: 1, kind: "resume", resume: req }, this.maxBytes);
			const reply = await this.exchange("resume", frame, topicId, collectionId);
			if (reply.resumeReply === undefined) {
				throw new Error("reactivity recover: resume reply missing its body");
			}
			return reply.resumeReply;
		};
	}

	/**
	 * Exchange one recover frame with the first reachable target: sticky primary, then each cohort-walk
	 * member. A **dial failure** falls through to the next candidate; a successful dial that decodes to the
	 * wrong `kind` is terminal (a protocol error, never retried). Throws when no candidate succeeds.
	 */
	private async exchange(kind: RecoverKind, frame: Uint8Array, topicId: Uint8Array, collectionId: string): Promise<RecoverReplyV1> {
		const targets = this.selectTargets(topicId, collectionId);
		if (targets.length === 0) {
			throw new Error("reactivity recover: no serving cohort target resolved");
		}
		let lastErr: unknown;
		for (const target of targets) {
			let replyFrame: Uint8Array;
			try {
				replyFrame = await this.dialer.exchange(target, frame);
			} catch (err) {
				lastErr = err; // dial failure → fall back to the next candidate (sticky → walk)
				log("recover dial to %s failed, trying next target: %o", target, err);
				continue;
			}
			const reply = decodeRecoverReplyV1(replyFrame, this.maxBytes); // a decode failure here is terminal
			if (reply.kind !== kind) {
				throw new Error(`reactivity recover: reply kind "${reply.kind}" does not match request kind "${kind}"`);
			}
			return reply;
		}
		throw lastErr ?? new Error("reactivity recover: all targets failed");
	}

	/**
	 * Ordered dial candidates for a recover: the sticky primary (decoded from its base64url-of-bytes form)
	 * first, then the cohort-walk members. Self is never dialed (a co-located serve is the node wiring's
	 * concern), and duplicates collapse.
	 */
	private selectTargets(topicId: Uint8Array, collectionId: string): string[] {
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
		for (const member of this.resolveCohort(topicId)) {
			add(member);
		}
		return targets;
	}
}

// --- inbound serve handler ---

/** Live `PushState` resolvers + replay guard the recover serve handler dispatches against. */
export interface RecoverServeDeps {
	/** Resolve the served `PushState` for an exact reactivity topic id (resume's stale-tail lookup). */
	readonly pushStateFor: (topicId: Uint8Array) => PushState | undefined;
	/** Resolve the served `PushState` for a collection id — the current tail (backfill, and rotated resume). */
	readonly pushStateForCollection: (collectionId: string) => PushState | undefined;
	/** Node-level freshness + anti-replay gate keyed on the request signature bytes. */
	readonly replayGuard: CorrelationReplayGuard;
	/** Unix-ms clock for the replay-guard window. Default `Date.now`. */
	readonly clock?: () => number;
	/** Per-frame decode ceiling; default {@link DEFAULT_STREAM_MAX_BYTES}. */
	readonly maxBytes?: number;
}

/**
 * Verify the request's peer-key signature against the dialing peer, then admit it through the freshness +
 * anti-replay guard. The dialing peer's id **is** the signer (no signer-id field on the wire); the signature
 * bytes are the anti-replay key (globally unique + authenticated). Returns `false` (reject, no reply) on a
 * bad signature, a stale/future timestamp, or a replay.
 */
function verifyAndAdmit(deps: RecoverServeDeps, signerId: string, payload: Uint8Array, signatureB64: string, timestamp: number, now: number): boolean {
	const signature = b64urlToBytes(signatureB64);
	if (!verifyPeerSig(signerId, payload, signature)) {
		log("recover serve: signature verification failed for %s (no reply)", signerId);
		return false;
	}
	if (!deps.replayGuard.accept(signature, peerIdToBytes(signerId), timestamp, now)) {
		log("recover serve: replay/stale request from %s (no reply)", signerId);
		return false;
	}
	return true;
}

/** Serve a backfill from the collection's current served tail, or `undefined` if this node serves none. */
function serveBackfillReply(deps: RecoverServeDeps, req: BackfillV1): Uint8Array | undefined {
	const ps = deps.pushStateForCollection(req.collectionId);
	if (ps === undefined) {
		return undefined; // not a serving member for this collection → no reply (subscriber walks/chain-reads)
	}
	const backfillReply = serveBackfill(ps.replayBuffer, req, ps.collectionId);
	return encodeRecoverReplyV1({ v: 1, kind: "backfill", backfillReply }, deps.maxBytes ?? DEFAULT_STREAM_MAX_BYTES);
}

/**
 * Serve a resume against the live `PushState`: prefer the exact topic the request's `latestKnownTailId`
 * anchors (so a non-rotated subscriber classifies into backfill/checkpoint/out_of_window); if this node no
 * longer serves that tail's topic, fall back to the collection's current tail so the cohort can still answer
 * `tail_rotated` (its `currentTailId` differs from the request's stale tail). `undefined` ⇒ no served state.
 */
function serveResumeReply(deps: RecoverServeDeps, req: ResumeV1): Uint8Array | undefined {
	const ps = deps.pushStateFor(reactivityTopicId(b64urlToBytes(req.latestKnownTailId))) ?? deps.pushStateForCollection(req.collectionId);
	if (ps === undefined) {
		return undefined;
	}
	const resumeReply = serveResume(req, {
		buffer: ps.replayBuffer,
		checkpoint: ps.checkpoint,
		currentTailId: ps.tailIdAtJoin,
		currentRevision: ps.lastRevision,
		rotationRevision: ps.lastRevision,
		expectedCollectionId: ps.collectionId,
	});
	return encodeRecoverReplyV1({ v: 1, kind: "resume", resumeReply }, deps.maxBytes ?? DEFAULT_STREAM_MAX_BYTES);
}

/**
 * Build the recover serve callback for {@link handleRequestResponse}: it returns the reply frame, or
 * `undefined` for **no reply** (a decode/verify/replay/resolve failure aborts the stream). It never throws
 * out of the handler.
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
				return Promise.resolve(serveBackfillReply(deps, b));
			}
			const r = req.resume;
			if (r === undefined || !verifyAndAdmit(deps, signerId, resumeSigningPayload(r), r.signature, r.timestamp, now)) {
				return Promise.resolve(undefined);
			}
			return Promise.resolve(serveResumeReply(deps, r));
		} catch (err) {
			// A malformed/foreign request (decode failure, foreign collectionId from serve*) must never throw
			// out of the stream handler: log + no reply (the stream aborts, the subscriber falls back).
			log("recover serve: dropping request (no reply): %o", err);
			return Promise.resolve(undefined);
		}
	};
}

/** Register the inbound recover protocol handler on `node` (request-reply over the recover protocol). */
export function registerRecoverHandler(node: Libp2p, protocol: string, deps: RecoverServeDeps): void {
	const maxBytes = deps.maxBytes ?? DEFAULT_STREAM_MAX_BYTES;
	handleRequestResponse(node, protocol, createRecoverRequestHandler(deps), maxBytes);
}
