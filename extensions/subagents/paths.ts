/** Make a value safe for use as a single path segment. */
export function sanitizeSegment(value: string): string {
	const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
	return cleaned.length > 0 ? cleaned.slice(0, 128) : "_";
}
