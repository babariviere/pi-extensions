#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { evaluateSpindleJsonl } from "./index.ts";

const usage = "Usage: npm run code-mode:evaluate -- <records.jsonl|-> [--baseline <variant>]";

const parseArguments = (argv: readonly string[]): { path: string; baseline?: string } => {
	let path: string | undefined;
	let baseline: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index]!;
		if (argument === "--baseline") {
			baseline = argv[++index];
			if (baseline === undefined || baseline.length === 0) throw new Error(`${usage}\n--baseline requires a value`);
		} else if (argument.startsWith("-")) {
			if (argument === "-" && path === undefined) path = argument;
			else throw new Error(`${usage}\nUnknown option: ${argument}`);
		} else if (path === undefined) {
			path = argument;
		} else {
			throw new Error(`${usage}\nUnexpected argument: ${argument}`);
		}
	}
	if (path === undefined) throw new Error(usage);
	return { path, ...(baseline === undefined ? {} : { baseline }) };
};

try {
	const { path, baseline } = parseArguments(process.argv.slice(2));
	const input = readFileSync(path === "-" ? 0 : path, "utf8");
	const summary = evaluateSpindleJsonl(input, { ...(baseline === undefined ? {} : { baseline }) });
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
