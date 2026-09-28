# Prompt prewalk

On trusted top-level prompts, an available Luna model first decides with thinking off whether repository exploration would help. If so, it uses low thinking and bounded read-only search/read tools to give the main agent a short report before its first model request. It cannot edit or run project code, and the main agent must verify its findings. If Luna is unavailable, the call fails, or the prompt is too short, normal agent processing proceeds without a report. The model is selected only from the session's scoped models (when configured), never replaced by another model. Scouting may add latency (up to 15 seconds) and model usage; it is not free.

While an automatic pass runs, the footer briefly shows `Prewalk: checking…`, then `Prewalk: exploring…` if Luna chooses to scout. The status clears before the main agent starts, including when Luna declines or fails. It is a UI indicator, not a chat message.

Use `/prewalk <prompt>` for a manual local search without Luna. The agent receives the original request and up to six likely file paths with short matching lines. This command skips the automatic pass.

The search uses words from the prompt, prioritizes matching paths, and scans only the first 16 KiB of each recognized source file. It does not follow symlinks, run project code, or enter hidden directories, `node_modules`, build outputs, or `.pi`; common credential and lockfile names are excluded. It stops after 2,000 files, 500 directories, 4,000 entries per directory, or 6 MiB read. Results may be incomplete and can include untracked files; it does not apply `.gitignore`. Avoid using it in directories containing secrets: matching lines are sent to Luna on automatic passes or to the main agent with `/prewalk`.
