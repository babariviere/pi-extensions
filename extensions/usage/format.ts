export interface LocalDateTimeFormatOptions {
	locale?: string;
	timeZone?: string;
}

/** Format an ISO timestamp in the user's local time zone and locale. */
export function formatLocalDateTime(value: string, options: LocalDateTimeFormatOptions = {}): string {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return value;

	return new Intl.DateTimeFormat(options.locale, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
		...(options.timeZone ? { timeZone: options.timeZone } : {}),
	}).format(date);
}
