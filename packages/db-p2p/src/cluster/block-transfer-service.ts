import type { Connection, Startable, Stream } from '@libp2p/interface';
import type { PeerId, IPeerNetwork, ActionId, ActionRev, GetBlockResult, IBlock, BlockId, BlockUnavailableReason, CollectionId } from '@optimystic/db-core';
import { peerIdFromString } from '@libp2p/peer-id';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';
import { fromString as u8FromString } from 'uint8arrays/from-string';
import { toString as u8ToString } from 'uint8arrays/to-string';
import { ProtocolClient } from '../protocol-client.js';
import { MAX_BLOCK_MESSAGE_BYTES } from '../protocol-limits.js';
import { createLogger } from '../logger.js';
import { createInboundStreamAuthorization, type InboundStreamAuthorization, type InboundStreamAuthorizationInit } from '../inbound-authorization.js';
import { certifyContent, proofThresholds } from './certified-claims.js';
import type { BlockCommitProof, ProofThresholds } from './commit-proof.js';
import { servableProof, type ArchiveServingRepo } from '../storage/block-archive.js';
import type { BlockHoldersSink } from './cluster-repo.js';
import { registerProtocolHandler } from '../network/register-protocol-handler.js';

const log = createLogger('block-transfer-service');

/** Protocol path */
const BLOCK_TRANSFER_PREFIX = '/db-p2p/block-transfer/';
const BLOCK_TRANSFER_VERSION = '1.0.0';

export const buildBlockTransferProtocol = (protocolPrefix: string = ''): string =>
	`${protocolPrefix}${BLOCK_TRANSFER_PREFIX}${BLOCK_TRANSFER_VERSION}`;

/**
 * A request to keep copies of blocks: the sender pushes each block, and the receiver persists it.
 *
 * NOTE: accepted tradeoff — no protocol version separates this shape from the one before it (blocks as
 * base64 strings in `blockData`, answered with the bytes echoed back), so builds either side of the
 * change cannot copy blocks to each other: each answers the other's push with every block `missing`,
 * and nothing is persisted. Backwards compatibility is not a goal yet (AGENTS.md); revisit once
 * mixed-version deployments must replicate to each other.
 */
export interface BlockTransferRequest {
	/** Block IDs being pushed. An id with no entry in {@link blocks} is answered `missing`. */
	blockIds: string[];
	/** Reason for transfer */
	reason: 'rebalance' | 'replication' | 'recovery';
	/**
	 * Each block as its own JSON value, keyed by block ID. Not an encoded string: base64 made a block a
	 * third larger, so a block over about 6 MiB of JSON could not be pushed at all. As itself, a block up
	 * to `MAX_BLOCK_BYTES` plus its {@link blockMeta} and {@link blockProofs} fits one push frame
	 * (`MAX_BLOCK_MESSAGE_BYTES`).
	 *
	 * Typed as blocks for the sender; the receiver gets whatever JSON the sender wrote and checks each
	 * value is a structurally valid block before anything else.
	 */
	blocks?: Record<string, IBlock>;
	/**
	 * The source's revision metadata per block ID. Carries the sender's
	 * `state.latest` so the replica's `latest` matches the source instead of being
	 * fabricated. Optional: an older sender omits it and the receiver falls back to a
	 * deterministic rev-1 replica (see {@link IBlockStorage.saveReplica}).
	 */
	blockMeta?: Record<string, { rev: number; actionId: ActionId }>;
	/**
	 * The cohort's commit proof for each block's revision. Verified against the pushed
	 * bytes AND against the declared {@link blockMeta} before anything is persisted — one
	 * `certifyContent` call covers the signatures and thresholds, the claim matching the declared
	 * `(rev, actionId)`, and the declared digest matching the pushed bytes.
	 *
	 * Optional on the wire so an un-upgraded sender still parses; whether a proof-less push is
	 * ACCEPTED is the receiver's `requirePushCertificate` decision (default: reject).
	 */
	blockProofs?: Record<string, BlockCommitProof>;
}

/**
 * The `blockMeta` a pusher sends alongside one block: the source's own `state.latest`, so the
 * replica lands at the source's `(rev, actionId)` rather than a fabricated one. That match is what
 * later lets the replica CORROBORATE the source in a read-repair quorum vote — a fabricated action
 * id never matches the source's claim, so the vote sees one claimant, not two.
 *
 * `undefined` when the source repo reports no `latest`; the receiver then falls back to its
 * deterministic rev-1 replica (see `IBlockStorage.saveReplica`).
 *
 * Every push path (rebalance confirm/push, spread-on-churn) builds it here so the wire shape stays
 * defined in one place alongside {@link BlockTransferRequest.blockMeta}.
 *
 * The caller must read the block UNPINNED (no `BlockGets.context`). `state.latest` is the newest
 * revision the source holds, while `block` is the revision `materialized` names; those agree only
 * for an unpinned read. Pairing pinned (older) content with `latest` would label content with a
 * revision it is not — so the pairing is guarded below and drops the meta rather than lying.
 *
 * Dropping, rather than labelling the older content with its own (now known) `materialized`
 * revision, is deliberate: a push is "here is my latest replica" — the receiver lands it as its
 * replica and the source's `latest` is what the cohort corroborates — and no push path reads
 * pinned, so a mismatch here is a caller bug, not a historical serve. A repair fetch of an older
 * revision is a different wire (`serveBlockArchive`), and that one DOES label from `materialized`.
 */
export function sourceBlockMeta(
	blockId: BlockId,
	result: Pick<GetBlockResult, 'state' | 'materialized'> | undefined
): Record<string, ActionRev> | undefined {
	const latest = result?.state?.latest;
	if (!latest) return undefined;
	const materialized = result?.materialized;
	if (materialized !== undefined && materialized.rev !== latest.rev) {
		log('meta:skip block=%s materialized=%d latest=%d (pinned read — refusing to mislabel content)',
			blockId, materialized.rev, latest.rev);
		return undefined;
	}
	return { [blockId]: { rev: latest.rev, actionId: latest.actionId } };
}

/**
 * Everything a push carries ABOUT the blocks it pushes, as one value: the source's revision
 * metadata and the cohort commit proof for that same revision. One parameter rather than two so a
 * caller cannot attach a proof for one revision beside metadata for another — the two are built
 * together by {@link sourceBlockCertification} from a single unpinned read, or not at all.
 */
export type PushCertification = {
	blockMeta?: Record<string, ActionRev>;
	blockProofs?: Record<string, BlockCommitProof>;
};

/**
 * Build a push's {@link PushCertification} for ONE block from a single unpinned read: the
 * {@link sourceBlockMeta} for the source's `state.latest`, plus the locally-retained
 * {@link BlockCommitProof} for exactly that revision.
 *
 * The proof comes from {@link servableProof} — the same accessor that decides what a peer attaches
 * to a served repair archive — so a push and a repair fetch can never disagree about which proof
 * pairs with which revision. It fails closed on every unhappy path (repo with no proof accessor, a
 * throwing lookup, a stored proof whose message names a different `(blockId, rev, actionId)`), so a
 * mis-paired artifact is never pushed.
 *
 * **A proof is never attached without its meta.** Without the declared `(rev, actionId)` a receiver
 * has no claim to verify the proof against, and it rejects the block (see
 * `BlockTransferService.handlePush`).
 *
 * **Meta IS still attached when no proof exists.** That is the pre-proof push, unchanged: a
 * receiver running the default `requirePushCertificate: true` rejects it either way, and one
 * migrating with the flag `false` needs the meta to land the replica at the source's revision
 * instead of a fabricated rev 1. Dropping the meta alongside the missing proof would regress the
 * legacy path without making the strict path any stricter.
 *
 * Like `sourceBlockMeta`, the caller must have read the block UNPINNED, so `block`, the meta and
 * the proof all describe the same revision.
 */
export async function sourceBlockCertification(
	repo: ArchiveServingRepo,
	blockId: BlockId,
	result: Pick<GetBlockResult, 'state' | 'materialized'> | undefined
): Promise<PushCertification> {
	const blockMeta = sourceBlockMeta(blockId, result);
	if (!blockMeta) {
		return {};
	}
	const latest = result!.state!.latest!;
	const proof = await servableProof(repo, blockId, latest);
	if (!proof) {
		log('cert:no-local-proof block=%s rev=%d (pushing uncertified)', blockId, latest.rev);
		return { blockMeta };
	}
	return { blockMeta, blockProofs: { [blockId]: proof } };
}

/**
 * The answer to a push: which blocks the receiver now holds and which it does not. It carries no block
 * content — the sender already has it, and echoing it back would double the bytes on the link.
 */
export interface BlockTransferResponse {
	/** Block IDs the receiver persisted, or already held at the pushed revision. */
	accepted: string[];
	/** Block IDs the receiver did not persist: absent, not a block, uncertified, or a persist fault. */
	missing: string[];
}

// --- Service (server-side handler) ---

/**
 * Repo capability the service needs: a local "save replica" path for `handlePush`. The replica path
 * must land in the node's *local* storage (not the cluster-coordinated repo), so it is a distinct
 * method from the `IRepo` commit funnel. `StorageRepo` implements this.
 */
export interface IBlockReplicaStore {
	/**
	 * Persist a replica of a block received out-of-band (churn re-replication).
	 * Seeds metadata if absent, advances `latest` monotonically, and makes the block
	 * durably servable via `get`. Idempotent for a fixed `(rev, actionId)`; a no-op
	 * (still durable) when an equal-or-newer revision is already present.
	 *
	 * `verifiedProof` MUST already have been verified against these exact bytes and this exact
	 * `source` (`certifyContent` — the digest check is what binds a proof to the content). It is
	 * retained so the receiver can re-prove onward what it just verified, instead of becoming a
	 * holder that can only corroborate.
	 */
	saveReplicatedBlock(blockId: BlockId, block: IBlock, source?: ActionRev, verifiedProof?: BlockCommitProof): Promise<void>;
}

export interface BlockTransferServiceInit extends InboundStreamAuthorizationInit {
	protocolPrefix?: string;
	/**
	 * Reject a pushed block that carries no verifying commit proof. Default `true`.
	 * A deployment holding pre-proof data sets this `false` during migration.
	 *
	 * **Why the strict default.** `handlePush` persists what a peer hands it, and
	 * `saveReplicatedBlock` advances `latest` monotonically — so an uncertified push makes the
	 * pusher's bytes this node's authoritative revision, after which this node *corroborates* the
	 * pusher in a later read-repair vote. That is how a peer manufactures its own corroborators.
	 *
	 * The failure mode of `true` is that legacy blocks stop gaining new holders via push — visible
	 * in a `push:reject-uncertified` log line, and those blocks stay readable while two or more
	 * holders remain. The failure mode of `false` is silent acceptance of forged content. Pre-proof
	 * blocks can never be certified (the signatures no longer exist), but any block written again
	 * under the current code gets a proof, so only cold, never-updated blocks stay uncertified.
	 *
	 * With the flag `false` an uncertified push falls back to the pre-proof behaviour, logged as
	 * `push:accept-uncertified`. A push carrying a proof that FAILS verification is rejected
	 * regardless of the flag — that is not a legacy block, it is a bad one.
	 */
	requirePushCertificate?: boolean;
}

export interface BlockTransferServiceComponents {
	registrar: { handle: (...args: any[]) => Promise<void>; unhandle: (...args: any[]) => Promise<void> };
	repo: IBlockReplicaStore;
	/**
	 * The cohort's configured super-majority fraction, used to verify a pushed block's commit proof.
	 *
	 * REQUIRED rather than defaulted: the node factory must hand this down from the single resolved
	 * `consensusConfig` every other consensus consumer reads (`libp2p-node-base.ts`, which already
	 * fail-fast asserts member/coordinator coupling on exactly this value). A local default here
	 * would be a third copy that silently disagrees with a deployment that tuned the threshold.
	 *
	 * The simple-majority half of {@link ProofThresholds} is deliberately NOT threaded: it must
	 * mirror what members actually enforce (`count > total / 2`), not the configured 0.51 — see
	 * `proofThresholds` in `certified-claims.ts`, the one helper every proof-verifying path builds
	 * its thresholds with.
	 */
	superMajorityThreshold: number;
	/**
	 * Optional: told, per accepted pushed block, that the sending peer holds it — and that this node
	 * now holds it too. The node's rebalance monitor consumes that as growth evidence, so a received
	 * replica is not pushed straight back to its sender on the next check (nor reported `gained`,
	 * which starts no transfer either way). See {@link BlockHoldersSink}.
	 *
	 * Optional so a directly-constructed service (tests, an embedder wiring only the protocol) keeps
	 * working; absent, `handlePush` behaves exactly as it did without it.
	 */
	onBlockHolders?: BlockHoldersSink;
}

/**
 * Libp2p service that handles incoming block transfer requests: it accepts pushed blocks and stores
 * them locally.
 */
export class BlockTransferService implements Startable {
	private running = false;
	private readonly protocol: string;
	private readonly repo: IBlockReplicaStore;
	private readonly registrar: BlockTransferServiceComponents['registrar'];
	/** Optional embedder authorization gate; `undefined` (the default) means no check runs. */
	private readonly authorization: InboundStreamAuthorization | undefined;
	/** Built once from the node's configured super-majority — see {@link BlockTransferServiceComponents.superMajorityThreshold}. */
	private readonly proofThresholds: ProofThresholds;
	/** See {@link BlockTransferServiceInit.requirePushCertificate}. */
	private readonly requirePushCertificate: boolean;
	/** See {@link BlockTransferServiceComponents.onBlockHolders}. */
	private readonly onBlockHolders: BlockHoldersSink | undefined;

	constructor(
		components: BlockTransferServiceComponents,
		init: BlockTransferServiceInit = {}
	) {
		this.protocol = buildBlockTransferProtocol(init.protocolPrefix ?? '');
		this.repo = components.repo;
		this.registrar = components.registrar;
		this.proofThresholds = proofThresholds(components.superMajorityThreshold);
		this.requirePushCertificate = init.requirePushCertificate ?? true;
		this.onBlockHolders = components.onBlockHolders;
		// Denials are errors, so they go to this module's own `:error` child channel rather than its
		// main one — visible under `optimystic:db-p2p:block-transfer-service:*`, not under an exact
		// match on `optimystic:db-p2p:block-transfer-service` alone.
		this.authorization = createInboundStreamAuthorization(init, this.protocol,
			(msg, ...args) => log.error(msg, ...args));
	}

	async start(): Promise<void> {
		if (this.running) return;
		await registerProtocolHandler(this.registrar, this.protocol, async (data: any, connection?: Connection) => {
			// libp2p invokes the stream handler with the Stream as the FIRST positional argument
			// (see cluster/repo/dispute services, which all use `(stream, connection)`). The block-
			// transfer handler previously read `data.stream`, which is `undefined` for the positional
			// shape — so `readRequest` ran `pipe(undefined, ...)` → "Empty pipeline", the receiver
			// never replied, and every push/pull dialled this service hung with no response. Unwrap
			// defensively (older shape passed `{ stream }`), mirroring sync/service.ts.
			const stream = data?.stream ?? data;
			await this.handleRequest(stream, connection);
		});
		this.running = true;
		log('started on %s', this.protocol);
	}

	async stop(): Promise<void> {
		if (!this.running) return;
		await this.registrar.unhandle(this.protocol);
		this.running = false;
		log('stopped');
	}

	private async handleRequest(stream: Stream, connection?: Connection): Promise<void> {
		const self = this;
		// The one derivation of who is on the other end: the authorization gate judges it, and a push
		// names it as the holder of what it sends. Two readings of `connection` could disagree.
		const remotePeerId = connection?.remotePeer?.toString();
		try {
			// Authorization runs before ANY decoding or execution. Guarded on the field so a
			// node without a predicate keeps the original path untouched.
			if (this.authorization && await this.authorization.deny(stream, remotePeerId)) return;
			// Read the request, process it, and write the response on ONE continuous duplex
			// pipe (mirrors cluster/repo/dispute services). The earlier read-to-end-then-write
			// design deadlocked over a real stream: the client sends one length-prefixed request
			// and holds its write side open awaiting the reply, so a receiver that drained the
			// source until end-of-stream blocked forever — and the reply, written only after
			// teardown, hit a closed stream. Yielding the response as soon as the request is read
			// keeps both sides live.
			const responses = pipe(
				stream,
				(source) => lp.decode(source, { maxDataLength: MAX_BLOCK_MESSAGE_BYTES }),
				async function* (source) {
					for await (const msg of source) {
						const request = JSON.parse(u8ToString(msg.subarray(), 'utf8')) as BlockTransferRequest;
						log('request blocks=%d reason=%s', request.blockIds.length, request.reason);
						let response: BlockTransferResponse;
						try {
							response = await self.handlePush(request, remotePeerId);
						} catch (error) {
							log('error: %s', (error as Error).message);
							// A sender counts a block held unless it is listed missing, so a fault answers
							// every block missing rather than none.
							response = { accepted: [], missing: request.blockIds };
						}
						log('response accepted=%d missing=%d', response.accepted.length, response.missing.length);
						yield u8FromString(JSON.stringify(response), 'utf8');
						return; // one request → one response per stream
					}
				},
				(source) => lp.encode(source, { maxDataLength: MAX_BLOCK_MESSAGE_BYTES })
			);
			for await (const chunk of responses) {
				stream.send(chunk);
			}
			await stream.close();
		} catch (err) {
			log('error: %s', (err as Error).message);
			try { stream.abort(err instanceof Error ? err : new Error(String(err))); } catch { /* ignore */ }
		}
	}

	/**
	 * Persist pushed blocks into local storage so the new owner holds a durable
	 * replica after churn. A block is reported `accepted` only if it was both
	 * received (a structurally valid block) AND successfully persisted; an invalid, uncertified or
	 * unpersisted block surfaces as `missing` so the sender does not falsely treat it as replicated.
	 *
	 * **Certification.** A pushed block is content this node will serve — and, because
	 * `saveReplicatedBlock` advances `latest`, content it will later CORROBORATE in a read-repair
	 * vote. So by default the pusher must show the cohort's commit proof for the revision it
	 * declares, verified here against both the declared `(rev, actionId)` and the pushed bytes. See
	 * {@link BlockTransferServiceInit.requirePushCertificate} for the migration flag and its
	 * rationale.
	 *
	 * Decisions are strictly PER BLOCK: in a multi-block push a block that verifies is accepted
	 * beside one that does not.
	 *
	 * **The sender is reported as a holder of every block this call ACCEPTS** (see
	 * {@link BlockTransferServiceComponents.onBlockHolders}), which is exactly the set left out of
	 * `missing`: a block that failed validation, certification or persistence is not one this node now
	 * holds, and suppressing its `gained` report would be a lie. A monotonic no-op acceptance —
	 * `saveReplicatedBlock` finding the pushed revision already held, so no collection change fires —
	 * is reported like any other: the sender is a holder either way, and the block may already be
	 * tracked from an earlier route.
	 */
	private async handlePush(request: BlockTransferRequest, senderPeerId?: string): Promise<BlockTransferResponse> {
		const accepted: string[] = [];
		const missing: string[] = [];

		if (!request.blocks) {
			return { accepted: [], missing: request.blockIds };
		}

		for (const blockId of request.blockIds) {
			// The value is whatever JSON the sender wrote: absent, `null`, a primitive, a `null` header.
			// Persisting a falsy or header-less "block" would seed metadata with no materialization, making
			// every later `get` throw. Reject such payloads as missing rather than poison storage.
			const block: unknown = request.blocks[blockId];
			if (!isStructurallyBlock(block)) {
				log('push:invalid block=%s (not a structurally valid block)', blockId);
				missing.push(blockId);
				continue;
			}

			// Certify BEFORE persisting: `saveReplicatedBlock` advances `latest`, so anything that
			// reaches it becomes this node's authoritative revision.
			const source = request.blockMeta?.[blockId];
			const proof = request.blockProofs?.[blockId];
			let verifiedProof: BlockCommitProof | undefined;
			if (proof !== undefined) {
				if (!source) {
					// No declared `(rev, actionId)` means no claim to verify the proof against, and
					// `saveReplica` would fabricate a rev-1 replica the proof does not cover.
					log('push:reject-uncertified block=%s reason=proof-without-meta', blockId);
					missing.push(blockId);
					continue;
				}
				// One call covers the signatures and thresholds, the claim matching the declared
				// `(rev, actionId)`, and the declared digest matching these exact bytes. Routed through
				// `certifyContent` rather than the raw verifier so the wire-facing signer cap
				// (MAX_PROOF_SIGNERS) the verifier requires of its callers is applied before any
				// signature work — this input comes from an unauthenticated peer.
				//
				// NOTE: no `ProofAnchoring` is threaded here, unlike the other two proof-verifying
				// paths (`ReconcileBlockDeps.anchoring`, `CoordinatorRepo`'s). Nothing wires anchoring
				// in production today, so all three behave identically; when
				// `feat-cluster-membership-threshold-cert-anchoring` lands, this call needs the same
				// optional dep or the push path becomes the one place the unanchored residual is
				// neither compared nor surfaced.
				//
				// NOTE: verification cost per REQUEST is unbounded in a way per-proof caps do not
				// cover — one inbound push frame is capped at MAX_BLOCK_MESSAGE_BYTES (8 MiB, not the
				// 1 MiB control cap `MAX_PROOF_SIGNERS`' note reasons about) and may carry one proof
				// per block id. Each proof is bounded (≤ 256 signers), but their number is the
				// sender's choice. Acceptable today because the pre-proof path already did per-block
				// parse + disk write on the same frame; if inbound push CPU ever shows up in a
				// profile, bound the per-request proof count (or total proof bytes) here.
				const verdict = await certifyContent(
					proof, { blockId, rev: source.rev, actionId: source.actionId }, block, this.proofThresholds);
				if (!verdict.contentCertified) {
					log('push:reject-uncertified block=%s rev=%d reason=%s', blockId, source.rev, verdict.failure);
					missing.push(blockId);
					continue;
				}
				verifiedProof = proof;
			} else if (this.requirePushCertificate) {
				// The documented migration case: an un-upgraded sender, or a block committed before
				// proofs existed. Diagnosable by this line alone.
				log('push:reject-uncertified block=%s rev=%s reason=no-proof', blockId, source?.rev);
				missing.push(blockId);
				continue;
			} else {
				log('push:accept-uncertified block=%s rev=%s (requirePushCertificate disabled)', blockId, source?.rev);
			}

			// Persist locally. Only a received-AND-persisted block is reported accepted.
			try {
				await this.repo.saveReplicatedBlock(blockId, block, source, verifiedProof);
				accepted.push(blockId);
			} catch (error) {
				log('persist:fail block=%s err=%s', blockId, (error as Error).message);
				missing.push(blockId);
			}
		}

		this.reportSenderHolds(accepted, senderPeerId);
		return { accepted, missing };
	}

	/**
	 * Tell the {@link BlockHoldersSink} that `senderPeerId` holds each accepted block — and, since
	 * this node just persisted them, that it holds them too. A push with no resolvable remote peer id
	 * (a directly-driven handler, a connection without one) reports nothing: there is no peer to name.
	 *
	 * Never throws. A push reply must not fail because a monitor's listener did.
	 */
	private reportSenderHolds(acceptedBlockIds: string[], senderPeerId: string | undefined): void {
		if (!this.onBlockHolders || !senderPeerId || acceptedBlockIds.length === 0) return;
		try {
			this.onBlockHolders({ blockIds: acceptedBlockIds, holders: [senderPeerId] });
		} catch (error) {
			log('push:block-holders-sink-error peer=%s err=%s', senderPeerId, (error as Error).message);
		}
	}
}

/** A pushed value the receiver may go on to certify and persist: an object whose `header` is an object. */
function isStructurallyBlock(value: unknown): value is IBlock {
	if (value === null || typeof value !== 'object') return false;
	const header: unknown = (value as IBlock).header;
	return header !== null && typeof header === 'object';
}

/** Factory for creating BlockTransferService following the libp2p service pattern. */
export const blockTransferService = (init: BlockTransferServiceInit = {}) =>
	(components: BlockTransferServiceComponents) => new BlockTransferService(components, init);

// --- Client ---

/**
 * Client for sending block transfer requests to remote peers.
 */
export class BlockTransferClient extends ProtocolClient {
	private readonly protocol: string;

	constructor(
		peerId: PeerId,
		peerNetwork: IPeerNetwork,
		protocolPrefix: string = ''
	) {
		super(peerId, peerNetwork);
		this.protocol = buildBlockTransferProtocol(protocolPrefix);
	}

	/**
	 * Push blocks to the remote peer.
	 *
	 * @param blocks The blocks to push, keyed by block ID, each as read from this node's own store.
	 * @param certification What this push claims about the blocks — the source's revision metadata
	 *   and the cohort commit proof for that same revision, built as one unit by
	 *   {@link sourceBlockCertification}. Without a proof the receiver rejects the block under its
	 *   default `requirePushCertificate: true`; without metadata it replicates at a deterministic
	 *   rev-1 (and rejects any proof, which then covers nothing).
	 * @param options Optional per-call deadlines/cancellation forwarded to the
	 *   underlying request. `dialTimeoutMs` bounds connecting; `responseTimeoutMs`
	 *   bounds waiting for the reply once connected (so a peer that connects but goes
	 *   silent throws {@link ResponseTimeoutError} instead of hanging); `signal`
	 *   cancels the whole request. Omitting all of them preserves the previous
	 *   uncapped behavior.
	 */
	async pushBlocks(
		blocks: Record<BlockId, IBlock>,
		reason: BlockTransferRequest['reason'] = 'rebalance',
		certification?: PushCertification,
		options?: { signal?: AbortSignal; dialTimeoutMs?: number; responseTimeoutMs?: number }
	): Promise<BlockTransferResponse> {
		const request: BlockTransferRequest = {
			blockIds: Object.keys(blocks), reason, blocks,
			...(certification?.blockMeta ? { blockMeta: certification.blockMeta } : {}),
			...(certification?.blockProofs ? { blockProofs: certification.blockProofs } : {})
		};
		return await this.processMessage<BlockTransferResponse>(request, this.protocol, { ...options, maxDataLength: MAX_BLOCK_MESSAGE_BYTES, maxRequestBytes: MAX_BLOCK_MESSAGE_BYTES });
	}
}

// --- The one push loop ---

/** Why one peer did not confirm a pushed block. */
export type PushRefusal = {
	peerId: string;
	/**
	 * `rejected`: the peer ANSWERED and listed the block as missing — it did not persist it
	 * (uncertified under its `requirePushCertificate`, unparseable, or a persist fault; the receiver
	 * logs which). `unreachable`: the push threw — a dial failure, a deadline, a stream error.
	 */
	reason: 'rejected' | 'unreachable';
	/** The thrown error's message, for `unreachable`. */
	error?: string;
};

/**
 * What {@link pushBlockToPeers} found and did. `no-local-data` and `unavailable` mean nothing was
 * pushed: the first is "this node holds no revision of the block", the second is "this node could
 * not find out" (a failed restore, an unmaterializable history) — a caller that prunes on the first
 * must NOT prune on the second, or it drops a block it may well hold.
 */
export type PushBlockOutcome =
	| { status: 'no-local-data' }
	| { status: 'unavailable'; reason: BlockUnavailableReason }
	| {
		status: 'pushed';
		/** The revision pushed — the source's `state.latest`. Absent for a repo that reports none. */
		latest?: ActionRev;
		/** From the pushed block's header, when it names a collection. */
		collectionId?: CollectionId;
		/** Whether a cohort commit proof travelled with the block. Without one a receiver running
		 *  the default `requirePushCertificate` rejects it, so a `false` here with every peer
		 *  `rejected` is "cannot place", not "cannot reach". */
		certified: boolean;
		/** Peers that hold the block now: each answered without listing it as missing. */
		confirmed: string[];
		refusals: PushRefusal[];
		/** Peers not pushed to because {@link PushBlockOptions.stopAfterConfirmed} was reached first. */
		skipped: string[];
	};

export interface PushBlockOptions {
	/** Default `'replication'`. */
	reason?: BlockTransferRequest['reason'];
	/** The `/optimystic/<networkName>` prefix the receivers register their handler under. */
	protocolPrefix?: string;
	/** Stop once this many distinct peers have confirmed; the rest are reported `skipped`. Default:
	 *  every peer is pushed to. */
	stopAfterConfirmed?: number;
	/** Per-peer deadlines forwarded to {@link BlockTransferClient.pushBlocks}; omitted = uncapped. */
	dialTimeoutMs?: number;
	responseTimeoutMs?: number;
}

/**
 * Push ONE locally held block to `peerIds`, in order: read it unpinned from `repo`, build its
 * {@link PushCertification} from that same read, push it to each peer, and read each answer the one
 * way that is true — a peer holds the block only when its response does NOT list the block as
 * missing, because `handlePush` omits a block from `missing` only after persisting it (or already
 * holding that revision). A round trip that returns is not a landed replica; a round trip that
 * throws is not a refusal.
 *
 * This is the whole read-certify-push-interpret sequence every sender runs — the rebalance
 * handoff and confirm (`BlockTransferCoordinator`), spread-on-churn, and the under-replication
 * drain — so a change to how a block is placed is made here once. Retry, stopping condition and
 * deadlines are the caller's: `stopAfterConfirmed` for "until one owner accepts" or "until the
 * floor", the two deadlines for a sequential loop that must not hang on a silent peer, and the
 * caller wraps the call in its own retry. It logs nothing per peer; the outcome carries what each
 * caller's own diagnostics say.
 *
 * `repo` is the node's OWN store, so the read never consults the cluster and the certification
 * comes from the proof this node retained; a repo without a proof accessor pushes meta-only
 * (`certified: false`), which a default-configured receiver refuses.
 */
export async function pushBlockToPeers(
	repo: ArchiveServingRepo,
	peerNetwork: IPeerNetwork,
	blockId: BlockId,
	peerIds: readonly string[],
	options: PushBlockOptions = {}
): Promise<PushBlockOutcome> {
	const result = (await repo.get({ blockIds: [blockId] }))[blockId];
	if (result?.unavailable !== undefined) {
		return { status: 'unavailable', reason: result.unavailable };
	}
	if (!result?.block) {
		return { status: 'no-local-data' };
	}
	const certification = await sourceBlockCertification(repo, blockId, result);
	const reason = options.reason ?? 'replication';
	const deadlines = { dialTimeoutMs: options.dialTimeoutMs, responseTimeoutMs: options.responseTimeoutMs };
	const stopAfter = options.stopAfterConfirmed ?? Number.POSITIVE_INFINITY;

	const confirmed: string[] = [];
	const refusals: PushRefusal[] = [];
	const skipped: string[] = [];
	for (const peerIdStr of peerIds) {
		if (confirmed.length >= stopAfter) {
			skipped.push(peerIdStr);
			continue;
		}
		try {
			const client = new BlockTransferClient(peerIdFromString(peerIdStr), peerNetwork, options.protocolPrefix);
			const response = await client.pushBlocks({ [blockId]: result.block }, reason, certification, deadlines);
			if (response.missing.includes(blockId)) {
				refusals.push({ peerId: peerIdStr, reason: 'rejected' });
			} else {
				confirmed.push(peerIdStr);
			}
		} catch (err) {
			refusals.push({ peerId: peerIdStr, reason: 'unreachable', error: err instanceof Error ? err.message : String(err) });
		}
	}
	return {
		status: 'pushed',
		latest: result.state?.latest,
		collectionId: result.block.header?.collectionId,
		certified: certification.blockProofs !== undefined,
		confirmed,
		refusals,
		skipped
	};
}
