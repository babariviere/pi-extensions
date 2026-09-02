import { QuickJsRuntime } from "./extensions/spindle/runtime/quickjs-runtime.ts";

const runtime = new QuickJsRuntime();
const result = await runtime.execute(
	"try { await pi.bash({ command: 'x' }); } catch (e) { return { names: Object.getOwnPropertyNames(e), meta: JSON.stringify(e.__spindleBashExit) }; } return 'no throw';",
	async (ref) => {
		const error: Error & { __spindleBashExit?: unknown } = new Error(`boom ${ref}`);
		error.__spindleBashExit = { exitCode: 7, output: "" };
		throw error;
	},
	{ timeoutMs: 10_000, memoryLimitBytes: 32 * 1024 * 1024 },
);
console.log(JSON.stringify(result, null, 2));
