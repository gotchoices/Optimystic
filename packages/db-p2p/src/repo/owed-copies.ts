import type { BlockDurabilityReachedEvent, BlockId, CollectionId, IKeyNetwork } from '@optimystic/db-core';
import { routingKeyForBlock } from '@optimystic/db-core';
import type { IUnderReplicationLedger, SatisfyOutcome, UnderReplicatedEntry } from './i-under-replication-ledger.js';
import { createLogger } from '../logger.js';

/** The drain's namespace on purpose: everything that shrinks a ledger entry is read on one channel. */
const log = createLogger('under-replication-drain');

/**
 * The one method the drain may call on the node's storage repo: emit a full-replication event.
 * Handed in as a function, exactly as the cluster side receives a `CommitCertificateSink`, so the
 * drain has no way to reach anything else on the repo. `CoordinatorRepo` is handed the same
 * callable, for the entries a `full` commit settles — the event's other producer.
 */
export type BlockDurabilitySink = (event: BlockDurabilityReachedEvent) => void;

/** Who an entry still owes a copy to, or that it owes nobody because the node is alone. */
export type Owed =
	| { kind: 'solo' }
	| { kind: 'unresolved' }
	| { kind: 'peers'; peerIds: string[]; named: boolean };

/** What taking a confirmed copy off an entry writes through: the ledger, and the event it may owe. */
export interface ConfirmedCopyDeps {
	ledger: Pick<IUnderReplicationLedger, 'name' | 'satisfy'>;
	emit: BlockDurabilitySink;
}

/** What {@link recordHeldCopy} needs on top: the entry itself, and the cohort for an unnamed one. */
export interface HeldCopyDeps extends ConfirmedCopyDeps {
	ledger: Pick<IUnderReplicationLedger, 'get' | 'name' | 'satisfy'>;
	keyNetwork: Pick<IKeyNetwork, 'findCluster'>;
	/** This node's peer id, `PeerId.toString()`. */
	selfId: string;
}

/** What {@link recordHeldCopy} found and did: `not-owed` wrote nothing; the rest are as {@link SatisfyOutcome}. */
export type HeldCopyOutcome = 'not-owed' | SatisfyOutcome['status'];

/**
 * Who the entry still owes. Named members are taken as recorded. An unknown set re-resolves the
 * cohort NOW; a cohort of this node alone is `solo` — not a failure, not an attempt.
 */
export async function resolveOwedPeers(
	entry: UnderReplicatedEntry, selfId: string, keyNetwork: Pick<IKeyNetwork, 'findCluster'>
): Promise<Owed> {
	if (entry.missingPeerIds.length > 0) {
		return { kind: 'peers', peerIds: entry.missingPeerIds.filter(peerId => peerId !== selfId), named: true };
	}
	let cluster: Awaited<ReturnType<IKeyNetwork['findCluster']>>;
	try {
		cluster = await keyNetwork.findCluster(routingKeyForBlock(entry.blockId));
	} catch (err) {
		log('cohort:unresolved block=%s err=%s', entry.blockId, err instanceof Error ? err.message : String(err));
		return { kind: 'unresolved' };
	}
	const members = Object.keys(cluster).filter(peerId => peerId !== selfId);
	return members.length === 0 ? { kind: 'solo' } : { kind: 'peers', peerIds: members, named: false };
}

/**
 * Take the confirmed peers off the entry. An entry that could not name its members is named now,
 * at its own revision, with the cohort resolved for this copy — so `satisfy` has a set to shrink.
 * Both writes carry the revision guard: a newer shortfall recorded while the copy was in flight
 * is left alone (`name` touches only its own revision; `satisfy` keeps a higher one), and neither
 * recreates an entry a concurrent `settle` removed meanwhile.
 *
 * When THIS call removed the entry (`cleared`), the full-replication event fires — after the
 * deletion, never before, so a listener that re-reads the ledger sees it gone — naming the entry
 * `satisfy` removed, not `entry`: a newer shortfall recorded while the copy was in flight and
 * satisfied by a copy of that newer revision is the one cleared, and a host following the newer
 * write waits for its revision. An entry settled meanwhile by a `full` commit is reported `absent`
 * and fires nothing: the commit that settled it announced it.
 *
 * @returns `cleared` when this call removed the entry (its last missing member confirmed), `absent`
 * when it was already gone, `owed` when it still stands.
 */
export async function takeConfirmedCopies(
	deps: ConfirmedCopyDeps,
	entry: UnderReplicatedEntry,
	owed: Owed & { kind: 'peers' },
	confirmed: readonly string[],
	heldRev: number,
	collectionId?: CollectionId
): Promise<SatisfyOutcome['status']> {
	if (!owed.named) {
		await deps.ledger.name(entry.blockId, entry.rev, owed.peerIds);
	}
	const outcome = await deps.ledger.satisfy(entry.blockId, confirmed, heldRev);
	if (outcome.status === 'cleared') {
		const removed = outcome.entry;
		deps.emit({ blockIds: [removed.blockId], rev: removed.rev, actionId: removed.actionId, collectionId });
	}
	return outcome.status;
}

/**
 * Refuse a reported revision that is not one: every revision comparison is false against `NaN`, so
 * a `NaN` would pass the older-copy check and `satisfy`'s guard alike and clear any entry.
 */
export function assertReportedRevision(rev: number): void {
	if (!Number.isSafeInteger(rev) || rev < 0) {
		throw new RangeError(`reportBlockHeld: rev must be a non-negative integer, got ${rev}`);
	}
}

/**
 * The ledger half of `reportBlockHeld`: an embedder says `peerId` holds `blockId` at `rev` or later,
 * which counts exactly as this node's own confirmed push of that revision would — through
 * {@link takeConfirmedCopies}, so the two cannot drift on naming, the revision guard, or the event.
 *
 * Writes nothing unless the report covers a copy the entry owes: no entry → `absent`; the peer is
 * this node, or the entry does not owe it a copy → `not-owed`; the entry records a newer revision
 * than `rev` → `owed`, untouched. An unnamed entry is named only when `peerId` is in the block's
 * resolved cohort, because naming freezes the set the drain pushes to, and the report is evidence
 * about `peerId` alone. The event fired for an entry this clears carries no `collectionId`: nothing
 * here reads the block. `rev` is checked by {@link assertReportedRevision}.
 */
export async function recordHeldCopy(deps: HeldCopyDeps, blockId: BlockId, rev: number, peerId: string): Promise<HeldCopyOutcome> {
	assertReportedRevision(rev);
	if (peerId === deps.selfId) return 'not-owed';
	const entry = await deps.ledger.get(blockId);
	if (!entry) return 'absent';
	// `satisfy`'s own revision rule, applied before anything is written, so a copy that cannot satisfy
	// the entry does not name it either: an unnamed entry stays unnamed, for the drain to resolve.
	if (rev < entry.rev) {
		log('report:older-copy block=%s peer=%s rev=%d entryRev=%d', blockId, peerId, rev, entry.rev);
		return 'owed';
	}
	const owed = await resolveOwedPeers(entry, deps.selfId, deps.keyNetwork);
	if (owed.kind !== 'peers' || !owed.peerIds.includes(peerId)) {
		log('report:not-owed block=%s peer=%s rev=%d owed=%s', blockId, peerId, rev, owed.kind);
		return 'not-owed';
	}
	const status = await takeConfirmedCopies(deps, entry, owed, [peerId], rev);
	if (status === 'cleared') {
		log('report:cleared block=%s peer=%s rev=%d action=%s', blockId, peerId, entry.rev, entry.actionId);
	} else if (status === 'owed') {
		log('report:satisfied block=%s peer=%s rev=%d', blockId, peerId, rev);
	} else {
		log('report:settled-elsewhere block=%s peer=%s rev=%d', blockId, peerId, rev);
	}
	return status;
}
