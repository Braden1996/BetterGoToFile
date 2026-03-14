# Better Go To File

![Better Go To File banner showing before-and-after file search results](assets/banner.png)

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=Braden.better-go-to-file">
    <img
      alt="Visual Studio Marketplace version"
      src="https://img.shields.io/visual-studio-marketplace/v/Braden.better-go-to-file?style=for-the-badge&label=VS%20Marketplace&labelColor=282A36&color=BD93F9&logo=visualstudiocode&logoColor=F8F8F2"
    />
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=Braden.better-go-to-file">
    <img
      alt="Visual Studio Marketplace installs"
      src="https://img.shields.io/visual-studio-marketplace/i/Braden.better-go-to-file?style=for-the-badge&label=Installs&labelColor=282A36&color=6272A4&logo=visualstudiocode&logoColor=F8F8F2"
    />
  </a>
  <a href="https://open-vsx.org/extension/Braden/better-go-to-file">
    <img
      alt="Open VSX version"
      src="https://img.shields.io/open-vsx/v/Braden/better-go-to-file?style=for-the-badge&label=Open%20VSX&labelColor=282A36&color=8BE9FD&logo=eclipseide&logoColor=282A36"
    />
  </a>
  <a href="https://open-vsx.org/extension/Braden/better-go-to-file">
    <img
      alt="Open VSX downloads"
      src="https://img.shields.io/open-vsx/dt/Braden/better-go-to-file?style=for-the-badge&label=Open%20VSX%20Downloads&labelColor=282A36&color=50FA7B&logo=eclipseide&logoColor=282A36"
    />
  </a>
  <a href="https://github.com/Braden1996/BetterGoToFile/actions/workflows/checks.yml">
    <img
      alt="Checks status"
      src="https://img.shields.io/github/actions/workflow/status/Braden1996/BetterGoToFile/checks.yml?branch=master&style=for-the-badge&label=Checks&labelColor=282A36&color=50FA7B&logo=githubactions&logoColor=282A36"
    />
  </a>
  <a href="https://github.com/Braden1996/BetterGoToFile/releases/latest">
    <img
      alt="Latest GitHub release"
      src="https://img.shields.io/github/v/release/Braden1996/BetterGoToFile?sort=semver&style=for-the-badge&label=Release&labelColor=282A36&color=FFB86C&logo=github&logoColor=282A36"
    />
  </a>
  <a href="https://github.com/Braden1996/BetterGoToFile/releases/latest">
    <img
      alt="Download latest VSIX from GitHub Releases"
      src="https://img.shields.io/badge/VSIX-latest%20artifact-FF79C6?style=for-the-badge&labelColor=282A36&logo=github&logoColor=F8F8F2"
    />
  </a>
</p>

## What is Better Go To File?

Better Go To File is a `Go to File` picker for VS Code style editors that stays literal when your query is specific and gets smarter when it is not. It keeps the speed of `Cmd/Ctrl+P`, but adds the repository context the default picker throws away. Its distinctive signal is **Git-aware reranking**: it learns the feature areas you work in, infers nearby teammates from overlapping history, and uses current worktree activity plus shared file lineage to pull the relevant slice of the repo toward the top.

## The Problem

Once a repo gets large, the default picker starts to fail in predictable ways:

- **Duplicate filenames** like `index.ts`, `routes.ts`, and `button.tsx` crowd the top of the results.
- **Monorepo path noise** makes it hard to tell which package a file actually belongs to.
- **No repository context** means the picker has no idea what part of the codebase you work in or which nearby contributors tend to touch related files.
- **Short queries** are treated as if they were precise, even when they clearly are not.

## Why It Feels Better

- **Specific intent still wins.** Every query token still has to match, and exact path or basename intent remains the strongest signal.
- **Ambiguous queries get smarter.** Frecency, active-file context, open tabs, and Git reranking matter most when text alone is not enough, then back off as intent becomes explicit.
- **Git favors real feature overlap.** Current worktree changes, package-scoped history, and inferred teammate activity surface meaningful code areas instead of noisy shared package roots.
- **Monorepo results stay readable.** Package-aware ranking and path rendering make duplicate filenames easier to distinguish and faster to scan.

## Install

- **VS Code**: install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Braden.better-go-to-file).
- **Open VSX editors**: install from [Open VSX](https://open-vsx.org/extension/Braden/better-go-to-file).
- **Manual install**: download the latest [VSIX from GitHub Releases](https://github.com/Braden1996/BetterGoToFile/releases/latest).
- **Cursor note**: if extension search lags Open VSX, use `Extensions: Install from VSIX...`.

## Keyboard Shortcut

Replace the default `Cmd+P` picker with Better Go To File:

```json
[
  {
    "key": "cmd+p",
    "command": "-workbench.action.quickOpen"
  },
  {
    "key": "cmd+p",
    "command": "betterGoToFile.open",
    "when": "!inQuickOpen"
  }
]
```

<details>
<summary>Prefer a separate shortcut instead?</summary>

```json
[
  {
    "key": "cmd+u",
    "command": "betterGoToFile.open",
    "when": "!inQuickOpen"
  }
]
```

</details>

## How It Works

The short version: text narrows the pool, then context breaks ties. Better Go To File stays predictable for explicit queries and becomes much more helpful when the query is broad.

Every search goes through a few layers:

1. **Candidate indexing** across the workspace, with package-root awareness
2. **Lexical filtering** so every query token still has to match
3. **Context reranking** from frecency, active file/package proximity, open tabs, and tracked state
4. **Git priors** from contributor history and live worktree activity when the query is ambiguous

For the full scoring model, diagrams, and debugging CLI commands, see [docs/scoring.md](docs/scoring.md).

<details>
<summary>Signals used by the scorer</summary>

- **Frecency** from recent and repeated file opens
- **Editor context** from the active file, same package, open tabs, and nearby directories
- **Git state** from tracked, ignored, and untracked status
- **Contributor overlap** from historical Git areas and file lineage
- **Session overlay** from the files you are changing right now

</details>

## Debugging and Development

- **Inspect scores locally** with `bun run score -- --help`
- **See ranked results** with `bun run score:search -- --repo /path/to/repo --debug button`
- **Explain one file** with `bun run score:explain -- --repo /path/to/repo button path/to/file.tsx`
- **Run the full validation pass** with `bun run check`

Runtime code lives in `src/`. Tests live in `test/`.
