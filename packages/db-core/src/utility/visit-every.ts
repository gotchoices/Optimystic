/**
 * Visit every item in turn, letting no throw stop the rest, and throw the FIRST error once every
 * item has been visited. Sequential on purpose: each visit must finish before the next starts.
 *
 * For a round of independent per-collection steps — a rollback's restores, a commit's unwinding of
 * its failed participants — where stopping at the first throw would leave every later collection
 * untouched, and silently: the caller sees one error and has no way to tell which collections it
 * reached. Each step being independent (its own instance, its own state) is what makes the first
 * error the right one to report; a step whose failure should change how the next is handled does
 * not belong in this loop. `TransactionCoordinator.refreshBetweenAttempts` is the same idiom with
 * a per-error classification this helper does not carry.
 */
export async function visitEveryThenThrow<T>(items: Iterable<T>, visit: (item: T) => Promise<void>): Promise<void> {
	let first: { error: unknown } | undefined;
	for (const item of items) {
		try {
			await visit(item);
		} catch (error) {
			first ??= { error };
		}
	}
	if (first !== undefined) {
		throw first.error;
	}
}
