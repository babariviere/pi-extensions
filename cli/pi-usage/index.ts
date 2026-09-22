import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { renderReport } from "./render.ts";
import { buildReport } from "./report.ts";
import { scanSessions } from "./scanner.ts";
import type { ReportKind } from "./types.ts";

const HELP = `Usage: pi-usage [daily|monthly|session] [options]

Options:
  --since YYYY-MM-DD       Include records on or after this local date
  --until YYYY-MM-DD       Include records on or before this local date
  --timezone IANA_ZONE     Date-grouping timezone (default: system timezone)
  --sessions-dir PATH      Pi sessions root (default: ~/.pi/agent/sessions)
  --breakdown              Show provider/model rows beneath each period
  --json                   Emit JSON
  -h, --help               Show this help
`;

export interface CliOptions {
	kind: ReportKind;
	since?: string;
	until?: string;
	timezone: string;
	sessionsDir: string;
	breakdown: boolean;
	json: boolean;
	help: boolean;
}

function date(value: string | undefined, option: string): string {
	const parsed = value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : undefined;
	if (!value || !parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
		throw new Error(`${option} requires a valid YYYY-MM-DD date`);
	}
	return value;
}

function timezone(value: string | undefined): string {
	if (!value) throw new Error("--timezone requires an IANA timezone");
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
	} catch {
		throw new Error(`Invalid timezone: ${value}`);
	}
	return value;
}

export function parseArguments(argv: readonly string[]): CliOptions {
	let kind: ReportKind = "daily";
	let since: string | undefined;
	let until: string | undefined;
	let zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	let sessionsDir = join(homedir(), ".pi", "agent", "sessions");
	let breakdown = false;
	let json = false;
	let help = false;
	let commandSeen = false;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index]!;
		if (argument === "-h" || argument === "--help") help = true;
		else if (argument === "--json") json = true;
		else if (argument === "--breakdown") breakdown = true;
		else if (argument === "--since") since = date(argv[++index], "--since");
		else if (argument === "--until") until = date(argv[++index], "--until");
		else if (argument === "--timezone") zone = timezone(argv[++index]);
		else if (argument === "--sessions-dir") {
			const value = argv[++index];
			if (!value) throw new Error("--sessions-dir requires a path");
			sessionsDir = resolve(value.replace(/^~(?=\/|$)/, homedir()));
		} else if (argument === "daily" || argument === "monthly" || argument === "session") {
			if (commandSeen) throw new Error(`Unexpected command: ${argument}`);
			kind = argument;
			commandSeen = true;
		} else throw new Error(`Unknown argument: ${argument}`);
	}
	if (since && until && since > until) throw new Error("--since must not be after --until");
	return {
		kind,
		...(since ? { since } : {}),
		...(until ? { until } : {}),
		timezone: zone,
		sessionsDir,
		breakdown,
		json,
		help,
	};
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const options = parseArguments(argv);
	if (options.help) {
		process.stdout.write(HELP);
		return;
	}
	const scan = await scanSessions(options.sessionsDir);
	const report = buildReport(scan, options);
	process.stdout.write(
		options.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report, options.breakdown),
	);
}
