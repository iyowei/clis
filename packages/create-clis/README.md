# create-clis

[![CI](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/ci.yml)

**English** | [中文](README.zh-CN.md)

Scaffold a standalone clis collection repository from the clis skeleton snapshot: capability tiers, generic vocabulary, and a green CI out of the box.

> Status: section skeleton only. The bilingual body is drafted by the writing pipeline; every section below carries a `TODO(writer)` marker listing what it must cover. The npm badges land with the first published version (the package is not on the registry yet).

## Requirements

> TODO(writer): runtime floor (node / bun) and the zero-install story.

## Usage

> TODO(writer): the three distribution entry points (`npm create clis` / `pnpm create clis` / `bun create clis`), the direct `bunx create-clis` form, interactive Q&A versus flag-driven runs, and the target-directory rule (a directory that exists and is non-empty is refused).

## Variables and flags

> TODO(writer): the five variables (project name / scope / bin name / owner / repo URL) with their flags and defaults, plus `--tier`, `--no-git`, `--no-install`, `--yes`, and the `--` passthrough note for `npm create`.

## Tiers

> TODO(writer): core / standard / full, and what each tier carries.

## What you get

> TODO(writer): what the generated repository ships with (gate chain, release closure, docs skeleton), the generation flow at a glance, and the printed next steps.

## Development

> TODO(writer): package scripts (`build` / `verify:release` / `heavy-smoke`) and where the design docs live.

---

- Design: [scaffold-package.md](../../docs/designs/scaffold-package.md);
- Package docs entry: [docs/README.md](docs/README.md).
