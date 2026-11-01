// The helper lives in db-core, which has timers of its own to unref (`OwedCancels`); this keeps db-p2p's existing import sites.
export { unrefTimer, armUnrefTimer } from '@optimystic/db-core';
