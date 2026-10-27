/** Wraps `PendRequest.refuseSolo` and `CommitRequest.refuseSolo` so the field spreads onto a request
 * only when the write refuses to be committed alone. A write that does not is omitted rather than
 * sent as `false`: the request is hashed verbatim into every cohort signature preimage, so it must
 * serialize exactly as it did before the field existed. Every producer of the field goes through here. */
export function refuseSoloField(refuse: boolean | undefined): { refuseSolo?: true } {
	return refuse === true ? { refuseSolo: true } : {};
}
