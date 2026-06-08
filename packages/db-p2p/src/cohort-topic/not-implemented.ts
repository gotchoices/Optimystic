/**
 * The FRET + libp2p wiring for these cohort-topic adapters is fleshed out by the
 * `cohort-topic-core-module-fret-integration` ticket. This package currently lands the
 * interfaces + compiling stubs (`cohort-topic-package-layering`) so downstream db-core
 * substrate tickets can build and unit-test against the ports without FRET present.
 */
export function notWiredToFret(adapter: string, method: string): never {
	throw new Error(
		`CohortTopic ${adapter}.${method} is not yet wired to FRET ` +
		`(cohort-topic-core-module-fret-integration)`
	);
}
