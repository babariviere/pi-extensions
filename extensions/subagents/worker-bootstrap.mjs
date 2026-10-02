/** Use the same TypeScript loader supplied by the Pi host, not a dev-only tsx dependency. */
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const hostDirectory = process.env.PI_SUBAGENT_HOST_PACKAGE_DIR;
if (!hostDirectory) throw new Error("Durable worker requires its launching Pi host package directory");
const hostEntry = pathToFileURL(join(hostDirectory, "dist", "index.js"));
const require = createRequire(join(hostDirectory, "package.json"));
const { createJiti } = require("jiti");
const resolver = createJiti(hostEntry.href, { fsCache: false });
// Mirror Pi's host-provided peer modules without installing them into the extension.
// Virtual modules match exact specifiers, unlike prefix aliases that break subpaths.
const virtualModules = {
	"@earendil-works/pi-coding-agent": await import(hostEntry.href),
};
for (const specifier of [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-ai/compat",
	"@earendil-works/pi-ai/oauth",
	"@earendil-works/pi-ai/providers/all",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-tui",
	"typebox",
	"typebox/compile",
	"typebox/value",
]) {
	const target = specifier === "@earendil-works/pi-ai" ? "@earendil-works/pi-ai/compat" : specifier;
	virtualModules[specifier] = await import(resolver.esmResolve(target));
}
const jiti = createJiti(import.meta.url, { interopDefault: true, fsCache: false, virtualModules });
await jiti.import(fileURLToPath(new URL("./conversation-worker.ts", import.meta.url)));
