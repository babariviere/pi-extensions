import { existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const mode = process.argv[2];
const arg = process.argv[3];
const checking = process.argv.includes("--check");
if (checking && (process.env.HF_HUB_OFFLINE !== "1" || process.env.TRANSFORMERS_OFFLINE !== "1")) {
	throw new Error("Readiness check unexpectedly online");
}
if (mode === "hang" || mode === "ignoreTerm") {
	const ignore = mode === "ignoreTerm" ? "process.on('SIGTERM', () => {});" : "";
	if (ignore) process.on("SIGTERM", () => {});
	const child = spawn(process.execPath, ["-e", `${ignore}setInterval(() => {}, 1000)`], { stdio: "inherit" });
	writeFileSync(arg, JSON.stringify({ parent: process.pid, child: child.pid }));
	setInterval(() => {}, 1000);
} else {
	if (mode === "delay") await new Promise((resolve) => setTimeout(resolve, Number(arg)));
	if (mode === "checkThenInstall" && checking) {
		console.log(JSON.stringify({ error: "Clef dependencies are missing. Run /clef install." }));
		process.exitCode = 1;
	} else if (mode === "retry" && !existsSync(arg)) {
		writeFileSync(arg, "failed");
		console.log(JSON.stringify({ error: "Checkpoint download failed. Check network and disk space." }));
		process.exitCode = 1;
	} else if (mode === "malformed") console.log("not json");
	else if (mode === "oversize") console.log("x".repeat(20_000));
	else if (mode === "relative") console.log(JSON.stringify({ python: "python3", modelPath: "/checkpoint" }));
	else if (!checking && (process.env.HF_HUB_OFFLINE || process.env.TRANSFORMERS_OFFLINE)) {
		console.log(JSON.stringify({ error: "Setup unexpectedly offline" }));
		process.exitCode = 1;
	} else console.log(JSON.stringify({ python: process.execPath, modelPath: `/checkpoint-${process.pid}` }));
}
