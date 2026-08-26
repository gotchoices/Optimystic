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
 * is comparable across collections and across nodes.
 *
 * Both halves keep their existing vocabulary, so an operator's reading of the words does
 * not change: `none` is "asked, and there is none" (an invented collection has no
 * committed revision and no lineage marker), `unknown` is "the source could not be asked"
 * (a test double that omits the accessor). A collection can legitimately hold a real
 * revision whose action id has already aged out of its bounded `committed` list, which
 * prints as `<rev>@none`.
 *
 * Split on the FIRST `@`: the revision half is a number or one of those two words and can
 * never contain `@`, while an action id is an opaque string. Whitespace inside an action
 * id is escaped here rather than trusted, because a single space would split one trace
 * field into two and make the whole line unparseable — the same reason index keys are
 * escaped by `printableSeekKey`.
 */
export function revisionToken(
	rev: number | 'none' | 'unknown',
	actionId: string | 'none' | 'unknown',
): string {
	return `${rev}@${actionId.replace(/\s/g, c => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}`
}
