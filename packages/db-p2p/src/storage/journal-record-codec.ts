import type { ActionId, BlockId } from '@optimystic/db-core';
import type { BatchEntry, StoreKey } from './batch-backend.js';
import type { JournalRecord } from './journal-batch-backend.js';
import { decodeJson, encodeJson } from './raw-store-codec.js';

/**
 * One journal record as bytes, for a `JournalStore` over an engine that stores bytes (LevelDB);
 * IndexedDB stores a record by structured clone and needs none of this.
 *
 * Format, every integer big-endian: a format-version byte, the `seq` as 8 bytes, an entry count as
 * 4 bytes, then per entry the UTF-8 JSON of its `StoreKey` behind a 4-byte length, one flag byte
 * (1 for a put, 0 for a delete), and for a put the value behind a 4-byte length.
 *
 * Decoding is strict: an unknown version, a flag that is neither, a key that is not a `StoreKey`,
 * a length that runs past the end, or bytes left over after the last entry all throw
 * {@link JournalRecordDecodeError}. A store treats a record it cannot decode as missing, which
 * recovery handles as a gap — a damaged record is a lost group, never a partly applied one.
 */
export const JOURNAL_RECORD_FORMAT_VERSION = 1;

const FLAG_DELETE = 0;
const FLAG_PUT = 1;
const HEAD_BYTES = 1 + 8 + 4;
const TWO_TO_32 = 2 ** 32;

/** Thrown by {@link decodeJournalRecord}: the bytes are not a record this build can read. */
export class JournalRecordDecodeError extends Error {
	constructor(reason: string) {
		super(`journal record cannot be decoded: ${reason}`);
		this.name = 'JournalRecordDecodeError';
	}
}

export function encodeJournalRecord(record: JournalRecord): Uint8Array {
	if (!Number.isSafeInteger(record.seq) || record.seq < 1) {
		throw new RangeError(`a journal record's seq must be a positive safe integer, got ${record.seq}`);
	}
	const encoded = record.entries.map(entry => ({ key: encodeJson(entry.key), value: entry.value }));
	const length = encoded.reduce((total, { key, value }) => total + 4 + key.length + 1 + (value ? 4 + value.length : 0), HEAD_BYTES);
	const out = new Uint8Array(length);
	const view = new DataView(out.buffer);
	out[0] = JOURNAL_RECORD_FORMAT_VERSION;
	view.setUint32(1, Math.floor(record.seq / TWO_TO_32));
	view.setUint32(5, record.seq % TWO_TO_32);
	view.setUint32(9, encoded.length);
	let offset = HEAD_BYTES;
	for (const { key, value } of encoded) {
		view.setUint32(offset, key.length);
		out.set(key, offset + 4);
		offset += 4 + key.length;
		if (value === undefined) {
			out[offset] = FLAG_DELETE;
			offset += 1;
		} else {
			out[offset] = FLAG_PUT;
			view.setUint32(offset + 1, value.length);
			out.set(value, offset + 5);
			offset += 5 + value.length;
		}
	}
	return out;
}

export function decodeJournalRecord(bytes: Uint8Array): JournalRecord {
	const reader = new Reader(bytes);
	const version = reader.u8();
	if (version !== JOURNAL_RECORD_FORMAT_VERSION) {
		throw new JournalRecordDecodeError(`unknown format version ${version}`);
	}
	const seq = reader.u32() * TWO_TO_32 + reader.u32();
	if (!Number.isSafeInteger(seq) || seq < 1) {
		throw new JournalRecordDecodeError(`seq ${seq} is not a positive safe integer`);
	}
	const count = reader.u32();
	const entries: BatchEntry[] = [];
	for (let i = 0; i < count; i++) {
		const key = decodeStoreKey(reader.bytes(reader.u32()));
		const flag = reader.u8();
		if (flag === FLAG_PUT) {
			entries.push({ key, value: reader.bytes(reader.u32()) });
		} else if (flag === FLAG_DELETE) {
			entries.push({ key });
		} else {
			throw new JournalRecordDecodeError(`entry ${i} has flag ${flag}, which is neither a put nor a delete`);
		}
	}
	reader.end();
	return { seq, entries };
}

/** A cursor over the record's bytes that throws {@link JournalRecordDecodeError} rather than read past the end. */
class Reader {
	private readonly view: DataView;
	private offset = 0;

	constructor(private readonly source: Uint8Array) {
		this.view = new DataView(source.buffer, source.byteOffset, source.byteLength);
	}

	u8(): number {
		this.need(1);
		return this.source[this.offset++]!;
	}

	u32(): number {
		this.need(4);
		const value = this.view.getUint32(this.offset);
		this.offset += 4;
		return value;
	}

	/** The next `length` bytes, copied, so a record's values never alias the buffer they were read from. */
	bytes(length: number): Uint8Array {
		this.need(length);
		const out = this.source.slice(this.offset, this.offset + length);
		this.offset += length;
		return out;
	}

	end(): void {
		if (this.offset !== this.source.length) {
			throw new JournalRecordDecodeError(`${this.source.length - this.offset} byte(s) left after the last entry`);
		}
	}

	private need(length: number): void {
		if (this.source.length - this.offset < length) {
			throw new JournalRecordDecodeError(`a length of ${length} at byte ${this.offset} runs past the end of ${this.source.length} bytes`);
		}
	}
}

/** The JSON of a `StoreKey` back into one, keeping only the fields the key's store has. */
function decodeStoreKey(bytes: Uint8Array): StoreKey {
	const parsed = parseKeyJson(bytes);
	if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { blockId?: unknown }).blockId !== 'string') {
		throw new JournalRecordDecodeError('a store key is not an object with a string blockId');
	}
	const { store, blockId, rev, actionId } = parsed as { store?: unknown; blockId: string; rev?: unknown; actionId?: unknown };
	switch (store) {
		case 'metadata':
			return { store, blockId: blockId as BlockId };
		case 'revisions':
		case 'proofs':
			if (!Number.isInteger(rev)) throw new JournalRecordDecodeError(`a ${store} key's rev is not an integer`);
			return { store, blockId: blockId as BlockId, rev: rev as number };
		case 'pending':
		case 'transactions':
		case 'materialized':
			if (typeof actionId !== 'string') throw new JournalRecordDecodeError(`a ${store} key's actionId is not a string`);
			return { store, blockId: blockId as BlockId, actionId: actionId as ActionId };
		default:
			throw new JournalRecordDecodeError(`a store key names no store (${String(store)})`);
	}
}

function parseKeyJson(bytes: Uint8Array): unknown {
	try {
		return decodeJson<unknown>(bytes);
	} catch (err) {
		if (err instanceof SyntaxError) throw new JournalRecordDecodeError(`a store key is not JSON (${err.message})`);
		throw err;
	}
}
