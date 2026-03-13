---
name: rulesync-maintainer
description: Maintain .rulesync sources and regenerate Claude/Codex files
---
Use this skill when the task involves `AGENTS.md`, `CLAUDE.md`, `.claude/skills/`, `.codex/skills/`, or AI workflow instructions.

- Treat `rulesync.jsonc` and `.rulesync/**` as the only editable source of truth.
- Never edit generated AI files directly.
- Add or update rules in `.rulesync/rules/`.
- Add or update skills in `.rulesync/skills/`.
- After changing `.rulesync/**`, run `bun run rulesync:generate`.
- Before finishing, run `bun run rulesync:check`.
