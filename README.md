# Better Go To File

Minimal VS Code extension scaffold for a custom "Go To File" popup.

## What it does

- Adds the `Better Go To File: Open` command.
- Shows a Quick Pick with file names and relative paths.
- Keeps a warm workspace index in memory after startup.
- Learns from editor activity with a persisted frecency store.
- Opens the selected file.
- Keeps ranking logic isolated in pure modules for Bun tests and later scoring tweaks.

## Run it

1. Install dependencies with `bun install`.
2. Build with `bun run compile`.
3. Press `F5` in VS Code to launch the extension host.
4. Run `Better Go To File: Open` from the Command Palette.

## Test it

Run `bun test`.

## Keep it clean

- `bun run fmt`
- `bun run fmt:check`
- `bun run lint`
- `bun run check`
