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
// React Native is a first-class target, and Metro's Babel preset (babel-preset-expo) does not
// transform ES2022 `static { }` blocks: one in library source fails the whole app bundle at load.
// This rule is instant feedback on that one known construct. `yarn check:rn` is the backstop for the
// whole class: it bundles with Metro and compiles with legacy Hermes, so any syntax either rejects
// fails there, whether or not a lint rule names it.
const NO_STATIC_BLOCK = {
	selector: 'StaticBlock',
	message: 'Class static blocks break React Native bundling (Metro/babel-preset-expo cannot transform them). Use a static field initializer instead.',
};
// Hermes (React Native's JS engine) has no global `Buffer` unless a host app happens to install
// one — a library that reaches for it works in Node and breaks silently on a phone. Encode with
// `uint8arrays` instead (`toString`/`fromString`; `base64pad` matches Node's padded
// `Buffer#toString('base64')` byte-for-byte) — see block-transfer-service.ts for the pattern.
const NO_BUFFER_GLOBAL = {
	name: 'Buffer',
	message: "Buffer is a Node-only global, absent under Hermes/React Native. Encode with `uint8arrays` (toString/fromString) instead — see packages/db-p2p/src/cluster/block-transfer-service.ts.",
};
// Hermes has neither `AbortSignal.timeout` nor `AbortSignal.any` — confirmed on device (see
// tickets/complete/2-a-library-call-that-does-not-exist-on-phones.md). Use an explicit
// `AbortController` plus a timer instead, cleared on every exit path — see `dialRelay` in
// packages/db-p2p/src/network/relay-reservation.ts, and the combinator in
// packages/db-p2p/src/repo/client.ts for the "any of several signals" case (NOT the
// `any-signal` package, which discards the source signal's abort `reason` — see the comment
// at that call site).
const NO_ABORT_SIGNAL_TIMEOUT = {
	selector: "CallExpression[callee.object.name='AbortSignal'][callee.property.name='timeout']",
	message: 'AbortSignal.timeout is unreliable on Hermes/React Native. Use an explicit AbortController + timer instead — see dialRelay in network/relay-reservation.ts.',
};
const NO_ABORT_SIGNAL_ANY = {
	selector: "CallExpression[callee.object.name='AbortSignal'][callee.property.name='any']",
	message: 'AbortSignal.any is absent on Hermes/React Native, and `any-signal` (the usual replacement) drops the source reason. Use an explicit combinator instead — see repo/client.ts.',
};

// NOTE: `AbortSignal.prototype.throwIfAborted()` is NOT banned here, unlike the two static
// methods above. `libp2p-key-network.ts` and `network/open-protocol-stream.ts` already call it
// (as `signal?.throwIfAborted()`) on the strength of the readme's § React Native polyfill table,
// which already lists it as required — libp2p, @libp2p/circuit-relay-v2 and it-pushable need it
// too, so a host targeting Hermes must supply it regardless of what this package's own two call
// sites do. Banning it here would just move the requirement into this file without removing it.
//
// `Promise.withResolvers`, unlike the above, has zero call sites in this repo today — this
// package only avoids it pre-emptively. libp2p's own dependencies (yamux, it-queue, mortice,
// ping, abort-error) use it heavily, so this rule cannot catch the class of failure it causes
// on Hermes — only our own source reaching for it.
const NO_PROMISE_WITH_RESOLVERS = {
	selector: "CallExpression[callee.object.name='Promise'][callee.property.name='withResolvers']",
	message: 'Promise.withResolvers is ES2024 and Hermes/React Native does not provide it. Build the { promise, resolve, reject } triple by hand instead.',
};
const NO_DOM_EXCEPTION = {
	selector: "NewExpression[callee.name='DOMException']",
	message: 'DOMException construction is not guaranteed under Hermes/React Native. Throw a plain named Error instead.',
};
// NOTE: this Hermes-global guard is deliberately not exhaustive. `TextEncoder`/`TextDecoder`/
// `structuredClone`/timer `.ref()`/`.unref()`/`AbortSignal.prototype.throwIfAborted` are all used
// too pervasively (and are already required, declared polyfills per readme.md § React Native) to
// ban outright without either breaking real call sites or demanding a repo-wide rewrite; a lint
// rule for `ReadableStream`/`WritableStream`/`TransformStream`, `Symbol.asyncIterator`,
// `crypto.getRandomValues`, or `crypto.subtle.digest` would currently be pure prevention (nothing
// in `packages/*/src` reaches for them today). If any of those ever gain a first-party call site,
// that is the moment to add a rule for it here — see the evidenced list in
// tickets/complete/2-a-library-call-that-does-not-exist-on-phones.md for the full inventory this
// was checked against.

// Flat config (ESLint 9). Repo is ESM + yarn 4 workspaces + TypeScript throughout.
// `eslint .` walks the tree from root, so this single config covers every workspace —
// no per-package fan-out (unlike the build:/test: scripts in package.json).
//
// SCOPE: this config is deliberately narrow — it enforces logging discipline plus two
// React Native constraints (no class static blocks, no `Buffer` global). `no-console` is the gate this config was stood up for (route
// stray library logging through each package's `debug` logger instead of printing unconditionally),
// and `no-restricted-syntax` is the follow-on gate that says *which* logger: the channel must
// come from the package's own `createLogger`, never from libp2p's component logger or a
// hand-rolled `debug(...)` namespace. The same rule also bans class static blocks in library
// source (NO_STATIC_BLOCK above), which Metro cannot bundle. The full
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
		rules: {
			'no-restricted-syntax': ['error', NO_LIBP2P_COMPONENT_LOGGER, NO_DIRECT_DEBUG_IMPORT, NO_STATIC_BLOCK, NO_ABORT_SIGNAL_TIMEOUT, NO_ABORT_SIGNAL_ANY, NO_PROMISE_WITH_RESOLVERS, NO_DOM_EXCEPTION],
			'no-restricted-globals': ['error', NO_BUFFER_GLOBAL],
			// `no-restricted-globals` only sees the bare identifier; close the qualified spellings too.
			'no-restricted-properties': ['error',
				{ object: 'globalThis', property: 'Buffer', message: NO_BUFFER_GLOBAL.message },
				{ object: 'global', property: 'Buffer', message: NO_BUFFER_GLOBAL.message },
			],
		},
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
		rules: { 'no-restricted-syntax': ['error', NO_LIBP2P_COMPONENT_LOGGER, NO_STATIC_BLOCK] },
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
