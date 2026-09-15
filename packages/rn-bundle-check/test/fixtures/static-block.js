// Fixture for test/static-block.test.mjs: a class `static { }` block, the construct that broke a
// downstream React Native app on 2026-09-14. Metro's Babel preset must refuse to bundle it.

export class Registry {
	static entries = new Map();

	static {
		Registry.entries.set('default', Registry);
	}
}
