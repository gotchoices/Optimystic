import debug from 'debug'

const BASE_NAMESPACE = 'optimystic:quereus-plugin'

export function createLogger(subNamespace: string): debug.Debugger {
	return debug(`${BASE_NAMESPACE}:${subNamespace}`)
}

/**
 * The `<rev>@<actionId>` token the three cross-node trace lines
 * (`commit:collections`, `index:tree-open`, `index:seek`) print wherever they report a
 * collection's committed revision.
 *
 * Why both halves. A revision number is counted per collection and means nothing on its
 * own, so two nodes reporting the same collection id at the same revision are
 * indistinguishable between "one collection and one node is behind" and "two
 * separately-built collections under one id, each counting from 1". The action id — the
 * id of the action that produced that revision — settles it: same id means one lineage,
 * different ids at the same revision means two. It is the ONE thing in these lines that
 * is comparable across collections and across nodes. `docs/debugging.md`
 * (§ "Comparing action ids") is the operator-facing statement of the same thing.
 *
 * Both halves keep their existing vocabulary, so an operator's reading of the words does
 * not change: `none` is "asked, and there is none", `unknown` is "the source could not be
 * asked" (a test double that omits the accessor). `<rev>@none` — a real revision with no
 * lineage marker — is legitimate and has two causes, both spelled out on
 * `Collection.committedActionId`.
 *
 * PARSING. Split the token on its LAST `@`: the revision half is a number or one of those
 * two words and never contains `@`, and an action id cannot either, because this function
 * escapes it. Everything an action id could carry that would confuse a reader of these
 * lines is escaped `%XX` here rather than trusted — whitespace (a space would split one
 * trace field into two), `@` (the token's own separator), `,` (the `revs=` field's pair
 * separator) and `%` itself (so the escaping stays injective and two nodes' tokens
 * compare exactly). `:` deliberately survives: db-core stamps session-mode action ids as
 * `tx:<hash>`, so a colon is the ORDINARY shape of this half, and the `revs=` pair rule
 * is written to tolerate it (see `TransactionBridge.logCommitCollections`). Same
 * reasoning, and the same `%XX` vocabulary, as `printableSeekKey`.
 */
export function revisionToken(
	rev: number | 'none' | 'unknown',
	actionId: string | 'none' | 'unknown',
): string {
	return `${rev}@${actionId.replace(/[\s%@,]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)}`
}
