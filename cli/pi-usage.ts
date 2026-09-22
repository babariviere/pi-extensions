#!/usr/bin/env node

import { main } from "./pi-usage/index.ts";

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
