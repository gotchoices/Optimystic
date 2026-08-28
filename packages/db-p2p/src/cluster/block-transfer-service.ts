import type { Connection, Startable, Stream } from '@libp2p/interface';
import type { IRepo, PeerId, IPeerNetwork, ActionId, ActionRev, GetBlockResult, IBlock, BlockId } from '@optimystic/db-core';
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

const log = createLogger('block-transfer-service');

/** Protocol path */
const BLOCK_TRANSFER_PREFIX = '/db-p2p/block-transfer/';
const BLOCK_TRANSFER_VERSION = '1.0.0';

export const buildBlockTransferProtocol = (protocolPrefix: string = ''): string =>
	`${protocolPrefix}${BLOCK_TRANSFER_PREFIX}${BLOCK_TRANSFER_VERSION}`;

/** Request to transfer blocks */
export interface BlockTransferRequest {
	type: 'pull' | 'push';
	/** Block IDs being transferred */
	blockIds: string[];
	/** Reason for transfer */
	reason: 'rebalance' | 'replication' | 'recovery';
	/** For push: base64-encoded block data per block ID */
	blockData?: Record<string, string>;
	/**
	 * For push: the source's revision metadata per block ID. Carries the sender's
	 * `state.latest` so the replica's `latest` matches the source instead of being
	 * fabricated. Optional: an older sender omits it and the receiver falls back to a
	 * deterministic rev-1 replica (see {@link IBlockStorage.saveReplica}).
	 */
	blockMeta?: Record<string, { rev: number; actionId: ActionId }>;
	/**
	 * For push: the cohort's commit proof for each block's revision. Verified against the pushed
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
 * revision the source holds, while `block` is materialized at `materializedRev`; those agree only
 * for an unpinned read. Pairing pinned (older) content with `latest` would label content with a
 * revision it is not — so the pairing is guarded below and drops the meta rather than lying.
 */
export function sourceBlockMeta(
	blockId: BlockId,
	result: Pick<GetBlockResult, 'state' | 'materializedRev'> | undefined
): Record<string, ActionRev> | undefined {
	const latest = result?.state?.latest;
	if (!latest) return undefined;
	const materializedRev = result?.materializedRev;
	if (materializedRev !== undefined && materializedRev !== latest.rev) {
		log('meta:skip block=%s materializedRev=%d latest=%d (pinned read — refusing to mislabel content)',
			blockId, materializedRev, latest.rev);
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
	result: Pick<GetBlockResult, 'state' | 'materializedRev'> | undefined
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

/** Response with block data */
export interface BlockTransferResponse {
	/** Blocks successfully transferred: blockId → base64-encoded data */
	blocks: Record<string, string>;
	/** Block IDs that couldn't be found/transferred */
	missing: string[];
}

// --- Service (server-side handler) ---

/**
 * Repo capability the service needs: read access for `handlePull` plus a local
 * "save replica" path for `handlePush`. The replica path must land in the node's
 * *local* storage (not the cluster-coordinated repo), so it is a distinct method
 * from the `IRepo` commit funnel. `StorageRepo` implements this.
 */
export interface IBlockReplicaStore extends IRepo {
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
	 * Optional libp2p component logger. Supplied by the node factory so authorization denials
	 * land on the same `logger.forComponent(...).error` sink as the repo/cluster/sync services;
	 * without it they fall back to this module's `debug` logger.
	 */
	logger?: { forComponent: (name: string) => { error: (message: string, ...args: unknown[]) => void } };
}

/**
 * Libp2p service that handles incoming block transfer requests.
 *
 * Responds to pull requests by reading blocks from local storage.
 * Handles push requests by accepting block data and storing it locally.
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

	constructor(
		components: BlockTransferServiceComponents,
		init: BlockTransferServiceInit = {}
	) {
		this.protocol = buildBlockTransferProtocol(init.protocolPrefix ?? '');
		this.repo = components.repo;
		this.registrar = components.registrar;
		this.proofThresholds = proofThresholds(components.superMajorityThreshold);
		this.requirePushCertificate = init.requirePushCertificate ?? true;
		const componentLog = components.logger?.forComponent('db-p2p:block-transfer');
		this.authorization = createInboundStreamAuthorization(init, this.protocol,
			componentLog ? (msg, ...args) => componentLog.error(msg, ...args) : (msg, ...args) => log(msg, ...args));
	}

	async start(): Promise<void> {
		if (this.running) return;
		await this.registrar.handle(this.protocol, async (data: any, connection?: Connection) => {
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
		try {
			// Authorization runs before ANY decoding or execution. Guarded on the field so a
			// node without a predicate keeps the original path untouched.
			if (this.authorization && await this.authorization.deny(stream, connection?.remotePeer?.toString())) return;
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
						log('request type=%s blocks=%d reason=%s', request.type, request.blockIds.length, request.reason);
						let response: BlockTransferResponse;
						try {
							response = request.type === 'pull'
								? await self.handlePull(request)
								: await self.handlePush(request);
						} catch (error) {
							log('error: %s', (error as Error).message);
							response = { blocks: {}, missing: [] };
						}
						log('response blocks=%d missing=%d', Object.keys(response.blocks).length, response.missing.length);
						yield u8FromString(JSON.stringify(response), 'utf8');
						return; // one request → one response per stream
					}
				},
				(source) => lp.encode(source)
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

	private async handlePull(request: BlockTransferRequest): Promise<BlockTransferResponse> {
		const blocks: Record<string, string> = {};
		const missing: string[] = [];

		const result = await this.repo.get({ blockIds: request.blockIds });

		for (const blockId of request.blockIds) {
			const blockResult = result[blockId];
			if (blockResult?.block) {
				blocks[blockId] = Buffer.from(JSON.stringify(blockResult.block)).toString('base64');
			} else {
				missing.push(blockId);
			}
		}

		return { blocks, missing };
	}

	/**
	 * Persist pushed blocks into local storage so the new owner holds a durable
	 * replica after churn. A block is reported `accepted` only if it was both
	 * received (parseable) AND successfully persisted; a parse, certification or persist failure
	 * surfaces it as `missing` so the sender does not falsely treat it as replicated.
	 *
	 * **Certification.** A pushed block is content this node will serve — and, because
	 * `saveReplicatedBlock` advances `latest`, content it will later CORROBORATE in a read-repair
	 * vote. So by default the pusher must show the cohort's commit proof for the revision it
	 * declares, verified here against both the declared `(rev, actionId)` and the pushed bytes. See
	 * {@link BlockTransferServiceInit.requirePushCertificate} for the migration flag and its
	 * rationale.
	 *
	 * Decisions are strictly PER BLOCK: in a multi-block push a block that verifies is accepted
	 * beside one that does not. `handlePull` is unaffected — it serves this node's own storage.
	 */
	private async handlePush(request: BlockTransferRequest): Promise<BlockTransferResponse> {
		const blocks: Record<string, string> = {};
		const missing: string[] = [];

		if (!request.blockData) {
			return { blocks: {}, missing: request.blockIds };
		}

		for (const blockId of request.blockIds) {
			const data = request.blockData[blockId];
			if (!data) {
				missing.push(blockId);
				continue;
			}

			// Decode + parse the wire payload into an IBlock.
			let block: IBlock;
			try {
				block = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as IBlock;
			} catch {
				missing.push(blockId);
				continue;
			}

			// `JSON.parse` accepts `null`/primitives as valid JSON. Persisting a falsy or
			// header-less "block" would seed metadata with no materialization, making every
			// later `get` throw. Reject such payloads as missing rather than poison storage.
			if (block === null || typeof block !== 'object' || (block as IBlock).header === undefined) {
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
				blocks[blockId] = data;
			} catch (error) {
				log('persist:fail block=%s err=%s', blockId, (error as Error).message);
				missing.push(blockId);
			}
		}

		return { blocks, missing };
	}
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
	 * Pull blocks from the remote peer.
	 *
	 * @param options Optional per-call deadlines/cancellation forwarded to the
	 *   underlying request. `dialTimeoutMs` bounds connecting; `responseTimeoutMs`
	 *   bounds waiting for the reply once connected; `signal` cancels the whole
	 *   request. Omitting all of them preserves the previous uncapped behavior.
	 */
	async pullBlocks(
		blockIds: string[],
		reason: BlockTransferRequest['reason'] = 'rebalance',
		options?: { signal?: AbortSignal; dialTimeoutMs?: number; responseTimeoutMs?: number }
	): Promise<BlockTransferResponse> {
		const request: BlockTransferRequest = { type: 'pull', blockIds, reason };
		return await this.processMessage<BlockTransferResponse>(request, this.protocol, { ...options, maxDataLength: MAX_BLOCK_MESSAGE_BYTES });
	}

	/**
	 * Push blocks to the remote peer.
	 *
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
		blockIds: string[],
		blockDataBuffers: Uint8Array[],
		reason: BlockTransferRequest['reason'] = 'rebalance',
		certification?: PushCertification,
		options?: { signal?: AbortSignal; dialTimeoutMs?: number; responseTimeoutMs?: number }
	): Promise<BlockTransferResponse> {
		const blockData: Record<string, string> = {};
		for (let i = 0; i < blockIds.length; i++) {
			blockData[blockIds[i]!] = Buffer.from(blockDataBuffers[i]!).toString('base64');
		}
		const request: BlockTransferRequest = {
			type: 'push', blockIds, reason, blockData,
			...(certification?.blockMeta ? { blockMeta: certification.blockMeta } : {}),
			...(certification?.blockProofs ? { blockProofs: certification.blockProofs } : {})
		};
		return await this.processMessage<BlockTransferResponse>(request, this.protocol, { ...options, maxDataLength: MAX_BLOCK_MESSAGE_BYTES });
	}
}
