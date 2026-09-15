// `os` / `node:os` shim — exactly the row in the "Node.js built-in module shims" table of
// packages/db-p2p/readme.md § React Native: `networkInterfaces()` returns `{}`, `platform()` returns
// `Platform.OS`. Keep it to what that row promises: the check proves the readme's recipe is
// enough, not that a richer shim would be.
//
// A host's shim imports `Platform` from 'react-native'. This one imports the harness stub by path:
// `react-native` is not installed here, and `scripts/check-undeclared-deps.mjs` rightly rejects a bare
// import of an undeclared package. Third-party imports of 'react-native' still reach the same stub
// through the alias in metro.config.cjs.

import { Platform } from './react-native.js';

export function networkInterfaces() {
	return {};
}

export function platform() {
	return Platform.OS;
}

export default { networkInterfaces, platform };
