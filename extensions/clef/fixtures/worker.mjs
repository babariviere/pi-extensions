import { createInterface } from "node:readline";

let sequence = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
	const { id, payload } = JSON.parse(line);
	const reply = { id, ok: true, result: { pid: process.pid, sequence: ++sequence, payload } };
	if (payload.testMode === "ignoreTerm") process.on("SIGTERM", () => {});
	if (payload.testMode === "hang") return;
	if (payload.testMode === "crash") process.exit(42);
	if (payload.testMode === "malformed") return void process.stdout.write("not json\n");
	if (payload.testMode === "wrongId") reply.id++;
	if (payload.testMode === "oversize") return void process.stdout.write("x".repeat(4 * 1024 * 1024 + 1));
	if (payload.testMode === "error" || payload.testMode === "fatal") {
		return void process.stdout.write(JSON.stringify({ id, ok: false, error: "Mock failure", fatal: payload.testMode === "fatal" }) + "\n");
	}
	const encoded = `${JSON.stringify(reply)}\n`;
	if (payload.testMode === "partial") {
		process.stdout.write(encoded.slice(0, 12));
		setTimeout(() => process.stdout.write(encoded.slice(12)), 10);
	} else setTimeout(() => process.stdout.write(encoded), payload.delayMs ?? 0);
});
