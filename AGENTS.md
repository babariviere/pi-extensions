# AGENTS.md

## Project

This repository contains personal [pi](https://github.com/earendil-works/pi) extensions, skills, and themes. Extension entry points are discovered from `extensions/*/index.ts`; skills are under `skills/`; themes are JSON files in `themes/`.

## Working conventions

- Use TypeScript with ESM imports. The compiler target is ES2022 with strict type checking.
- Keep an extension's implementation, tests, and documentation together under its `extensions/<name>/` directory.
- Use the pi SDK packages as peer dependencies. They are supplied by the pi host at runtime, so do not add them as regular dependencies.
- Preserve the existing public configuration, command, tool, and event contracts unless the change explicitly requires a breaking change.
- Never commit credentials, local settings, or generated files. `.pi/` and `node_modules/` are ignored.
- Follow existing extension documentation patterns. Document user-visible commands, configuration, permissions, and operational caveats in the relevant extension README when applicable.

## Formatting and tests

- Formatting uses Biome: tabs, width 120. Run `npm run fmt` to apply formatting or `npm run fmt:check` to check it.
- Tests use Node's built-in test runner and `node:assert/strict`. Put tests beside their implementation as `*.test.ts`.
- Run relevant focused tests while developing. Before finishing a change, run:

  ```sh
  npm run typecheck
  npm test
  ```

- CI runs `npm ci`, `npm run typecheck`, and `npm test` on Node 24.

## Repository safety

- This is a jj repository. Use `jj` for repository-modifying version-control operations.
- Do not modify lockfiles unless dependency changes require it.
- Avoid editing generated, vendored, or installed content such as `node_modules/`.
