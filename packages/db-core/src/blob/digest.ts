import { sha256 } from '@noble/hashes/sha2.js';
import { equals } from 'uint8arrays/equals';
import { fromString } from 'uint8arrays/from-string';
import { createLogger } from '../logger.js';
import { BlobDigestError } from './errors.js';

const log = createLogger('blob');

/** SHA-256: bytes in, 32 bytes out. */
export type BlobDigest = (bytes: Uint8Array) => Promise<Uint8Array>;

/** The one method of WebCrypto's `SubtleCrypto` a blob digest uses. */
export interface SubtleDigest {
	digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
}

const SHA256_BYTES = 32;

let memoized: BlobDigest | undefined;

/** crypto.subtle where it exists, else @noble/hashes. Memoized: the same function on every call. */
// NOTE: a host's JavaScript `crypto.subtle` polyfill (the React Native setup in db-p2p's readme asks
// for one) is taken as native, so such a phone hashes at JavaScript speed without the fallback line;
// if that shows up as slow blob puts, have the host install a native digest through the port.
export function defaultBlobDigest(): BlobDigest {
	memoized ??= selectBlobDigest((globalThis as { crypto?: { subtle?: SubtleDigest } }).crypto?.subtle);
	return memoized;
}

/** Exported from this module for tests only (not from blob/index.ts). */
export function selectBlobDigest(subtle: SubtleDigest | undefined): BlobDigest {
	if (subtle !== undefined) {
		return async bytes => new Uint8Array(await subtle.digest('SHA-256', bytes));
	}
	// Hermes has no crypto.subtle; this is the line that explains a slow phone (pure JavaScript
	// SHA-256 measured 19 s per MB on an older one, docs/blobs.md §References and pieces).
	log('blob:digest-fallback no native SHA-256 (crypto.subtle) found; hashing blob pieces in JavaScript, which is slow on phones — a host can supply its own digest');
	return async bytes => sha256(bytes);
}

interface KnownAnswer {
	readonly label: string;
	readonly input: Uint8Array;
	readonly digest: Uint8Array;
}

/** FIPS 180-2 examples; the 56-byte one spans two compression blocks. */
const KNOWN_ANSWERS: readonly KnownAnswer[] = [
	knownAnswer('the empty input', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
	knownAnswer('"abc"', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'),
	knownAnswer('the 56-byte FIPS 180-2 message', 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'),
];

/**
 * Runs the known answers; resolves to `digest` itself, or rejects with BlobDigestError naming the
 * first wrong answer. A host calls it when installing its own digest; the default is not re-checked.
 */
export async function checkBlobDigest(digest: BlobDigest): Promise<BlobDigest> {
	for (const answer of KNOWN_ANSWERS) {
		const problem = wrongAnswer(await answerTo(digest, answer), answer);
		if (problem !== undefined) {
			throw new BlobDigestError(`${problem} for ${answer.label}`);
		}
	}
	return digest;
}

async function answerTo(digest: BlobDigest, answer: KnownAnswer): Promise<unknown> {
	try {
		// A fresh copy each time, so a digest that writes to its input cannot spoil a later check.
		return await digest(answer.input.slice());
	} catch (cause) {
		throw new BlobDigestError(`threw for ${answer.label}`, { cause });
	}
}

function wrongAnswer(result: unknown, answer: KnownAnswer): string | undefined {
	if (!(result instanceof Uint8Array)) {
		return 'did not return a Uint8Array';
	}
	if (result.byteLength !== SHA256_BYTES) {
		return `returned ${result.byteLength} bytes, not ${SHA256_BYTES}`;
	}
	return equals(result, answer.digest) ? undefined : 'returned the wrong digest';
}

function knownAnswer(label: string, input: string, hex: string): KnownAnswer {
	return { label, input: new TextEncoder().encode(input), digest: fromString(hex, 'base16') };
}
