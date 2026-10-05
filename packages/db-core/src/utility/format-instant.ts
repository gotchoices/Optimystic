/**
 * ISO-8601 for a representable instant (unix ms), the bare number otherwise. For log and error prose
 * about instants that arrived off the wire: `Date.prototype.toISOString` throws on an invalid date
 * (beyond ±8.64e15 ms, or not a number at all), and a throw while describing a refusal would replace
 * the refusal.
 */
export function formatInstant(ms: number): string {
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? String(ms) : date.toISOString();
}
