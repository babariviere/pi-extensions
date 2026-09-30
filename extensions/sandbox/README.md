# Sandbox

`/sandbox` inspects or changes filesystem policy independently of native codemode. Configuration is `~/.pi/agent/sandbox.json`, merged with trusted `.pi/sandbox.json`:

```json
{
  "mode": "off",
  "allowWrite": [],
  "denyWrite": [],
  "denyRead": [],
  "mcp": { "readOnly": false, "unknownToolPolicy": "deny", "servers": {} }
}
```

Modes: `off`, `read-only`, `workspace-write`, `full`. `off` restores configuration, it does not override a night-run or subagent floor. Existing night-mode policy events remain supported. Move the old `code-mode.json` sandbox fields to the root of this file, and its MCP permission block under `mcp`. Server connections and OAuth belong to pi's native `mcp.json`, not this file.

Core read/search/edit/write operations and the separate `applyPatch` extension enforce path policy on both direct calls and native codemode's nested calls. Shell commands and background jobs use the same macOS Seatbelt wrapper. Restricted shell calls fail closed if OS enforcement cannot start. Filesystem restriction is macOS-only; networking is unrestricted. `/dev/null` remains a permitted output destination.

Read-only MCP policy uses explicit allow/deny lists, conservative tool-name classification and server annotations. Unknown tools are denied by default while read-only policy is active. Server hints cannot grant permission on their own. Native MCP resources remain read-only.

Sibling overrides are not silently replaced. When a restricted core tool is owned by another extension, calls are refused rather than executing an unchecked override. Broad searches that could traverse a denied read directory are also refused; choose a narrower search path.

These are accident-prevention guardrails, not a security boundary for arbitrary installed extensions. Trusted extension callbacks run with host permissions. The jobs extension requires this extension even when policy is off.
