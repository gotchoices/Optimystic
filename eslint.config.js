import tseslint from 'typescript-eslint';

// Flat config (ESLint 9). Repo is ESM + yarn 4 workspaces + TypeScript throughout.
// `eslint .` walks the tree from root, so this single config covers every workspace —
// no per-package fan-out (unlike the build:/test: scripts in package.json).
//
// SCOPE: this config is deliberately narrow — the only enforced rule is `no-console`,
// the gate this config was stood up for (route stray library logging through each
// package's `debug` logger instead of printing unconditionally). The full
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
