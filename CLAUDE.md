# Better Go To File

- This repository is a VS Code extension written in TypeScript.
- Use Bun for package management and scripts.
- Runtime code lives under `src/`.
- Tests live under `test/`.

## Validation

- Use `bun run check` for the full validation pass.
- When a full pass is unnecessary, prefer the smallest relevant checks:
  - `bun run compile`
  - `bun test`
  - `bun run lint`
  - `bun run fmt:check`

## AI Instruction Workflow

- `rulesync.jsonc` and `.rulesync/**` are the source of truth for AI instructions and skills in this repo.
- Generated AI files include `AGENTS.md`, `CLAUDE.md`, `.claude/skills/**`, and `.codex/skills/**`.
- Never edit generated AI files directly.
- If the user asks to change AI instructions, skills, or agent workflow:
  1. Edit the relevant source files under `.rulesync/`.
  2. Run `bun run rulesync:generate`.
  3. Run `bun run rulesync:check` before finishing.
- If you find local edits in generated AI files, port those changes back into `.rulesync/**` and regenerate instead of preserving direct edits.
