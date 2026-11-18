/**
 * Reading and writing the frames of a blob stream over a libp2p 3 stream, under a
 * {@link ProgressDeadline} (docs/blobs.md §Moving pieces between machines).
 *
 * Every frame is an unsigned varint length followed by that many bytes, the `it-length-prefixed`
 * format every other db-p2p protocol uses. Unlike those protocols a blob stream carries several frames
 * per stream, and a piece frame is raw bytes, so neither `ProtocolClient` nor the single-frame helpers
 * in `cohort-topic/stream-util.ts` fit it.
 *
 * Imports here are pure or type-only: this module is reachable from the react-native entry (`src/rn.ts`).
 */

import type { Stream } from '@libp2p/interface';
import type { Uint8ArrayList } from 'uint8arraylist';
import * as lp from 'it-length-prefixed';
import { MAX_BLOB_HEADER_BYTES, MAX_BLOB_PIECE_FRAME_BYTES } from '../protocol-limits.js';
import { BlobProtocolError } from './blob-protocol.js';
import type { ProgressDeadline } from './progress-deadline.js';

/** What blob frames are read from: a libp2p 3 stream, or any iterable of the chunks one yields. */
export type BlobFrameSource = AsyncIterable<Uint8Array | Uint8ArrayList>;

/** What blob frames are written to. */
export type BlobFrameSink = Pick<Stream, 'send' | 'onDrain'>;

/**
 * The frames arriving on `stream`, each yielded as soon as it is complete. The first frame is a
 * header, capped at `MAX_BLOB_HEADER_BYTES`; every later one a piece, capped at
 * `MAX_BLOB_PIECE_FRAME_BYTES`. A frame over its position's cap is refused at its length prefix, with
 * {@link BlobProtocolError}, so the reader never waits for its bytes; so is a stream that ends inside
 * a frame. Every chunk that arrives touches `deadline`. A frame is taken with
 * `Uint8ArrayList.subarray()`, which copies only when the frame spans chunks.
 *
 * **Read the header and the pieces from this ONE iterator, by calling `next()` on it.** Never
 * `for await … break` and then iterate again: the decoder holds the bytes it has read past the frame it
 * yielded, and leaving a `for await` loop calls `return()` down the chain, which ends the read.
 *
 * Throws the stream's own error (a reset, or the reason the stream was aborted with) unchanged; the
 * caller aborts the stream when `deadline` fires, so a stall reaches it that way.
 *
 * NOTE: nothing bounds what libp2p queues below this reader. The stream's async iterator pushes every
 * arriving chunk into an unbounded queue and never pauses, and yamux keeps granting receive window as
 * data arrives. The bound is the request: a `get` names at most `MAX_BLOB_GET_PIECES` (16) pieces, so
 * one stream delivers at most 16 frames — 16 MiB queued per stream at worst, 4 MiB for pieces this
 * design writes (256 KiB). `stream.pause()` was rejected as the bound: while paused, libp2p buffers
 * incoming data up to `maxReadBufferLength` (4 MiB by default) and then resets the stream, and a yamux
 * window grown past 4 MiB can exceed that, which would reset honest transfers of 1 MiB pieces. Revisit
 * (lower `MAX_BLOB_GET_PIECES`, or bound a get by its pieces' declared sizes) if memory on a phone shows it.
 */
export function readBlobFrames(stream: BlobFrameSource, deadline: Pick<ProgressDeadline, 'touch'>, peer: string): AsyncIterator<Uint8Array> {
	let framesStarted = 0;
	const decoded = lp.decode(touchingEachChunk(stream, deadline), {
		maxDataLength: MAX_BLOB_PIECE_FRAME_BYTES,
		onLength: (length: number) => {
			const cap = framesStarted === 0 ? MAX_BLOB_HEADER_BYTES : MAX_BLOB_PIECE_FRAME_BYTES;
			if (length > cap) {
				throw new BlobProtocolError(peer, `frame ${framesStarted} declares ${length} bytes, over its cap of ${cap}`);
			}
			framesStarted++;
		},
	});
	return framesOf(decoded, peer);
}

/**
 * Send `payload` as one frame, refusing a payload over `maxDataLength`, and wait for the transport to
 * drain when it reports its buffer full. Returns the frame's byte length, prefix included.
 *
 * `send` returning `false` means the transport's buffer is full, so the sender waits for `onDrain`
 * before writing again, cut off by `deadline`: a receiver whose transport stops accepting bytes makes
 * the sender give up after one timeout, rejecting with the deadline's `BlobTransferStalledError`,
 * instead of queueing without bound. This is the rule the first `NOTE:` in
 * `cohort-topic/stream-util.ts` says a writer of several frames on one stream must follow.
 */
export async function sendBlobFrame(stream: BlobFrameSink, payload: Uint8Array, deadline: Pick<ProgressDeadline, 'touch' | 'signal'>, maxDataLength: number): Promise<number> {
	// Prefix and payload, without copying the payload.
	const frame = lp.encode.single(payload, { maxDataLength });
	const accepted = stream.send(frame);
	deadline.touch();
	if (!accepted) {
		await stream.onDrain({ signal: deadline.signal });
		deadline.touch();
	}
	return frame.byteLength;
}

/** Close the write side of `stream`, cut off by `deadline`: `close` waits for unsent bytes to drain. */
export async function closeBlobStream(stream: Pick<Stream, 'close'>, deadline: Pick<ProgressDeadline, 'signal'>): Promise<void> {
	await stream.close({ signal: deadline.signal });
}

async function* touchingEachChunk(source: BlobFrameSource, deadline: Pick<ProgressDeadline, 'touch'>): AsyncGenerator<Uint8Array | Uint8ArrayList> {
	for await (const chunk of source) {
		deadline.touch();
		yield chunk;
	}
}

async function* framesOf(decoded: AsyncIterable<Uint8ArrayList>, peer: string): AsyncGenerator<Uint8Array> {
	try {
		for await (const frame of decoded) {
			yield frame.subarray();
		}
	} catch (err) {
		throw asProtocolError(err, peer);
	}
}

/**
 * The decoder's own framing faults, by the `code` `it-length-prefixed` gives each (its error classes
 * are not exported): reported as {@link BlobProtocolError}, so a caller meets one class for every way
 * the other end broke the framing. Anything else — a reset, an abort, an `onLength` refusal — passes
 * through unchanged.
 */
const DECODER_FAULTS: ReadonlyMap<string, string> = new Map([
	['ERR_UNEXPECTED_EOF', 'stream ended inside a frame'],
	['ERR_MSG_DATA_TOO_LONG', `frame over the largest frame of ${MAX_BLOB_PIECE_FRAME_BYTES} bytes`],
	['ERR_MSG_LENGTH_TOO_LONG', 'frame length prefix too long'],
	['ERR_INVALID_MSG_LENGTH', 'invalid frame length'],
]);

function asProtocolError(err: unknown, peer: string): unknown {
	const code = (err as { code?: unknown } | null)?.code;
	const fault = typeof code === 'string' ? DECODER_FAULTS.get(code) : undefined;
	return fault === undefined ? err : new BlobProtocolError(peer, fault, { cause: err });
}
