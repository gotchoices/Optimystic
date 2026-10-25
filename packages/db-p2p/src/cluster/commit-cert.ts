import type { ActionId, BlockId, ClusterRecord, CollectionChangeEvent, CommitCert, CommitRequest } from "@optimystic/db-core";
import { fromString as uint8ArrayFromString } from 'uint8arrays';
import { createLogger } from "../logger.js";

const log = createLogger('commit-cert');

/**
 * Build the {@link CommitCert} for a consensus-committed action from its {@link ClusterRecord}.
 *
 * The threshold signature is the cluster's `approve` **commit** signatures — the per-member Ed25519
 * commit votes the cohort already produced over the commit hash — concatenated in ascending
 * signer-id order, so the blob is reproducible and `signers[i]` aligns with chunk `i` (the
 * collected-multisig convention the cohort-topic verifier uses). This is the **authoritative**
 * commit cert: reactivity reuses these exact bytes as a notification's signature and never re-signs.
 *
 * `signedPayload` is the exact byte preimage every approving member signed — the cluster commit-vote
 * payload `utf8(commitHash + ":approve")`, identical across signers. The caller supplies it (this stays
 * pure and does **not** recompute the commit hash, since the canonical-JSON helper that derives it is
 * private to `ClusterMember` and duplicating it here risks drift). Reactivity sets a notification's
 * `digest` to base64url(signedPayload) so a subscriber's threshold-verify over `digest` reproduces the
 * exact signed image. Pure.
 */
export function buildCommitCert(record: ClusterRecord, minSigs: number, signedPayload: Uint8Array): CommitCert {
	const approvals = Object.entries(record.commits)
		.filter(([, sig]) => sig.type === 'approve')
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const signers = approvals.map(([peerId]) => peerId);
	const thresholdSig = concatBytes(approvals.map(([, sig]) => uint8ArrayFromString(sig.signature, 'base64url')));
	return { thresholdSig, signers, minSigs, signedPayload };
}

/**
 * The deterministic change-event/notification `actionId` for a durable invalidation, derived from the
 * `(invalidatedActionId, disputeId)` pair that uniquely identifies the reversal. An invalidation has no
 * transaction `actionId` of its own (it reverses one), but reactivity keys both the captured commit cert
 * and the emitted {@link CollectionChangeEvent} by an `actionId` so the bridge's cert extractor can
 * resolve the reused cert. Both the cluster member's cert capture and the invalidation-apply sink that
 * emits the change event derive this same id from the same pair, closing the loop. Distinct from the
 * per-block deterministic revert `actionId` in `dispute/invalidation.ts` (which also carries blockId+rev);
 * this is the single transaction-level id for the whole reversal.
 */
export function invalidationActionId(invalidatedActionId: ActionId, disputeId: string): ActionId {
	return `inv:${invalidatedActionId}:${disputeId}`;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

/** Default retention for a captured commit cert — long enough for the post-commit change event to
 * resolve it, short enough that the store stays bounded under sustained commit load. */
export const DEFAULT_COMMIT_CERT_TTL_MS = 60_000;

/** Default cap on retained certs — a backstop against unbounded growth if commits ever stop emitting. */
export const DEFAULT_COMMIT_CERT_MAX_ENTRIES = 4096;

/**
 * Bounded, TTL'd cache of recently-committed {@link CommitCert}s, one per **collection tail** a
 * consensus record committed. The cluster member records a cert here just before consensus applies the
 * commit to local storage; the change-notifier bridge's extractor reads it when the StorageRepo emits
 * the matching {@link CollectionChangeEvent}. Both happen on the same node within one commit, so the
 * window is tiny — but a TTL + cap keep the map from leaking if a commit ever lands without emitting a
 * change event (e.g. an idempotent re-commit, or a path with no catch-all subscriber).
 *
 * Keyed by `(actionId, tailId)`, not by action alone: one action can commit several collections as
 * separate records (a table and its indexes, when they cannot travel as one batch), each signed by its
 * own tail's cohort, and a member in both cohorts can apply them concurrently. Origination fires only
 * for an event naming a tail this node applied, so the tail names the record whose signatures the
 * notification needs.
 *
 * An entry with no tail is **action-wide**: an invalidation's cert, which reverses one collection by
 * construction but names no tail. {@link get} falls back to it only when no per-tail entry exists, and
 * commit records never write one, so the fallback cannot hand a commit event another collection's cert.
 */
export interface CommitCertStore {
	/**
	 * Record `cert` once per tail in `tailIds`, overwriting a prior entry for the same pair. An empty
	 * array records nothing (a record that committed no tail, such as a sweep); `undefined` records the
	 * action-wide entry. `now` is unix ms (injectable for tests).
	 */
	put(actionId: ActionId, cert: CommitCert, tailIds: readonly BlockId[] | undefined, now?: number): void;
	/** The cert retained for `(actionId, tailId)`, else the action-wide cert for `actionId`, else `undefined`. */
	get(actionId: ActionId, tailId: BlockId | undefined, now?: number): CommitCert | undefined;
}

export interface CommitCertStoreOptions {
	/** Retention per entry (ms). Default {@link DEFAULT_COMMIT_CERT_TTL_MS}. */
	readonly ttlMs?: number;
	/** Maximum retained entries, one per tail (oldest evicted first). Default {@link DEFAULT_COMMIT_CERT_MAX_ENTRIES}. */
	readonly maxEntries?: number;
}

/** The map key for `(actionId, tailId)`. JSON escapes both strings, so no pair of ids collides with
 * another, and the action-wide entry's `null` tail collides with no tail id. */
function certKey(actionId: ActionId, tailId: BlockId | undefined): string {
	return JSON.stringify([actionId, tailId ?? null]);
}

/** Build an in-memory {@link CommitCertStore} (insertion-ordered Map → recency for eviction). */
export function createCommitCertStore(options: CommitCertStoreOptions = {}): CommitCertStore {
	const ttlMs = options.ttlMs ?? DEFAULT_COMMIT_CERT_TTL_MS;
	const maxEntries = options.maxEntries ?? DEFAULT_COMMIT_CERT_MAX_ENTRIES;
	const entries = new Map<string, { cert: CommitCert; expiresAt: number }>();

	const dropExpired = (now: number): void => {
		for (const [key, entry] of entries) {
			if (entry.expiresAt <= now) {
				entries.delete(key);
			}
		}
	};

	const retain = (key: string, cert: CommitCert, now: number): void => {
		// Re-insert so a refreshed key moves to the most-recent end (Map preserves insertion order).
		entries.delete(key);
		entries.set(key, { cert, expiresAt: now + ttlMs });
	};

	const retained = (key: string, now: number): CommitCert | undefined => {
		const entry = entries.get(key);
		if (!entry) {
			return undefined;
		}
		if (entry.expiresAt <= now) {
			entries.delete(key);
			return undefined;
		}
		return entry.cert;
	};

	return {
		put(actionId, cert, tailIds, now = Date.now()): void {
			dropExpired(now);
			for (const tailId of tailIds ?? [undefined]) {
				retain(certKey(actionId, tailId), cert, now);
			}
			while (entries.size > maxEntries) {
				const oldest = entries.keys().next().value;
				if (oldest === undefined) break;
				entries.delete(oldest);
			}
		},
		get(actionId, tailId, now = Date.now()): CommitCert | undefined {
			const perTail = tailId === undefined ? undefined : retained(certKey(actionId, tailId), now);
			return perTail ?? retained(certKey(actionId, undefined), now);
		},
	};
}

/**
 * The collection tails a consensus record's commit operations commit — the tails its cert signs for.
 * An operation commits its tail when its `blockIds` name it, the same test `selfAppliedTail` applies
 * to the change event that operation emits, so every event that can originate finds its record's cert.
 * A batch yields one tail per collection; a sweep (a collection's non-tail blocks landing on another
 * cohort after its tail) yields none, since its events never originate.
 */
export function committedTailIds(commits: readonly CommitRequest[]): BlockId[] {
	return commits.filter(commit => commit.blockIds.includes(commit.tailId)).map(commit => commit.tailId);
}

/**
 * The bridge's `extractCommitCert` over a {@link CommitCertStore}: resolve a change event's action and
 * tail to the cluster commit cert of the record that committed that tail. Returns `undefined` (logged)
 * when no cert is retained — the bridge then skips origination rather than fabricating an unsigned
 * notification.
 */
export function makeClusterCommitCertExtractor(store: CommitCertStore): (event: CollectionChangeEvent) => CommitCert | undefined {
	return (event) => {
		const cert = store.get(event.actionId, event.tailId);
		if (!cert) {
			log('no commit cert retained for actionId=%s tail=%s (collection=%s rev=%d); skipping origination', event.actionId, event.tailId, event.collectionId, event.rev);
		}
		return cert;
	};
}
