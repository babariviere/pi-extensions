/**
 * Redact `pi.bash` extras (env values, stdin) from recorded surfaces —
 * audits, previews, execution traces. The live call keeps the raw values;
 * only what is written down (session files, UI) is redacted. Extension
 * tool_call events still receive the raw args by design, so hooks such as
 * the secrets extension keep working.
 */

export const redactRecordedArgs = (
  ref: string,
  args: Record<string, unknown>,
): Record<string, unknown> => {
  if (ref !== "pi.bash") return args;
  let out: Record<string, unknown> | undefined;
  const env = args.env;
  if (typeof env === "object" && env !== null && !Array.isArray(env)) {
    out ??= { ...args };
    const redactedEnv: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      redactedEnv[key] =
        typeof value === "string" ? `<redacted: ${value.length} chars>` : value;
    }
    out.env = redactedEnv;
  }
  const stdin = args.stdin;
  if (typeof stdin === "string") {
    out ??= { ...args };
    out.stdin = `<stdin: ${stdin.length} chars>`;
  }
  return out ?? args;
};
