/**
 * Reject if `promise` has not settled within `ms`. The timer is cleared on either outcome, so no
 * handle outlives the race (hence no `unref`, which does not exist off Node).
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}
