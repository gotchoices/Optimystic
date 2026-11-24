/**
 * The blob protocol's id, wire types, header codec and errors (docs/blobs.md §Moving pieces between
 * machines).
 *
 * A blob stream carries several length-prefixed frames (`readBlobFrames` and `sendBlobFrame` in
 * `blob-frames.ts`): one header frame in each direction, UTF-8 JSON, and after a `get` answer one frame
 * of raw piece bytes per held piece. The frame sequence of each request:
 *
 * - `stat`: requester → `[header]`, closes its write side. Responder → `[{kind:'stat', holdings}]`, closes.
 * - `get`: requester → `[header]`, closes its write side. Responder → `[{kind:'get', held}]`, then exactly
 *   one piece frame for each `held[i] === true`, in request order, then closes.
 * - `announce` / `held`: requester → `[header]`; responder → `[header]`, closes.
 * - A request the responder will not serve: responder → `[{kind:'refused', reason}]`, closes. `busy` =
 *   over its allowance; `malformed` = the request broke a rule {@link decodeBlobRequest} checks.
 *
 * Imports here are pure: this module is reachable from the react-native entry (`src/rn.ts`).
 */

import { parseBlobRef, parsePieceId, type BlobRef, type BlobScope, type PieceId } from '@optimystic/db-core';
import { fromString as u8FromString } from 'uint8arrays/from-string';
import { toString as u8ToString } from 'uint8arrays/to-string';
import { MAX_BLOB_GET_PIECES, MAX_BLOB_SCOPE_CHARS, MAX_BLOB_STAT_REFS } from '../protocol-limits.js';

const BLOB_PROTOCOL_PATH = '/db-p2p/blob/';
const BLOB_PROTOCOL_VERSION = '1.0.0';

/** `${prefix}/db-p2p/blob/1.0.0`, the same shape as `buildBlockTransferProtocol`. */
export const buildBlobProtocol = (protocolPrefix: string = ''): string =>
	`${protocolPrefix}${BLOB_PROTOCOL_PATH}${BLOB_PROTOCOL_VERSION}`;

/**
 * First and only frame the requester sends. `announce` and `held` serve copying a referenced blob to
 * its cohort (docs/blobs.md §Placement, copying and durability).
 */
export type BlobRequest =
	/** 1..MAX_BLOB_STAT_REFS canonical references. */
	| { kind: 'stat'; refs: BlobRef[] }
	/** 1..MAX_BLOB_GET_PIECES canonical piece ids, no duplicates. */
	| { kind: 'get'; pieces: PieceId[] }
	/** `scope`: 1..MAX_BLOB_SCOPE_CHARS characters. */
	| { kind: 'announce'; ref: BlobRef; scope: BlobScope }
	| { kind: 'held'; ref: BlobRef };

/** What the responder holds of one blob: all of it, some of its pieces, or none. */
export type BlobLocalHolding = 'whole' | 'partial' | 'none';
/**
 * What a node answers an announcement with. `declined` is a CONFIGURATION — an `on-demand` node will
 * never hold the blob — while `out-of-space` is a CONDITION that clears, which is why the two are read
 * differently by every announcer (`SATISFYING_ANSWERS` in `blob/cohort-reaction.ts`).
 */
export type BlobAnnounceAnswer = 'whole' | 'fetching' | 'declined' | 'out-of-space' | 'not-responsible' | 'unreferenced';
export type BlobRefusalReason = 'busy' | 'malformed';

/** First frame the responder sends. */
export type BlobAnswer =
	/** Positional: `holdings[i]` answers `refs[i]`. */
	| { kind: 'stat'; holdings: BlobLocalHolding[] }
	/** Positional: `held[i]` answers `pieces[i]`. */
	| { kind: 'get'; held: boolean[] }
	| { kind: 'announce'; answer: BlobAnnounceAnswer }
	| { kind: 'held' }
	| { kind: 'refused'; reason: BlobRefusalReason };

export const BLOB_TRANSFER_STALLED_CODE = 'BLOB_TRANSFER_STALLED';

/** No bytes moved on a blob stream for `ms`. Thrown by both ends. `.code === BLOB_TRANSFER_STALLED_CODE`. */
export class BlobTransferStalledError extends Error {
	readonly code = BLOB_TRANSFER_STALLED_CODE;
	constructor(readonly peer: string, readonly ms: number) {
		super(`blob transfer stalled: peer=${peer} moved no bytes for ${ms}ms`);
		this.name = 'BlobTransferStalledError';
	}
}

/**
 * The responder answered `refused` to one request. Not `BlobPeerRefusesError` (`accepts-blobs.ts`),
 * one letter away, which is raised without asking, for a peer whose protocol list lacks this protocol.
 */
export class BlobPeerRefusedError extends Error {
	constructor(readonly peer: string, readonly reason: BlobRefusalReason) {
		super(`blob request refused: peer=${peer} reason=${reason}`);
		this.name = 'BlobPeerRefusedError';
	}
}

/**
 * The other end broke the frame sequence: a bad header, the wrong kind, a frame over its cap, too many
 * or too few piece frames.
 *
 * Deliberately not a `RangeError`: `it-length-prefixed`'s decoder treats a `RangeError` thrown while it
 * reads a length prefix — the `onLength` call `readBlobFrames` refuses an oversized frame from
 * included — as "the prefix is not complete yet" and waits for more bytes, so the frame would be read anyway.
 */
export class BlobProtocolError extends Error {
	constructor(readonly peer: string, readonly detail: string, options?: { cause?: unknown }) {
		super(`blob protocol error: peer=${peer} ${detail}`, options);
		this.name = 'BlobProtocolError';
	}
}

/** The bytes of one header frame. */
export function encodeBlobHeader(value: BlobRequest | BlobAnswer): Uint8Array {
	return u8FromString(JSON.stringify(value));
}

/** The request a header frame carries, checked field by field; throws {@link BlobProtocolError}. */
export function decodeBlobRequest(bytes: Uint8Array, peer: string): BlobRequest {
	const header = parseHeader(bytes, peer);
	switch (header.kind) {
		case 'stat': return { kind: 'stat', refs: statRefs(header, peer) };
		case 'get': return { kind: 'get', pieces: getPieces(header, peer) };
		case 'announce': return { kind: 'announce', ref: refField(header, 'ref', peer), scope: scopeField(header, peer) };
		case 'held': return { kind: 'held', ref: refField(header, 'ref', peer) };
		default: throw new BlobProtocolError(peer, `request of unknown kind '${header.kind}'`);
	}
}

/** The answer a header frame carries, checked field by field; throws {@link BlobProtocolError}. */
export function decodeBlobAnswer(bytes: Uint8Array, peer: string): BlobAnswer {
	const header = parseHeader(bytes, peer);
	switch (header.kind) {
		case 'stat': return { kind: 'stat', holdings: statHoldings(header, peer) };
		case 'get': return { kind: 'get', held: getHeld(header, peer) };
		case 'announce': return { kind: 'announce', answer: literalField(header, 'answer', ANNOUNCE_ANSWERS, peer) };
		case 'held': return { kind: 'held' };
		case 'refused': return { kind: 'refused', reason: literalField(header, 'reason', REFUSAL_REASONS, peer) };
		default: throw new BlobProtocolError(peer, `answer of unknown kind '${header.kind}'`);
	}
}

/**
 * The client-side rule that an answer fits the request it answers: the same kind (or `refused`), and a
 * positional answer as long as the list it answers. Throws {@link BlobProtocolError}.
 */
export function checkAnswerFits(request: BlobRequest, answer: BlobAnswer, peer: string): void {
	if (answer.kind === 'refused') return;
	if (answer.kind !== request.kind) {
		throw new BlobProtocolError(peer, `answered '${answer.kind}' to a '${request.kind}' request`);
	}
	if (request.kind === 'stat' && answer.kind === 'stat') {
		requireAnswerLength('holdings', answer.holdings.length, request.refs.length, peer);
	} else if (request.kind === 'get' && answer.kind === 'get') {
		requireAnswerLength('held', answer.held.length, request.pieces.length, peer);
	}
}

const HOLDINGS: readonly BlobLocalHolding[] = ['whole', 'partial', 'none'];
// A value added to BlobAnnounceAnswer and NOT added here is not a type error, and the symptom is on
// the reading side: this list is what `decodeBlobAnswer` checks, so an answer missing from it reads as
// a protocol break and resets the stream. Adding it is therefore not optional.
// NOTE: the converse is a version skew nothing here can fix — a peer on a build whose list lacks
// `out-of-space` reads that answer as a break and treats the announcement as unreachable, i.e. asks
// again later, which is the same thing it does with a dropped stream. Only a receiver on a NEW build
// sends it, so no old-to-old exchange is affected.
const ANNOUNCE_ANSWERS: readonly BlobAnnounceAnswer[] = ['whole', 'fetching', 'declined', 'out-of-space', 'not-responsible', 'unreferenced'];
const REFUSAL_REASONS: readonly BlobRefusalReason[] = ['busy', 'malformed'];

/** A decoded header: its kind, and every field it carried. Fields the kind does not name are ignored. */
type Header = { readonly kind: string; readonly fields: Readonly<Record<string, unknown>> };

function parseHeader(bytes: Uint8Array, peer: string): Header {
	let value: unknown;
	try {
		value = JSON.parse(u8ToString(bytes));
	} catch (err) {
		throw new BlobProtocolError(peer, 'header is not JSON', { cause: err });
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new BlobProtocolError(peer, 'header is not a JSON object');
	}
	const fields = value as Readonly<Record<string, unknown>>;
	if (typeof fields.kind !== 'string') {
		throw new BlobProtocolError(peer, 'header has no kind');
	}
	return { kind: fields.kind, fields };
}

function statRefs(header: Header, peer: string): BlobRef[] {
	const refs = listField(header, 'refs', MAX_BLOB_STAT_REFS, peer);
	return refs.map(ref => canonical(parseBlobRef, ref, 'refs', peer));
}

function getPieces(header: Header, peer: string): PieceId[] {
	const pieces = listField(header, 'pieces', MAX_BLOB_GET_PIECES, peer).map(id => canonical(parsePieceId, id, 'pieces', peer));
	if (new Set(pieces).size !== pieces.length) {
		throw new BlobProtocolError(peer, `'get' names a piece more than once`);
	}
	return pieces;
}

function statHoldings(header: Header, peer: string): BlobLocalHolding[] {
	return listField(header, 'holdings', MAX_BLOB_STAT_REFS, peer).map(holding => {
		if (!isOneOf(holding, HOLDINGS)) throw new BlobProtocolError(peer, `'holdings' holds ${describe(holding)}`);
		return holding;
	});
}

function getHeld(header: Header, peer: string): boolean[] {
	return listField(header, 'held', MAX_BLOB_GET_PIECES, peer).map(held => {
		if (typeof held !== 'boolean') throw new BlobProtocolError(peer, `'held' holds ${describe(held)}`);
		return held;
	});
}

/** A non-empty array of at most `cap` elements. */
function listField(header: Header, name: string, cap: number, peer: string): readonly unknown[] {
	const value = header.fields[name];
	if (!Array.isArray(value)) throw new BlobProtocolError(peer, `'${header.kind}' has no '${name}' list`);
	if (value.length === 0) throw new BlobProtocolError(peer, `'${header.kind}' has an empty '${name}' list`);
	if (value.length > cap) throw new BlobProtocolError(peer, `'${header.kind}' names ${value.length} '${name}', over the cap of ${cap}`);
	return value;
}

function refField(header: Header, name: string, peer: string): BlobRef {
	return canonical(parseBlobRef, header.fields[name], name, peer);
}

function scopeField(header: Header, peer: string): BlobScope {
	const scope = header.fields.scope;
	if (typeof scope !== 'string') throw new BlobProtocolError(peer, `'${header.kind}' has no 'scope' string`);
	const problem = blobScopeProblem(scope);
	if (problem !== undefined) throw new BlobProtocolError(peer, `'${header.kind}' has ${problem}`);
	return scope;
}

/** Why `scope` cannot be announced, or `undefined`: the rule both ends apply, so the client refuses locally what the responder would call malformed. */
export function blobScopeProblem(scope: BlobScope): string | undefined {
	if (scope.length === 0) return 'an empty scope';
	if (scope.length > MAX_BLOB_SCOPE_CHARS) return `a scope of ${scope.length} characters, over the cap of ${MAX_BLOB_SCOPE_CHARS}`;
	return undefined;
}

/**
 * Refuses a scope no announce may carry, with the one message every announce path gives: the wire
 * client, and each `BlobService.announce` that records a scope before it would be sent. One function
 * so a further announce path cannot come to spell the rule, or its refusal, differently.
 *
 * @throws RangeError for an empty scope or one over `MAX_BLOB_SCOPE_CHARS`.
 */
export function assertAnnounceScope(scope: BlobScope): void {
	const problem = blobScopeProblem(scope);
	if (problem !== undefined) throw new RangeError(`A blob announce has ${problem}`);
}

function literalField<T extends string>(header: Header, name: string, allowed: readonly T[], peer: string): T {
	const value = header.fields[name];
	if (!isOneOf(value, allowed)) throw new BlobProtocolError(peer, `'${header.kind}' has '${name}' ${describe(value)}`);
	return value;
}

/** A reference or piece id in its one canonical spelling, through db-core's parser for it. */
function canonical<T extends string>(parse: (text: string) => T, value: unknown, name: string, peer: string): T {
	if (typeof value !== 'string') throw new BlobProtocolError(peer, `'${name}' holds ${describe(value)}`);
	try {
		return parse(value);
	} catch (err) {
		throw new BlobProtocolError(peer, `'${name}' holds a value that is not a canonical piece CID`, { cause: err });
	}
}

function requireAnswerLength(name: string, actual: number, expected: number, peer: string): void {
	if (actual !== expected) {
		throw new BlobProtocolError(peer, `'${name}' answers ${actual} entries to a request naming ${expected}`);
	}
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
	return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/** A short description of an unexpected JSON value, for an error's detail; never the whole value. */
function describe(value: unknown): string {
	if (typeof value === 'string') return `'${value.length > 40 ? `${value.slice(0, 40)}…` : value}'`;
	if (value === null || typeof value !== 'object') return String(value);
	return Array.isArray(value) ? 'an array' : 'an object';
}
