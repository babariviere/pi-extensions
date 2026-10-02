/** Use the same TypeScript loader supplied by the Pi host, not a dev-only tsx dependency. */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true, fsCache: false });
await jiti.import(fileURLToPath(new URL("./conversation-worker.ts", import.meta.url)));
