// Harness-only stand-in for the `react-native` package — deliberately NOT a row in the readme's shim
// table, because every real app already has `react-native` installed. It exists for one import:
// under the `react-native` condition `libp2p` resolves `dist/src/user-agent.react-native.js`, which
// does `import { Platform } from 'react-native'`. Installing the real package would drag its
// native-module graph into a bundle whose only job is to prove our code bundles and compiles.

export const Platform = {
	OS: 'android',
	Version: 34,
	select(specifics) {
		if ('android' in specifics) return specifics.android;
		if ('native' in specifics) return specifics.native;
		return specifics.default;
	},
};

export default { Platform };
