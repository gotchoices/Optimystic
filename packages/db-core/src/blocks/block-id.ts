import type { BlockId } from "./structs.js";

/**
 * The longest a stored identifier — a block id, an action id — may be, in UTF-16 code units. Shared
 * by {@link isValidBlockId} and `isValidActionId` so one bound covers every name a backend turns
 * into a path.
 *
 * The binding constraint is the filesystem backend's write-ahead log: a record holds its path as a
 * 16-bit-length-prefixed UTF-8 string, so a path over 65535 bytes cannot be encoded and the encode
 * throws — on the live commit path, where a throw latches the store (the flush contract's rule 5 at
 * `RawStoreDriver.flush`). The headroom: a UTF-16 code unit is at most 3 UTF-8 bytes, so 1024 units
 * is at most 3072 bytes; the longest path combines a block id, an action id and about a dozen bytes
 * of fixed segments (`/pend/`, `.json`), so at most ~6160 bytes — an order of magnitude under the
 * cap. And it is orders of magnitude ABOVE anything real: a `tx:<base64url-SHA-256>` action id is
 * about 50 characters and `default/app/Ledger` is 18.
 */
export const MAX_STORED_ID_LENGTH = 1024;

/**
 * A block id names a location in whatever store holds the block, and one backend — the filesystem
 * one — uses it RAW as a relative path (`default/app/Ledger` lives in `<store>/default/app/Ledger/`).
 * Block ids are chosen by whoever originates a write, including a peer on the other side of the
 * network, so a store that trusts one unchecked can be made to write outside itself. This is the one
 * place the shape of a block id is decided; every path builder below the enforcement point (see
 * {@link assertValidBlockId}) is free to trust its input.
 *
 * A block id is valid when, and only when:
 *
 * - it is a non-empty string of at most {@link MAX_STORED_ID_LENGTH} code units;
 * - it contains no C0 control character and no `\u007f` — a NUL makes `fs` throw, and the rest have
 *   no business in a name;
 * - it contains no backslash: on win32 `\` is a path separator, so a `/`-split check alone would
 *   miss `a\..\..\b`, which resolves to `C:\b`;
 * - it does not start with a Windows drive prefix (`C:`): `C:/elsewhere` leaves the store, and
 *   `C:elsewhere` resolves INSIDE it on win32 (`<store>\elsewhere`) while naming a literal directory
 *   `C:elsewhere` on POSIX — one id meaning two different places;
 * - every `/`-separated segment is non-empty and is neither `.` nor `..`. That rejects `..` and
 *   `a/../..` (which escape), a leading `/` and a trailing `/`, and `a//b`, `./a`, `a/./b` — those
 *   last resolve inside the store but ALIAS another id's directory, so two ids would share one
 *   location.
 *
 * `a..b` is a fine id: only a whole segment of dots is refused. So is `default/app/Ledger` — nested,
 * human-named collection ids are the deliberate case the rule must keep working.
 *
 * NOTE: a segment ending in a space or a dot is accepted, and Win32 path handling strips those from
 * the last component of a path — so `a ` and `a` name one directory to most Windows tooling. Node's
 * own `fs` does NOT alias them (measured on Windows 10 / Node 25: writing `a ` leaves `a` ENOENT,
 * because libuv opens paths in the `\\?\` long-path form, which bypasses that normalization), so
 * this is neither an escape nor an aliasing bug in the store — it is a name that Explorer and
 * non-long-path-aware tools cannot address. No block id in the repository has one. If ids ever come
 * from a source that can produce trailing spaces or dots, reject those segments so a store stays
 * administrable by hand.
 *
 * NOTE: a `:` anywhere past the first character is accepted, and on win32 it is an NTFS
 * alternate-data-stream separator. It fails noisily rather than escaping: the block-store layout
 * creates a block's directory before writing into it, and `mkdir` of a colon-bearing directory fails
 * ENOENT (measured; a `writeFile` to such a path would instead succeed as a stream on the file named
 * by the prefix). No block id in the repository contains one. The tightening that would retire it is
 * a strict charset — each segment `[A-Za-z0-9._-]+`, which every id in the repository already passes
 * — not adopted here because collection ids are chosen by application code at runtime and nothing
 * promises they stay inside that class.
 */
export function isValidBlockId(id: string): boolean {
	// A block id can arrive from a peer, so the type is not evidence that this is a string.
	if (typeof id !== 'string' || id.length === 0 || id.length > MAX_STORED_ID_LENGTH) return false;
	if (FORBIDDEN_CHARACTERS.test(id)) return false;
	if (WINDOWS_DRIVE_PREFIX.test(id)) return false;
	return id.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** C0 controls, `\u007f`, and the backslash win32 reads as a path separator. */
const FORBIDDEN_CHARACTERS = /[\u0000-\u001f\u007f\\]/;

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/;

/**
 * Throw unless `id` satisfies {@link isValidBlockId}. Called by `KvRawStorage` on every block id it
 * is given, reads included, before the id reaches a driver — so a refusal rejects that one call and
 * leaves the store usable, where a throw from inside a write group would latch the whole store
 * failed (the flush contract's rule 5, `RawStoreDriver.flush`).
 */
export function assertValidBlockId(id: BlockId): void {
	if (!isValidBlockId(id)) throw new InvalidBlockIdError(id);
}

/** A block id that does not name a location inside the store that was asked to hold it. */
export class InvalidBlockIdError extends Error {
	constructor(readonly blockId: unknown) {
		super(`block id ${JSON.stringify(blockId)} does not name a location inside the store; see isValidBlockId for the rule`);
		this.name = 'InvalidBlockIdError';
	}
}
