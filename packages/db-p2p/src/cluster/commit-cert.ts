import type { ActionId, ClusterRecord, CollectionChangeEvent, CommitCert } from "@optimystic/db-core";
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
 * Bounded, TTL'd cache of recently-committed {@link CommitCert}s keyed by `actionId`. The cluster
 * member records a cert here just before consensus applies the commit to local storage; the
 * change-notifier bridge's extractor reads it when the StorageRepo emits the matching
 * {@link CollectionChangeEvent}. Both happen on the same node within one commit, so the window is
 * tiny — but a TTL + cap keep the map from leaking if a commit ever lands without emitting a change
 * event (e.g. an idempotent re-commit, or a path with no catch-all subscriber).
 */
export interface CommitCertStore {
	/** Record `cert` for `actionId` (overwrites any prior entry). `now` is unix ms (injectable for tests). */
	put(actionId: ActionId, cert: CommitCert, now?: number): void;
	/** The cert for `actionId` if still retained, else `undefined`. */
	get(actionId: ActionId, now?: number): CommitCert | undefined;
}

export interface CommitCertStoreOptions {
	/** Retention per entry (ms). Default {@link DEFAULT_COMMIT_CERT_TTL_MS}. */
	readonly ttlMs?: number;
	/** Maximum retained entries (oldest evicted first). Default {@link DEFAULT_COMMIT_CERT_MAX_ENTRIES}. */
	readonly maxEntries?: number;
}

/** Build an in-memory {@link CommitCertStore} (insertion-ordered Map → recency for eviction). */
export function createCommitCertStore(options: CommitCertStoreOptions = {}): CommitCertStore {
	const ttlMs = options.ttlMs ?? DEFAULT_COMMIT_CERT_TTL_MS;
	const maxEntries = options.maxEntries ?? DEFAULT_COMMIT_CERT_MAX_ENTRIES;
	const entries = new Map<ActionId, { cert: CommitCert; expiresAt: number }>();

	const dropExpired = (now: number): void => {
		for (const [actionId, entry] of entries) {
			if (entry.expiresAt <= now) {
				entries.delete(actionId);
			}
		}
	};

	return {
		put(actionId, cert, now = Date.now()): void {
			dropExpired(now);
			// Re-insert so a refreshed key moves to the most-recent end (Map preserves insertion order).
			entries.delete(actionId);
			entries.set(actionId, { cert, expiresAt: now + ttlMs });
			while (entries.size > maxEntries) {
				const oldest = entries.keys().next().value;
				if (oldest === undefined) break;
				entries.delete(oldest);
			}
		},
		get(actionId, now = Date.now()): CommitCert | undefined {
			const entry = entries.get(actionId);
			if (!entry) {
				return undefined;
			}
			if (entry.expiresAt <= now) {
				entries.delete(actionId);
				return undefined;
			}
			return entry.cert;
		},
	};
}

/**
 * The bridge's `extractCommitCert` over a {@link CommitCertStore}: resolve a change event's committed
 * action to the cluster commit cert captured for it. Returns `undefined` (logged) when no cert is
 * retained — the bridge then skips origination rather than fabricating an unsigned notification.
 */
export function makeClusterCommitCertExtractor(store: CommitCertStore): (event: CollectionChangeEvent) => CommitCert | undefined {
	return (event) => {
		const cert = store.get(event.actionId);
		if (!cert) {
			log('no commit cert retained for actionId=%s (collection=%s rev=%d); skipping origination', event.actionId, event.collectionId, event.rev);
		}
		return cert;
	};
}
