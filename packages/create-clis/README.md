# create-clis

[![CI](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/ci.yml)

**English** | [中文](README.zh-CN.md)

Scaffold a standalone clis collection repository from the clis skeleton snapshot: capability tiers, generic vocabulary, and a green CI out of the box.

> Status: not on the npm registry yet; the npm badges land with the first published version.

## Requirements

- **Runtime**: any recent bun, or node 22.18.0 or newer (the floor is the package's `engines` declaration).
- **Zero install**: the generator needs no global install; each run resolves the package from the registry.
- **The generated repo is a bun project**: the generator itself runs on either runtime, but what it produces is managed with bun (the version pin and dependency install both go through bun). The default finish runs `bun install`; `--no-install` skips it.

## Usage

```shell
# npm: the create convention resolves to npm exec create-clis
npm create clis

# pnpm
pnpm create clis

# bun: bun create clis is bunx create-clis
bun create clis

# or call the package directly
bunx create-clis
```

The four entry points are equivalent. The target directory defaults to a subdirectory of the current directory named after the project:

```shell
# interactive: pass the target directory; the rest are asked one by one
bunx create-clis my-tool

# zero interaction: all defaults
bunx create-clis my-tool --yes

# through npm create, flags go after -- (standard npm behavior)
npm create clis -- my-tool --tier core
```

With no flags it asks the five questions one by one (the brackets show the defaults; Enter takes them, and an answer that fails validation prints the reason and asks again). Fields already given, as flags or through the positional directory, are adopted as-is. `--yes` takes every default, zero questions.

**Target directory**: a directory that already exists and is non-empty is refused outright (no overwrite, and no `--force` escape hatch; the risk of overwriting outweighs the convenience). An existing but empty directory is fine, and the files land in it.

Failures print the reason and exit non-zero. If a failure occurs after writing has started, the half-finished directory is pointed out and kept (nothing is silently cleaned up; look at it or delete it as you like).

## Variables and flags

Five variables, matching the template's generalization vocabulary one-to-one:

- **Project name**: the positional argument (the target directory's basename) or `--name`; no default, must be kebab-case (like `my-tool`);
- **scope**: `--scope`; defaults to none (a bare package name); when given, starts with `@` (like `@me`);
- **bin name**: `--bin`; defaults to a short form derived from the name (three or more segments take the head plus the initials of the rest: `sweep-node-modules` → `sweep-nm`);
- **owner**: `--owner`; defaults to the git-wide `user.name`;
- **repo URL**: `--repo`; defaults to `https://github.com/<owner>/<name>`.

The remaining flags:

- **`--tier <tier>`**: `core` / `standard` / `full`, default `standard`;
- **`--no-git`**: skip `git init` (runs by default);
- **`--no-install`**: skip dependency install (runs by default);
- **`--yes`**: all defaults, zero interaction;
- **`--help`**: print help.

Under `npm create`, flags go after `--` (`npm create clis -- --tier core`); npm strips that `--`, which is standard npm behavior the generator does not have to handle. Values are validated the moment they are collected (kebab-case name, command-safe bin name, well-formed scope, owner, and repo URL), failing on the spot with the reason.

## Tiers

`--tier` takes `core`, `standard`, or `full`; the default is `standard`. The tiers subtract: `full` is the complete box, `standard` is `full` minus the enhanced tier, and `core` is `standard` minus the standard tier.

- **core**: the engineering skeleton and release closure every repo in the collection carries (the layer without which the repo has not been finished);
- **standard** (default): adds the standard-tier equipment: the multi-package split (tool + library), the test setup, and the tech-debt ledger;
- **full**: adds the enhanced tier on top: the transcription conformance kit (behavior contracts + a golden corpus + a deterministic verifier + mutation self-check; the mechanism ships, the corpus and clauses are content to fill in) and its ledger reconciliation gate (`lint:coverage`).

Two notes on shape. Every generated repo comes out in the two-package collection form (tool + library); the generator does not produce single-package repos, so prune one package by hand if that is what you want. And the tier is a packing list, not a stored field: nothing in the generated repo records it, so later upgrades or downgrades are manual, file-by-file affairs (the pruning rules are in [capability-tiers.md](../../docs/designs/capability-tiers.md)).

## What you get

The template is derived, not maintained. Like the lockfile your package manager writes for you, it is produced from its source: change this repo and the next build carries the change, with no hand-syncing. The build also runs a residue check: the template may not contain the original project's vocabulary, and a leftover fails the build.

What lands on disk is a standalone new collection repo, on its own from the moment it exists: the generator does not upgrade or sync repos it has already generated, and the template's later evolution never flows back into them. It ships with:

- **The engineering skeleton**: workspaces / turbo / the root tsconfig / the config family (oxlint / prettier / editorconfig / gitattributes / gitignorerc / nvmrc / bunfig) / the version pin;
- **Commit hooks**: lefthook + `install-git-hooks` (degrading gracefully when lefthook is absent) + `safe-install`;
- **The gate chain, single-source**: `scripts/ci.ts` holds the one step list (manual full runs, pre-push, CI, and the release verify job all call into it), and `bun run ci` runs the whole thing;
- **The release pipeline**: semantic-release, OIDC trusted publishing behind a manual environment approval, a release-credential pre-flight, and per-package release self-checks;
- **The docs skeleton**: a docs index / designs as minimal units / an ADR template / CONTRIBUTING / SECURITY / a code of conduct;
- **AI-assistant files**: AGENTS.md and recommended `.vscode` settings;
- **Two example packages**: `<name>-cli` (a thin shell over the library) and `<name>` (the library), carrying a minimal greet demo; swap them for your own tool.

Generation runs in a fixed order: collect the variables → copy the snapshot → prune by tier → substitute the vocabulary → format the tree back to prettier-stable (what the product's own `format-check` gate needs) → rescan for leftovers → finish (`git init` and dependency install, both on by default). It ends with the next steps: enter the directory, run `bun run ci` to verify green, and start reshaping the repo from `docs/README.md` (the docs index).

A published version is proof, not a promise: it generated a complete project, installed its dependencies, and ran that project's entire gate chain green before it was allowed out.

## Development

Package scripts:

- `bun run build`: emits both artifacts: the template assets (`assets/template/`, built from this repo by the skeleton manifest) and the executable bundle (`dist/`, with the manifest the launcher reconciles it against);
- `bun run verify:release`: the pre-release check: clean checkout, artifacts built from this commit, manifest consistency, and the packed tarball matching the file whitelist;
- `bun run heavy-smoke`: the heavyweight smoke: generate a complete core-tier project and run its whole gate chain, green or nothing.

`prepublishOnly` strings the three together, so every published version carries its own proof: the project it generates is green. The design docs (package design / contract / tiers / snapshot mechanism) are all in [docs/designs/](../../docs/designs/).

---

- Design: [scaffold-package.md](../../docs/designs/scaffold-package.md);
- Package docs entry: [docs/README.md](docs/README.md).
