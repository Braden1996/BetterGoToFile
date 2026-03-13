---
name: scoring-debugger
description: "Debug Better Go To File ranking against any local repository using the scoring CLI. Use when a user asks why a result ranked, wants to inspect top matches for a query, or wants to iterate on presets/overrides outside the VS Code extension host."
targets: ["claudecode", "codexcli"]
---

Use the local scoring CLI instead of re-deriving ranking behavior by hand.

Commands:

- `bun run score -- --help`
- `bun run score:search -- --repo /absolute/or/relative/repo --limit 20 button`
- `bun run score:search -- --repo /repo --preset nearby --active-path packages/foo/src/bar.tsx --open-path packages/foo/src/bar.tsx,packages/foo/src/baz.tsx button`
- `bun run score:search -- --repo /repo --contributor-email braden@example.com --debug button`
- `bun run score:search -- --repo /repo --frecency-file /path/to/frecency.json --debug button`
- `bun run score:search -- --repo /repo --custom-preset '{"ranking":{"context":{"sameDirectoryQueryBoost":200}}}' --debug button`
- `bun run score:explain -- --repo /repo button packages/runtimes/web-app/src/react/workflows/workflow-editor/components/node-input-v2/special-inputs/day-of-month-picker/button-grid.component.tsx`
- `bun run score:explain -- --repo /repo --contributor-name "Braden Marshall" --contributor-email braden@example.com button path/to/file.tsx`

Workflow:

1. Run `score:search` to inspect the current top matches.
2. Run `score:explain` for any suspicious candidate to see its rank, score, and nearby neighbors.
3. Re-run the same command with a different preset or `--custom-preset` override when iterating.
4. Check the summary lines to confirm whether frecency was auto-discovered from VS Code/Cursor workspace storage or pinned via `--frecency-file`.
5. Check the contributor summary lines to confirm whether priors were loaded from local `git config` or explicit override flags.
6. Summarize rank movements and the main lexical/context/frecency/git-prior signals from the debug output.

Current CLI scope:

- Uses the same ranking presets and lexical/context scorer as the extension.
- Scans the target repository directly from disk and infers package roots from `package.json` and `project.json`.
- Auto-discovers persisted frecency snapshots from common VS Code and Cursor `workspaceStorage` locations, with an explicit `--frecency-file` override when needed.
- Includes tracked vs ignored vs untracked Git state in the context penalties.
- Loads contributor-relationship Git priors from local history, defaulting to the repo's `git config user.name` / `user.email` and allowing CLI overrides.
- Does not load open editors outside the provided flags or reconstruct unsaved in-memory editor state.
