/**
 * The owner labels this plugin holds blob pins under (docs/blobs.md §SQL), and the one parser that
 * reads them back. A pin's owner is an opaque string to the blob store (`BlobHold` in
 * `packages/db-p2p/src/blob/blob-record.ts`); these are printable on purpose, because they turn up
 * in blob records and in logs.
 *
 * This module is the only place in the plugin a label is built or read. Three shapes:
 *
 *  - `sql/<stampId>/ref/<scope>` — held for a transaction's reference committed into `scope`, a
 *    reference tree's collection id.
 *  - `sql/<stampId>/put` — held for a blob `put` made while that transaction was open.
 *  - `sql-unstaged/<putAtMs>` — held for a `put` made outside any transaction.
 *
 * Why they split without a parser: a `StampId()` is base64url (`generateStampId` in
 * `packages/quereus-plugin-optimystic/src/util/generate-stamp-id.ts`), so it carries no `/`, and a
 * scope is URI-encoded here, so neither does it. Putting the SCOPE in the label rather than in the
 * offline journal is what makes the blob records themselves the durable, per-machine record of
 * which transaction owes which pin under which scope: a later settle or a restart reconciliation
 * needs nothing added to `JournalEntryRecord` (`packages/db-core/src/offline/journal.ts`) and never
 * decodes a journaled segment. One reference committed into two tables in one transaction is two
 * pins.
 */

/** Every transaction-owned label starts with this; `listPins` over it enumerates them all. */
export const TRANSACTION_PIN_PREFIX = 'sql/';
/** Every label of a put made outside a transaction starts with this. */
export const UNSTAGED_PIN_PREFIX = 'sql-unstaged/';

/** A pin held for a transaction's reference committed into `scope` (a reference tree's collection id). */
export function transactionReferencePinLabel(stampId: string, scope: string): string {
	return `${TRANSACTION_PIN_PREFIX}${stampId}/ref/${encodeURIComponent(scope)}`;
}

/** A pin held for a blob `put` made while the transaction `stampId` was open. */
export function transactionPutPinLabel(stampId: string): string {
	return `${TRANSACTION_PIN_PREFIX}${stampId}/put`;
}

/** A pin held for a blob `put` made outside any transaction, at `putAtMs`. */
export function unstagedPinLabel(putAtMs: number): string {
	return `${UNSTAGED_PIN_PREFIX}${putAtMs}`;
}

/** Everything one transaction holds: the prefix `listPins` enumerates its pins by. */
export function transactionPinPrefix(stampId: string): string {
	return `${TRANSACTION_PIN_PREFIX}${stampId}/`;
}

/** What {@link parsePinLabel} read out of one of this plugin's labels. */
export type ParsedPinLabel =
	| { kind: 'reference'; stampId: string; scope: string }
	| { kind: 'put'; stampId: string }
	| { kind: 'unstaged'; putAtMs: number };

/**
 * Read a label back, or `undefined` for one this plugin did not write — an application's own owner,
 * or the store's `default`. Also `undefined` for a label that carries this plugin's prefix but not
 * one of its three shapes: whatever wrote it, this plugin cannot say what it means, and treating it
 * as a pin of a known kind would release somebody else's hold.
 */
export function parsePinLabel(label: string): ParsedPinLabel | undefined {
	if (label.startsWith(UNSTAGED_PIN_PREFIX)) {
		const when = label.slice(UNSTAGED_PIN_PREFIX.length);
		// Digits only, which is what `${Date.now()}` is: `Number` would otherwise read the empty
		// string as 0 and a padded one as its number, inventing a time nothing here ever wrote.
		return /^\d+$/.test(when) ? { kind: 'unstaged', putAtMs: Number(when) } : undefined;
	}
	if (!label.startsWith(TRANSACTION_PIN_PREFIX)) return undefined;
	// Past the prefix: `<stampId>/put` or `<stampId>/ref/<scope>`. A stamp id contains no `/` and the
	// scope is encoded, so exactly two segments or exactly three — anything else is not ours.
	const parts = label.slice(TRANSACTION_PIN_PREFIX.length).split('/');
	const [stampId, kind, scope] = parts;
	if (stampId === undefined || stampId === '') return undefined;
	if (parts.length === 2 && kind === 'put') return { kind: 'put', stampId };
	if (parts.length === 3 && kind === 'ref' && scope !== undefined && scope !== '') {
		return { kind: 'reference', stampId, scope: decodeScope(scope) };
	}
	return undefined;
}

/** A scope that does not decode is returned as written: the label is still this plugin's, and the
 * raw text is what a caller can compare against the label it would build. */
function decodeScope(encoded: string): string {
	try {
		return decodeURIComponent(encoded);
	} catch {
		return encoded;
	}
}
