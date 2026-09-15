// Host-shaped entry for `yarn check:rn`: imports what packages/db-p2p/readme.md § React Native tells a
// React Native app to import, plus the bare `@optimystic/db-p2p` so the `react-native` export
// condition is exercised (scripts/rn-bundle-check.mjs asserts where it lands).
//
// Nothing here ever executes — Metro bundles it and hermesc compiles it — so no polyfills are
// installed. Every namespace is touched anyway, so no import reads as dead code to a future editor.

import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { webSockets } from '@libp2p/websockets';
import * as dbCore from '@optimystic/db-core';
import * as dbP2p from '@optimystic/db-p2p';
import * as dbP2pRn from '@optimystic/db-p2p/rn';
import * as storageRn from '@optimystic/db-p2p-storage-rn';

export const reached = {
	dbCore: Object.keys(dbCore).length,
	dbP2p: Object.keys(dbP2p).length,
	dbP2pRn: Object.keys(dbP2pRn).length,
	storageRn: Object.keys(storageRn).length,
	transports: [typeof webSockets, typeof circuitRelayTransport],
};
