/** Close an idle agent browser, never the user's normal browser or another session's pages. */
import { execFile } from "node:child_process";
import { Cdp } from "./cdp.ts";
import { browserProfileDir } from "./launch.ts";

/** Require both the dedicated profile and the expected debugging port. */
export function isAgentBrowser(command: string, port: number): boolean {
	const hasFlag = (flag: string) => ` ${command.trim()} `.includes(` ${flag} `);
	return (
		hasFlag(`--remote-debugging-port=${port}`) &&
		["helium", "chrome", "chromium"].some((browser) => hasFlag(`--user-data-dir=${browserProfileDir(browser)}`))
	);
}

export async function closeIdleBrowser(port: number): Promise<void> {
	let cdp: Cdp | undefined;
	try {
		// Never launch a browser just to close it. Bound every shutdown operation.
		const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) });
		if (!response.ok) return;
		const { webSocketDebuggerUrl } = (await response.json()) as { webSocketDebuggerUrl?: string };
		if (!webSocketDebuggerUrl) return;
		cdp = new Cdp(webSocketDebuggerUrl, { connectTimeoutMs: 1_000, callTimeoutMs: 1_000 });
		await cdp.connect();
		const { processInfo } = await cdp.call("SystemInfo.getProcessInfo");
		const pid = processInfo?.find((p: { type: string }) => p.type === "browser")?.id;
		if (!Number.isSafeInteger(pid) || pid <= 0) return;
		const stdout = await new Promise<string>((resolve, reject) => {
			execFile("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], { timeout: 1_000 }, (error, stdout) => {
				if (error) reject(error);
				else resolve(stdout);
			});
		});
		if (!isAgentBrowser(stdout, port)) return;
		const { targetInfos } = await cdp.call("Target.getTargets");
		// Other chat sessions can share this process, including hidden web fetch targets.
		if (!Array.isArray(targetInfos)) return;
		if (
			targetInfos.some((target: { type: string }) => ["page", "webview", "background_page"].includes(target.type))
		) {
			return;
		}
		await cdp.call("Browser.close");
	} catch {
		// An already-closed or unresponsive browser must not block session teardown.
	} finally {
		cdp?.close(true);
	}
}
