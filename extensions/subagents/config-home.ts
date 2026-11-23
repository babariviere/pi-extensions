import { cpSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// jj writes workspace records to its config home. Give the worker a private
// copy of jj's config without copying unrelated configuration directories.
export const CONFIG_HOME_COPY_DIRS = ["jj"];
const SANDBOX_JJ_CONFIG = '[signing]\nbehavior = "drop"\n';

export interface PreparedConfigHome {
	/** The new config home, or undefined when there was nothing to prepare. */
	path?: string;
	/** Why it is not usable, if it is not. */
	problems: string[];
}

/**
 * Build `destination` as a config home mirroring `source` (the real
 * `XDG_CONFIG_HOME`, or `~/.config`). Never throws: a run without it is the
 * previous behaviour, a run with it can commit.
 */
export function prepareConfigHome(
	destination: string,
	opts: { source?: string; copyDirs?: string[] } = {},
): PreparedConfigHome {
	const source = opts.source ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	const copyDirs = opts.copyDirs ?? CONFIG_HOME_COPY_DIRS;
	// Nothing to work around when the tool that needs it is not configured here.
	if (!copyDirs.some((dir) => existsSync(join(source, dir)))) return { problems: [] };

	const problems: string[] = [];
	try {
		mkdirSync(destination, { recursive: true });
		for (const entry of readdirSync(source)) {
			const to = join(destination, entry);
			if (existsSync(to)) continue;
			try {
				if (copyDirs.includes(entry)) cpSync(join(source, entry), to, { recursive: true, dereference: true });
				else symlinkSync(join(source, entry), to);
			} catch (error) {
				problems.push(`config home: ${entry}: ${String(error).split("\n")[0]}`);
			}
		}
		const jjDir = join(destination, "jj");
		if (existsSync(jjDir)) {
			const overrides = join(jjDir, "conf.d");
			mkdirSync(overrides, { recursive: true });
			writeFileSync(join(overrides, "zz-pi-sandbox.toml"), SANDBOX_JJ_CONFIG, { mode: 0o600 });
		}
	} catch (error) {
		return { problems: [`config home: ${String(error).split("\n")[0]}`] };
	}
	return { path: destination, problems };
}
