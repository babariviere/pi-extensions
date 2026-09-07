/** Wait until 21:00 today in local time, or start immediately after it. */
export function scheduledStartAt(now: Date): number {
	const boundary = new Date(now);
	boundary.setHours(21, 0, 0, 0);
	return Math.max(now.getTime(), boundary.getTime());
}
