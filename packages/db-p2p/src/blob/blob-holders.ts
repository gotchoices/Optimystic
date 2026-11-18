/**
 * Which machines to ask for a blob's pieces, and what a round of asking that leaves a piece missing
 * means to the application (docs/blobs.md §Moving pieces between machines). Used by the blob fetcher;
 * nothing here dials a peer.
 *
 * Imports here are pure or type-only: this module is reachable from the react-native entry (`src/rn.ts`).
 */

import { peerIdFromString } from '@libp2p/peer-id';
import { routingKeyForBlob, type BlobRef, type BlobUnavailableReason } from '@optimystic/db-core';
import type { Libp2pKeyPeerNetwork } from '../libp2p-key-network.js';
import { createLogger } from '../logger.js';
import { admittedBy, type NetworkMembershipGate } from '../network-membership-gate.js';
import type { IPeerReputation } from '../reputation/types.js';

const log = createLogger('blob:fetch');

export interface BlobHolderDeps {
	readonly selfPeerId: string;
	/** `buildBlobProtocol(prefix)`. */
	readonly blobProtocol: string;
	readonly keyNetwork: Pick<Libp2pKeyPeerNetwork, 'findCluster' | 'peersServing'>;
	readonly membership: NetworkMembershipGate | undefined;
	readonly reputation: Pick<IPeerReputation, 'isBanned' | 'isDeprioritized'>;
	/** Whether this node has an open connection to the peer; the node binds it to libp2p's `getConnections`. */
	readonly isConnected: (peerId: string) => boolean;
}

/**
 * The peers to ask for `ref`'s pieces, best first: `knownHolders` in their order, then the blob's
 * cohort, connected members before the rest. Self, a malformed id, a peer the membership predicate
 * refuses, a banned peer and a peer whose record does not list the blob protocol are dropped;
 * deprioritized peers go last, keeping their order. A cohort lookup that throws is logged and read as
 * an empty cohort, so `knownHolders` still count.
 */
export async function blobHolderCandidates(deps: BlobHolderDeps, ref: BlobRef, knownHolders: readonly string[] = []): Promise<string[]> {
	const ordered = orderCandidates(knownHolders, await cohortOf(deps, ref), deps.isConnected);
	const eligible = withoutMalformed(ordered, ref).filter(peer => isEligible(deps, peer));
	const serving = new Set(await deps.keyNetwork.peersServing(deps.blobProtocol, eligible));
	const kept = eligible.filter(peer => serving.has(peer));
	return [
		...kept.filter(peer => !deps.reputation.isDeprioritized(peer)),
		...kept.filter(peer => deps.reputation.isDeprioritized(peer)),
	];
}

/** The members of the blob's cohort, or none when the lookup throws. */
async function cohortOf(deps: BlobHolderDeps, ref: BlobRef): Promise<string[]> {
	try {
		return Object.keys(await deps.keyNetwork.findCluster(routingKeyForBlob(ref)));
	} catch (error) {
		log('holders:cohort-lookup-failed ref=%s err=%s', ref, describe(error));
		return [];
	}
}

/** Each id once: the hints in their order, then the cohort members not hinted, connected ones first (stable within each group). */
function orderCandidates(knownHolders: readonly string[], cohort: readonly string[], isConnected: (peer: string) => boolean): string[] {
	const listed = new Set(knownHolders);
	const rest = cohort.filter(peer => !listed.has(peer));
	return [...listed, ...rest.filter(isConnected), ...rest.filter(peer => !isConnected(peer))];
}

// The fetcher dials only peers this returns, and `knownHolders` do not come from `findCluster` while
// `peersServing` deliberately applies no predicate, so this is the one place the membership predicate
// is applied to a peer the fetcher will dial.
function isEligible(deps: BlobHolderDeps, peer: string): boolean {
	return peer !== deps.selfPeerId && admittedBy(deps.membership, peer) && !deps.reputation.isBanned(peer);
}

/**
 * The ids `peerIdFromString` accepts, since the fetcher dials by parsed id and a caller's hint can be
 * anything; the rest are logged together, once per call.
 */
function withoutMalformed(peers: readonly string[], ref: BlobRef): string[] {
	const malformed = peers.filter(peer => !parses(peer));
	if (malformed.length > 0) {
		log('holders:bad-peer-id ref=%s peers=%o', ref, malformed);
	}
	return peers.filter(peer => !malformed.includes(peer));
}

function parses(peer: string): boolean {
	try {
		peerIdFromString(peer);
		return true;
	} catch {
		// `peerIdFromString` reports a malformed id only by throwing; the caller logs the refused ids.
		return false;
	}
}

/** How one candidate answered for one piece in a round. */
export type PieceAnswer = 'not-held' | 'no-answer' | 'corrupt';

export interface PieceOutcome {
	readonly peer: string;
	readonly answer: PieceAnswer;
}

export type UnavailableOutcome =
	| { readonly error: 'unavailable'; readonly reason: Exclude<BlobUnavailableReason, 'not-here'> }
	| { readonly error: 'corrupt' };

/**
 * What one unavailable piece's attempts in a round amount to, given one entry per candidate of the
 * round (empty when there was no candidate). Checked in order:
 *
 * | Attempts | Result |
 * |---|---|
 * | none, or every one `no-answer` | `cohort-unreachable`: nobody could be asked |
 * | some `corrupt`, every other `not-held` | `corrupt`: a holder served bad bytes and no other holder could supply them |
 * | some `no-answer`, the rest `not-held` or `corrupt` | `peers-unreachable`: a silent holder may still have it |
 * | every one `not-held` | `not-held` |
 *
 * `not-here` is never produced: it belongs to a read with `from: 'here'`.
 */
export function unavailableOutcome(attempts: readonly PieceOutcome[]): UnavailableOutcome {
	const silent = attempts.filter(attempt => attempt.answer === 'no-answer').length;
	if (silent === attempts.length) {
		return { error: 'unavailable', reason: 'cohort-unreachable' };
	}
	if (silent > 0) {
		return { error: 'unavailable', reason: 'peers-unreachable' };
	}
	if (attempts.some(attempt => attempt.answer === 'corrupt')) {
		return { error: 'corrupt' };
	}
	return { error: 'unavailable', reason: 'not-held' };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
