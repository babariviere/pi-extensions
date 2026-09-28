import { opendir, open } from "node:fs/promises";
import path from "node:path";

const SKIP_DIRS = new Set([".git", ".jj", ".pi", "node_modules", "dist", "build", "coverage", "vendor", "target"]);
const SOURCE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".json",
	".md",
	".py",
	".go",
	".rs",
	".java",
	".rb",
	".sh",
	".css",
	".html",
	".sql",
	".yaml",
	".yml",
	".toml",
]);
const STOP_WORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"from",
	"this",
	"that",
	"into",
	"code",
	"file",
	"files",
	"please",
	"find",
	"make",
	"fix",
	"add",
	"implement",
	"change",
	"update",
	"where",
	"what",
	"does",
	"work",
	"test",
	"tests",
]);
const MAX_FILES = 2000;
const MAX_DIRS = 500;
const MAX_ENTRIES_PER_DIR = 4000;
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024;

export interface PrewalkResult {
	map: string;
	paths: string[];
	filesSeen: number;
	truncated: boolean;
}

function termsFor(prompt: string): string[] {
	return [
		...new Set(
			(prompt.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []).filter(
				(word) => word.length <= 64 && !STOP_WORDS.has(word),
			),
		),
	].slice(0, 12);
}

function pathScore(name: string, terms: string[]): number {
	const lower = name.toLowerCase();
	const basename = path.basename(lower);
	return terms.reduce((score, term) => score + (basename.includes(term) ? 8 : lower.includes(term) ? 4 : 0), 0);
}

/** Best-effort, bounded local search. Never follows symlinks or executes repository content. */
export async function prewalk(cwd: string, prompt: string): Promise<PrewalkResult> {
	const terms = termsFor(prompt);
	if (terms.length === 0)
		return { map: "No distinctive search terms in the prompt.", paths: [], filesSeen: 0, truncated: false };
	const queue = [cwd];
	const hits: { name: string; score: number; line?: number; excerpt?: string }[] = [];
	let filesSeen = 0;
	let dirsSeen = 0;
	let bytesRead = 0;
	let truncated = false;
	while (queue.length > 0 && dirsSeen < MAX_DIRS && filesSeen < MAX_FILES && bytesRead < MAX_BYTES) {
		const dir = queue.shift();
		if (!dir) break;
		dirsSeen++;
		let entries;
		try {
			const handle = await opendir(dir);
			entries = [];
			for await (const entry of handle) {
				if (entries.length >= MAX_ENTRIES_PER_DIR) {
					truncated = true;
					break;
				}
				entries.push(entry);
			}
		} catch {
			continue;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) queue.push(path.join(dir, entry.name));
				continue;
			}
			if (!entry.isFile() || entry.name.startsWith(".") || !SOURCE_EXTENSIONS.has(path.extname(entry.name)))
				continue;
			if (/^(?:package-lock|npm-shrinkwrap|credentials|secrets|tokens|auth)\.(?:json|ya?ml|toml)$/i.test(entry.name))
				continue;
			if (filesSeen >= MAX_FILES || bytesRead >= MAX_BYTES) {
				truncated = true;
				break;
			}
			filesSeen++;
			const name = path.relative(cwd, path.join(dir, entry.name));
			if (name.length > 240) continue;
			let text = "";
			try {
				const handle = await open(path.join(dir, entry.name), "r");
				try {
					const buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES, MAX_BYTES - bytesRead));
					const { bytesRead: count } = await handle.read(buffer, 0, buffer.length, 0);
					bytesRead += count;
					text = buffer.subarray(0, count).toString("utf8");
				} finally {
					await handle.close();
				}
			} catch {
				// Unreadable files can still match by path.
			}
			let score = pathScore(name, terms);
			let line: number | undefined;
			let excerpt: string | undefined;
			const matchedTerms = new Set<string>();
			let bestMatches = 0;
			if (!text.includes("\0")) {
				for (const [index, raw] of text.split("\n").entries()) {
					const matches = terms.filter((term) => raw.toLowerCase().includes(term));
					if (matches.length > 0) {
						for (const term of matches) matchedTerms.add(term);
						if (matches.length > bestMatches) {
							bestMatches = matches.length;
							line = index + 1;
							excerpt = raw
								.trim()
								.replace(/[\x00-\x1f\x7f]/g, " ")
								.slice(0, 160);
						}
					}
				}
			}
			score += matchedTerms.size * 2;
			if (score > 0) hits.push({ name, score, line, excerpt });
		}
	}
	if (queue.length > 0 || filesSeen >= MAX_FILES || bytesRead >= MAX_BYTES) truncated = true;
	hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
	const lines = hits
		.slice(0, 6)
		.map(
			(hit) =>
				`- ${JSON.stringify(hit.name)}${hit.line ? `:${hit.line}` : ""}${hit.excerpt ? `  ${hit.excerpt}` : ""}`,
		);
	return {
		map: lines.length ? lines.join("\n") : "No likely files found in the scanned source files.",
		paths: hits.slice(0, 6).map((hit) => hit.name),
		filesSeen,
		truncated,
	};
}
