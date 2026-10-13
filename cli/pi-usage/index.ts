import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { scanPilot } from "./pilot.ts";
import { renderReport } from "./render.ts";
import { buildReport } from "./report.ts";
import { scanSessions, UsageCollector } from "./scanner.ts";
import type { ReportKind, ScanResult } from "./types.ts";

const HELP = `Usage: pi-usage [daily|monthly|session] [options]

Options:
  --since YYYY-MM-DD       Include records on or after this local date
  --until YYYY-MM-DD       Include records on or before this local date
  --timezone IANA_ZONE     Date-grouping timezone (default: system timezone)
  --source all|pi|pilot    Session stores to scan (default: all)
  --sessions-dir PATH      Pi sessions root (default: ~/.pi/agent/sessions)
  --pilot-dir PATH         Pilot data directory (default: $PILOT_HOME, else
                           $XDG_DATA_HOME/pilot or ~/.local/share/pilot)
  --breakdown              Show provider/model rows beneath each period
  --json                   Emit JSON
  --no-color               Disable colors (also honors NO_COLOR)
  -h, --help               Show this help
`;

export type SourceFilter = "all" | "pi" | "pilot";

export interface CliOptions {
	kind: ReportKind;
	since?: string;
	until?: string;
	timezone: string;
	source: SourceFilter;
	sessionsDir: string;
	pilotDir: string;
	breakdown: boolean;
	json: boolean;
	color: boolean;
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

const expandHome = (value: string): string => resolve(value.replace(/^~(?=\/|$)/, homedir()));

export function defaultPilotDir(env: NodeJS.ProcessEnv = process.env): string {
	if (env.PILOT_HOME) return expandHome(env.PILOT_HOME);
	return resolve(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "pilot");
}

export function parseArguments(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
	let kind: ReportKind = "daily";
	let since: string | undefined;
	let until: string | undefined;
	let zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	let source: SourceFilter = "all";
	let sessionsDir = join(homedir(), ".pi", "agent", "sessions");
	let pilotDir = defaultPilotDir(env);
	let breakdown = false;
	let json = false;
	let color = !env.NO_COLOR;
	let help = false;
	let commandSeen = false;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index]!;
		if (argument === "-h" || argument === "--help") help = true;
		else if (argument === "--json") json = true;
		else if (argument === "--breakdown") breakdown = true;
		else if (argument === "--no-color") color = false;
		else if (argument === "--since") since = date(argv[++index], "--since");
		else if (argument === "--until") until = date(argv[++index], "--until");
		else if (argument === "--timezone") zone = timezone(argv[++index]);
		else if (argument === "--source") {
			const value = argv[++index];
			if (value !== "all" && value !== "pi" && value !== "pilot")
				throw new Error("--source requires one of: all, pi, pilot");
			source = value;
		} else if (argument === "--sessions-dir") {
			const value = argv[++index];
			if (!value) throw new Error("--sessions-dir requires a path");
			sessionsDir = expandHome(value);
		} else if (argument === "--pilot-dir") {
			const value = argv[++index];
			if (!value) throw new Error("--pilot-dir requires a path");
			pilotDir = expandHome(value);
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
		source,
		sessionsDir,
		pilotDir,
		breakdown,
		json,
		color,
		help,
	};
}

/** Scan the selected stores with one collector so responses copied between them count once. */
export async function scanSources(
	options: Pick<CliOptions, "source" | "sessionsDir" | "pilotDir">,
): Promise<ScanResult> {
	const collector = new UsageCollector();
	const pi = options.source === "pilot" ? undefined : await scanSessions(options.sessionsDir, collector);
	const pilot = options.source === "pi" ? undefined : await scanPilot(options.pilotDir, collector);
	return {
		records: collector.records,
		files: pi?.files ?? 0,
		duplicateRecords: collector.duplicateRecords,
		invalidLines: (pi?.invalidLines ?? 0) + (pilot?.invalidLines ?? 0),
		...(pilot
			? { pilotDatabases: pilot.pilotDatabases ?? 0, unreadableDatabases: pilot.unreadableDatabases ?? 0 }
			: {}),
	};
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const options = parseArguments(argv);
	if (options.help) {
		process.stdout.write(HELP);
		return;
	}
	const scan = await scanSources(options);
	const report = buildReport(scan, {
		...options,
		...(options.source === "pi" ? {} : { pilotDir: options.pilotDir }),
	});
	process.stdout.write(
		options.json
			? `${JSON.stringify(report, null, 2)}\n`
			: renderReport(report, {
					breakdown: options.breakdown,
					color: options.color && process.stdout.isTTY === true,
					...(process.stdout.columns ? { width: process.stdout.columns } : {}),
				}),
	);
}
