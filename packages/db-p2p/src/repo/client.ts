import type {
	IRepo, GetBlockResults, PendSuccess, StaleFailure, ActionBlocks, MessageOptions, CommitResult,
	PendRequest, CommitRequest, BlockGets, IPeerNetwork, PeerId, BlockId
} from "@optimystic/db-core";
import type { RepoMessage } from "@optimystic/db-core";
import { blockIdsForTransforms } from "@optimystic/db-core";
import { ProtocolClient } from "../protocol-client.js";
import type { RedirectPayload } from "./redirect.js";
import { MAX_BLOCK_MESSAGE_BYTES } from "../protocol-limits.js";
import { peerIdFromString } from "@libp2p/peer-id";

export class RepoClient extends ProtocolClient implements IRepo {
	private constructor(peerId: PeerId, peerNetwork: IPeerNetwork, readonly protocolPrefix?: string) {
		super(peerId, peerNetwork);
	}

	/** Create a new client instance */
	public static create(peerId: PeerId, peerNetwork: IPeerNetwork, protocolPrefix?: string): RepoClient {
		return new RepoClient(peerId, peerNetwork, protocolPrefix);
	}

	async get(blockGets: BlockGets, options: MessageOptions): Promise<GetBlockResults> {
		return this.processRepoMessage<GetBlockResults>(
			[{ get: blockGets }],
			options
		);
	}

	async pend(request: PendRequest, options: MessageOptions): Promise<PendSuccess | StaleFailure> {
		return this.processRepoMessage<PendSuccess | StaleFailure>(
			[{ pend: request }],
			options
		);
	}

	async cancel(actionRef: ActionBlocks, options: MessageOptions): Promise<void> {
		return this.processRepoMessage<void>(
			[{ cancel: { actionRef } }],
			options
		);
	}

	async commit(request: CommitRequest, options: MessageOptions): Promise<CommitResult> {
		return this.processRepoMessage<CommitResult>(
			[{ commit: request }],
			options
		);
	}

	private extractCorrelationId(operations: RepoMessage['operations']): string | undefined {
		const op = operations[0];
		if (!op) return undefined;
		if ('pend' in op) return op.pend.actionId;
		if ('commit' in op) return op.commit.actionId;
		if ('cancel' in op) return op.cancel.actionRef.actionId;
		return undefined;
	}

	private async processRepoMessage<T>(
		operations: RepoMessage['operations'],
		options: MessageOptions,
		hop: number = 0
	): Promise<T> {
		const message: RepoMessage = {
			operations,
			expiration: options.expiration,
		};
		const correlationId = this.extractCorrelationId(operations);
		const deadline = options.expiration ?? (Date.now() + 30_000)
		const deadlineMs = Math.max(1, deadline - Date.now())
		const preferred = (this.protocolPrefix ?? '/db-p2p') + '/repo/1.0.0'

		// Drive the remaining `expiration` budget through an AbortController whose
		// abort *reason* is the caller-facing `'RepoClient timeout'` Error, combined
		// with any caller signal. processMessage forwards `signal` to both the dial
		// and the response-read and calls `stream.abort(signal.reason)` on abort, so —
		// unlike the old `Promise.race`, whose losing branch left the inner read
		// running and leaked a pending read + stream on every timed-out RPC to a silent
		// peer — the deadline now genuinely cancels the inner read while the caller
		// still observes an error whose `.message === 'RepoClient timeout'`.
		//
		// Intentionally no `responseTimeoutMs`: the combined signal already bounds the
		// read at `deadlineMs`. A second, shorter cap would surface as
		// ResponseTimeoutError and mask the caller-facing 'RepoClient timeout' message.
		const deadlineController = new AbortController()
		const timer = setTimeout(
			() => deadlineController.abort(new Error('RepoClient timeout')),
			deadlineMs
		)
		// Explicit combinator rather than the native `AbortSignal.any`, which Hermes
		// (React Native's JS engine) does not provide. This has to forward whichever
		// source signal's *reason* fired — that's how the caller-facing 'RepoClient
		// timeout' message above (and any reason a caller's own `options.signal` carries)
		// survives the combine. `any-signal` (the package libp2p itself uses for this) was
		// tried and rejected here: it calls the composite `AbortController.abort()` with no
		// argument, which discards the source reason and replaces it with a generic
		// AbortError — confirmed against both Node's native `AbortSignal.any` and
		// `any-signal@4.1.1` directly. Listeners are removed in the `finally` below so a
		// long-lived caller `options.signal` never accumulates one per call.
		const abortController = new AbortController()
		const forwardAbort = (source: AbortSignal) => (): void => abortController.abort(source.reason)
		const onCallerAbort = options?.signal ? forwardAbort(options.signal) : undefined
		const onDeadlineAbort = forwardAbort(deadlineController.signal)
		deadlineController.signal.addEventListener('abort', onDeadlineAbort, { once: true })
		if (options?.signal) {
			if (options.signal.aborted) abortController.abort(options.signal.reason)
			else options.signal.addEventListener('abort', onCallerAbort!, { once: true })
		}
		const combinedSignal = abortController.signal
		let response: any
		try {
			response = await super.processMessage<any>(message, preferred, {
				signal: combinedSignal,
				correlationId,
				dialTimeoutMs: options?.dialTimeoutMs,
				// A get response carries block data → block cap (not control).
				maxDataLength: MAX_BLOCK_MESSAGE_BYTES,
			})
		} finally {
			clearTimeout(timer)
			deadlineController.signal.removeEventListener('abort', onDeadlineAbort)
			if (onCallerAbort) options?.signal?.removeEventListener('abort', onCallerAbort)
		}

		// Type the redirect branch against the payload the service actually produces
		// (`RedirectPayload`) rather than reading it off the `any` response — the untyped read
		// is what let the `addrs` the sender embedded fall on the floor.
		const redirectResponse = response as Partial<RedirectPayload>
		if (redirectResponse?.redirect?.peers?.length) {
			if (hop >= 2) {
				throw new Error('Redirect loop detected in RepoClient (max hops reached)')
			}
			const currentIdStr = this.peerId.toString()
			const peers = redirectResponse.redirect.peers
			const next = peers.find((p) => p.id !== currentIdStr) ?? peers[0]!
			const nextId = peerIdFromString(next.id)
			if (next.id === currentIdStr) {
				throw new Error('Redirect loop detected in RepoClient (same peer)')
			}
			// Learn the redirect target's addresses BEFORE dialing it: the redirect is the only
			// notice we get that this peer matters, and if it is relay-only we have no address
			// for it at all. Merging after the dial would help only some later hop.
			this.peerNetwork.recordPeerAddresses?.(nextId, next.addrs ?? [])
			// Cache hint: a follow-up op on this block can dial the target directly.
			const coordinated = this.coordinatedBlockId(operations)
			if (coordinated) this.recordCoordinatorHint(coordinated, nextId)
			// single-hop retry against target peer using repo protocol
			const nextClient = RepoClient.create(nextId, this.peerNetwork, this.protocolPrefix)
			return await nextClient.processRepoMessage<T>(operations, options, hop + 1)
		}
		return response as T;
	}

	/**
	 * The block a redirected op is coordinated on — the block `RepoService.deriveBlockKey` redirected
	 * it by, and so the block its coordinator hint belongs to.
	 */
	private coordinatedBlockId(ops: RepoMessage['operations']): BlockId | undefined {
		const op = ops[0];
		if (!op) return undefined;
		if ('get' in op) return op.get.blockIds[0];
		// Key on a real block id the pend touches, NOT a structural transforms field
		// name ('inserts'/'updates'/'deletes'); see RepoService.deriveBlockKey.
		if ('pend' in op) return blockIdsForTransforms(op.pend.transforms)[0];
		// Anchor on blockIds[0] (where CoordinatorRepo.commit runs consensus +
		// verifyResponsibility), NOT tailId — they differ for a non-tail batch.
		if ('commit' in op) return op.commit.blockIds[0];
		if ('cancel' in op) return op.cancel.actionRef.blockIds[0];
		return undefined;
	}

}
