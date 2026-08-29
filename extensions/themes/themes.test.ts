import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "..", "..");
const themesDir = join(repoRoot, "themes");
const schemaPath = join(
	repoRoot,
	"node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-schema.json",
);

const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const requiredColors: string[] = schema.properties.colors.required;
const allowedColors = new Set<string>(Object.keys(schema.properties.colors.properties));

const THEMES = ["rose-pine-moon", "rose-pine-dawn", "catppuccin-frappe", "catppuccin-macchiato", "catppuccin-latte"];

const isHex = (value: unknown): boolean => typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);

describe("shipped themes", () => {
	for (const name of THEMES) {
		describe(name, () => {
			const theme = JSON.parse(readFileSync(join(themesDir, `${name}.json`), "utf8"));
			const vars = new Set(Object.keys(theme.vars ?? {}));

			it("name matches its filename", () => {
				assert.equal(theme.name, name);
			});

			it("defines every required color key", () => {
				for (const key of requiredColors) {
					assert.ok(key in theme.colors, `missing required color: ${key}`);
				}
			});

			it("has no unknown color keys", () => {
				for (const key of Object.keys(theme.colors)) {
					assert.ok(allowedColors.has(key), `unknown color key: ${key}`);
				}
			});

			it("resolves every color value to a hex, palette index, or defined var", () => {
				for (const [key, value] of Object.entries(theme.colors)) {
					const resolved =
						isHex(value) ||
						(typeof value === "number" && value >= 0 && value <= 255) ||
						(typeof value === "string" && vars.has(value));
					assert.ok(resolved, `unresolved color ${key}: ${JSON.stringify(value)}`);
				}
			});
		});
	}
});
