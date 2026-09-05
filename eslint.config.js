import tseslint from 'typescript-eslint';

// Every diagnostic log channel in this repo has to be rooted in `optimystic:*` — that is the
// prefix `docs/debugging.md` tells operators to put in `DEBUG`, and the prefix every package's
// `createLogger` (in its own `src/logger.ts`) prepends. Two nearby alternatives silently produce
// a namespace outside that tree, which is then invisible to the documented filters:
const NO_LIBP2P_COMPONENT_LOGGER = {
	// libp2p services are handed a `components.logger`, so `components.logger.forComponent('x')`
	// is the factory closest to hand — and it yields the bare namespace `x`, not `optimystic:*`.
	//
	// NOTE: this selector matches on the property name alone, so an unrelated future method
	// called `forComponent` on some other object would also be flagged. Nothing like that exists
	// today; the message below names the actual concern so such a hit is diagnosable rather than
	// mysterious (the fix in that case is to narrow the selector, not to widen the exemptions).
	selector: "CallExpression[callee.property.name='forComponent']",
	message: "libp2p's component logger creates a namespace outside `optimystic:*`, which DEBUG=optimystic:db-p2p:* never matches. Use this package's `createLogger` from its src/logger.ts instead.",
};
const NO_DIRECT_DEBUG_IMPORT = {
	selector: "ImportDeclaration[source.value='debug']",
	message: 'Import `createLogger` from your package\'s src/logger.ts rather than constructing `debug` channels directly, so every namespace is rooted in the documented tree (docs/debugging.md).',
};

// Flat config (ESLint 9). Repo is ESM + yarn 4 workspaces + TypeScript throughout.
// `eslint .` walks the tree from root, so this single config covers every workspace —
// no per-package fan-out (unlike the build:/test: scripts in package.json).
//
// SCOPE: this config is deliberately narrow — it enforces exactly two things, both about
// logging. `no-console` is the gate this config was stood up for (route stray library
// logging through each package's `debug` logger instead of printing unconditionally), and
// `no-restricted-syntax` is the follow-on gate that says *which* logger: the channel must
// come from the package's own `createLogger`, never from libp2p's component logger or a
// hand-rolled `debug(...)` namespace. The full
// `typescript-eslint`/`@eslint/js` recommended presets are intentionally NOT enabled:
// the codebase leans on `any` and untyped globals in many places, and turning the
// recommended rulesets on would flood `yarn lint` red with pre-existing, unrelated
// style violations and mask the no-console gate.
//
// NOTE: tightening lint beyond no-console is future work. To enable the recommended
// presets you will also need a `globals` languageOptions block (for console/process/
// setTimeout/etc.) and a cleanup pass over the existing `any`/no-undef violations.
// See tickets: this landed from console-to-debug-and-eslint.

export default tseslint.config(
	{
		ignores: [
			'**/dist/**',
			'**/node_modules/**',
			'**/*.tsbuildinfo',
			'.yarn/**',
			'tess/**',
		],
	},
	{
		// The source tree already carries speculative `// eslint-disable @typescript-eslint/...`
		// comments (no-explicit-any, no-unused-vars, explicit-module-boundary-types) predating
		// this config. Register the plugin so those rule names resolve — otherwise ESLint fails
		// hard with "Definition for rule ... was not found". The rules stay OFF (see SCOPE note);
		// registering only makes the names known.
		//
		// NOTE: reportUnusedDisableDirectives is silenced because those pre-existing disable
		// comments are dormant while the rules are off; without this, every one of them warns.
		// Re-enable it (and drop this line) when the recommended rulesets are turned on.
		linterOptions: { reportUnusedDisableDirectives: 'off' },
	},
	{
		// TypeScript parser for all .ts sources (no type-info / project graph needed —
		// no-console is a syntactic rule, so we keep the non-type-checked path for speed).
		files: ['**/*.ts'],
		plugins: { '@typescript-eslint': tseslint.plugin },
		languageOptions: {
			parser: tseslint.parser,
		},
	},
	{
		// Library code must never print unconditionally — route through the `debug` logger.
		files: ['packages/*/src/**/*.ts'],
		rules: { 'no-console': 'error' },
	},
	{
		// Library code creates log channels ONLY through its own package's `createLogger`.
		// Scoped to `packages/*/src/**` (not just db-p2p) so a future package that embeds libp2p
		// inherits the guard. `test/` is deliberately excluded: specs legitimately build stub
		// objects with a `forComponent` property to satisfy libp2p-shaped interfaces, and
		// `test/support/capture-log.ts` legitimately imports `debug` — that is its whole job.
		files: ['packages/*/src/**/*.ts'],
		rules: { 'no-restricted-syntax': ['error', NO_LIBP2P_COMPONENT_LOGGER, NO_DIRECT_DEBUG_IMPORT] },
	},
	{
		// The sanctioned `debug` import sites: the seven per-package `createLogger` factories
		// (they ARE the chokepoint the rule funnels everything through), and reference-peer's
		// CLI, which is an executable entry point rather than library code — already exempt from
		// `no-console` for the same reason.
		//
		// Re-declare the rule with only the `forComponent` selector rather than switching it
		// `'off'`: flat config replaces the whole rule config, and these files have no business
		// reaching for libp2p's component logger either.
		files: ['packages/*/src/logger.ts', 'packages/reference-peer/src/cli.ts'],
		rules: { 'no-restricted-syntax': ['error', NO_LIBP2P_COMPONENT_LOGGER] },
	},
	{
		// Intentional terminal output — CLI, entry scripts, demo, tooling, tests.
		files: [
			'packages/reference-peer/src/cli.ts',
			'packages/reference-peer/src/mesh.ts',
			'packages/demo/src/**',
			'scripts/**',
			'**/test/**',
			'**/*.spec.ts',
		],
		rules: { 'no-console': 'off' },
	},
);
