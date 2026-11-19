# codd

[![CI](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/ci.yml)

**English** | [中文](README.zh-CN.md)

Template-driven MongoDB 9.0 provisioning CLI (`@iyowei/codd`) for Podman (Linux & macOS) and Kubernetes (Helm): derive WiredTiger cache, connection limits, oplog sizing, zstd/snappy compression, and `ulimit` guards deterministically from server hardware specs, and emit self-contained, 100% collision-free deployment bundles.

## Requirements

- **Dual runtime**: bun when available, node otherwise (`>= 22.18.0`, matching the package's `engines` declaration).
- Zero third-party runtime dependencies (built-in runtime capabilities only).
- Compatible with `npm`, `bun`, `pnpm`, and `yarn` across macOS, Linux, and Windows.

## Installation

### 1. No install (for a quick trial)

```shell
# with bun
bunx @iyowei/codd wizard

# with node
npx @iyowei/codd wizard
```

### 2. Global install via a package manager (recommended for regular use)

```shell
npm install -g @iyowei/codd
bun add -g @iyowei/codd
pnpm add -g @iyowei/codd
yarn global add @iyowei/codd
```

### 3. From source (for local development)

```shell
cd "<your clone>/clis"
bun install && bun run build
chmod +x packages/codd/bin/codd
ln -sf "$PWD/packages/codd/bin/codd" ~/.local/bin/codd
```

## Usage

```shell
# launch the interactive 4-step terminal wizard
codd wizard

# generate from ./deploy.json (or pass a specific JSON manifest)
codd
codd deploy-prod.json

# validate manifest and preview sizing formulas without writing files
codd deploy-prod.json --dry-run

# rotate app & backup passwords while keeping FINGERPRINT, root, and keyFile unchanged
codd deploy-prod.json --rotate

# export deploy.schema.json and deploy-2c2g.json starter manifest into the current directory
codd --init-schema
```

## Options

| Command / Flag                   | Description                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `codd wizard` / `-i`, `--wizard` | Launch the interactive 4-step configuration wizard                                           |
| `codd [manifest.json]`           | Generate deployment bundle(s) from the specified JSON manifest (defaults to `./deploy.json`) |
| `-c`, `--config <path>`          | Explicit path to the JSON manifest file                                                      |
| `-o`, `--out <dir>`              | Output directory for generated deployment bundles (defaults to `./dist`)                     |
| `--rotate`                       | Rotate app & backup passwords while keeping `FINGERPRINT`, `root`, and `keyFile` unchanged   |
| `--rotate-all`                   | Rotate all credentials including `root` and `keyFile` (fresh deployments only)               |
| `--new-fingerprint`              | Generate a brand-new 12-hex instance fingerprint for side-by-side deployment                 |
| `--dry-run`                      | Validate manifest and preview computed sizing formulas without writing files                 |
| `--init-schema`                  | Export `deploy.schema.json` and `deploy-2c2g.json` into the current directory                |
| `-v`, `--version`                | Print the CLI version (`1.0.0`)                                                              |
| `-h`, `--help`                   | Show CLI usage help                                                                          |

## Generated artifacts

- **`./dist/<prefix>-<name>-<fingerprint>/`**: Clean runtime-only deployment bundle ready to `rsync` to your target Linux/macOS server or deploy on Kubernetes (`chart/` is embedded for standalone execution).
- **`./.codd-state/`**: Mode `0700` local state directory (auto-protected with an internal `.gitignore`) locking your instance fingerprint, passwords, and ready-to-use MongoDB connection URIs (`*.credentials.txt`).

## Development

Environment setup, common commands, dual-runtime verification, and commit hooks: see the [development guide](../../docs/development.md).

## Documentation

- [Engineering documentation index](../../docs/README.md)
- [codd product docs hub](../../docs/codd/README.md)
- [Package docs entry](docs/README.md)
