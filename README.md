# clis

[![CI & Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)

**English** | [中文](README.zh-CN.md)

A collection of command-line tools for my day-to-day development, managed as a monorepo — each tool ships as a symmetric pair of a programmable API package (`@iyowei/<name>`) and a thin CLI package (`@iyowei/<name>-cli`). All packages live under `packages/`, with docs starting from each package's `README.md`.

## Packages

- **`create-clis`**: the collection's scaffolding generator, turning this repo's skeleton snapshot into a standalone clis collection repository with capability tiers, generic vocabulary, and a green CI out of the box; usage is documented in its [README](packages/create-clis/README.md).
- **`@iyowei/sweep-cli`** _(pre-release, `private: true`)_: the `sweep` command-line tool, a general multi-toolchain workspace cleaner covering 6 built-in anchored presets (`node` / `rust` / `python` / `java` / `cpp` / `os-junk`) and custom `rules`, with zero-dependency cross-platform `trash`, v2 configuration (`SWEEP_CONFIG`, default `~/.config/sweep/config.json`), and automatic `init` / `migrate`; installation, usage, configuration, and safety guardrails live in its [README](packages/sweep-cli/README.md) (programmatic API: [`@iyowei/sweep`](packages/sweep/README.md)).
- **`@iyowei/codd-cli`**: the `codd` command-line tool, a template-driven MongoDB 9.0 provisioning generator for Podman (Linux & macOS) and Kubernetes (Helm) with an interactive terminal wizard and collision-free deployment bundles; usage is documented in its [README](packages/codd-cli/README.md) (programmatic API: [`@iyowei/codd`](packages/codd/README.md)).
- **`@iyowei/fan-cli`**: the `fan` command-line tool for reading and manually controlling Apple Silicon / Mac fan speeds via AppleSMC IOKit with persistence across reboots and wakeups and zero third-party runtime dependencies; usage is documented in its [README](packages/fan-cli/README.md) (programmatic API: [`@iyowei/fan`](packages/fan/README.md)).
- **`@iyowei/wake-cli`**: the `wake` command-line tool for subnet-aware Wake-on-LAN magic packets and ordered SSH relay failover with zero third-party runtime dependencies; usage is documented in its [README](packages/wake-cli/README.md) (programmatic API: [`@iyowei/wake`](packages/wake/README.md)).

## One-Click Install

Each CLI tool supports cross-platform one-click installation (**macOS, Linux, Windows**) without requiring pre-installed Node.js or Bun. The installer checks `PATH` for `bun` or `node >= 22.18.0`; if missing, it automatically downloads an isolated private Bun binary (SHA-256 verified) under `~/.local/share/clis/runtime` (or `%LOCALAPPDATA%\clis\runtime`) without modifying your global environment, and supports `<cli> update` and `--uninstall`.

**macOS / Linux (`curl` or `wget`)**:

Supports custom remote URLs via `--installer-url`, `--bun-url`, `--registry`, `--from-tarball`, or per-tool `CODD_*` / `CREATE_CLIS_*` / `SWEEP_*` / `FAN_*` environment variables:

```shell
# install a tool directly with curl (codd | create-clis | fan | sweep | wake)
curl \
  -fsSL \
  https://raw.githubusercontent.com/iyowei/clis/main/packages/codd-cli/install.sh \
  | sh

# or with wget
wget \
  -qO- \
  https://raw.githubusercontent.com/iyowei/clis/main/packages/codd-cli/install.sh \
  | sh

# or pick a tool via the unified root installer
curl \
  -fsSL \
  https://raw.githubusercontent.com/iyowei/clis/main/install.sh \
  | sh \
    -s -- \
    --tool codd

# with custom remote URLs
curl \
  -fsSL \
  https://gh-proxy.com/https://raw.githubusercontent.com/iyowei/clis/main/packages/codd-cli/install.sh \
  | sh \
    -s -- \
    --installer-url \
      https://gh-proxy.com/https://raw.githubusercontent.com/iyowei/clis/main/install.sh \
    --bun-url \
      https://gh-proxy.com/https://github.com/oven-sh/bun/releases/latest/download \
    --registry \
      https://registry.npmmirror.com
```

**Windows (PowerShell)**:

Supports per-tool environment variables (`CODD_*` / `CREATE_CLIS_*` / `SWEEP_*` / `FAN_*`) or `-InstallerUrl`, `-BunUrl`, `-Registry`, `-FromTarball`:

```powershell
# install a tool directly
irm `
  https://raw.githubusercontent.com/iyowei/clis/main/packages/codd-cli/install.ps1 `
  | iex

# or pass CLIS_TOOL to the unified root installer
$env:CLIS_TOOL = "codd"
irm `
  https://raw.githubusercontent.com/iyowei/clis/main/install.ps1 `
  | iex

# with custom remote URLs
$env:CODD_INSTALLER_URL = "https://gh-proxy.com/https://raw.githubusercontent.com/iyowei/clis/main/install.ps1"
$env:CODD_BUN_URL = "https://gh-proxy.com/https://github.com/oven-sh/bun/releases/latest/download"
$env:CODD_REGISTRY = "https://registry.npmmirror.com"
irm `
  https://gh-proxy.com/https://raw.githubusercontent.com/iyowei/clis/main/packages/codd-cli/install.ps1 `
  | iex
```

## Documentation

- [Engineering documentation index](docs/README.md): repository-level governance, scaffolding design, repo ADRs, and links to every package's docs;
- [Development guide](docs/development.md): environment setup, common commands, dual-runtime verification, release chain, and commit hooks;
- [sweep docs](packages/sweep/docs/README.md): API surface, product designs, safety guardrails, transcription conformance kit, and product ADRs;
- [codd docs](packages/codd/docs/README.md): hardware sizing formulas, Podman & Kubernetes runbooks, visual board (`BOARD.html`), and product ADRs;
- [fan docs](packages/fan/docs/README.md): AppleSMC key contracts, API surface, and CLI surface (`packages/fan-cli/docs/README.md`).
- [wake docs](packages/wake/docs/README.md): Wake-on-LAN API surface, SSH relay architecture ADR, and CLI surface (`packages/wake-cli/docs/README.md`).
