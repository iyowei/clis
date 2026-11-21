# Security Policy

## Supported versions

Security fixes are released as new versions; only the latest published release of each published package is supported:

- `create-clis`: the monorepo collection scaffold CLI;
- `@iyowei/sweep-cli` / `@iyowei/sweep`: the `sweep` general multi-toolchain workspace cleaner CLI and programmable API (currently pre-release / `private: true`, tracked on `main`);
- `@iyowei/codd-cli` / `@iyowei/codd`: the MongoDB 9.0 provisioning CLI and programmable API (currently pre-release / `private: true`, tracked on `main`).

Older releases do not receive fixes.

## Reporting a vulnerability

Please report suspected vulnerabilities privately, through GitHub's private reporting form: open the repository's Security tab, go to Advisories, and click Report a vulnerability. Do not open a public issue for a security problem. If the private form is unavailable, open a short issue mentioning @iyowei to ask for a private channel, and leave out the details until one is arranged.

A useful report includes:

- what the issue is, and how it could be exploited;
- the affected package and version, or the commit hash when running from a clone;
- the runtime and its version (bun or node), and the operating system;
- the exact command or API call used, and any active configuration;
- a minimal reproduction, if possible.

The report stays private between the reporter and the maintainers until a fix is released. To be credited when the fix ships, say so in the report.

## What to expect

The project is maintained by one person; responses are best effort, and security reports are handled through the advisory thread. Please allow time for a fix before disclosing anything publicly.

## Scope

Runtime dependency posture varies by package:

- `@iyowei/sweep`, `@iyowei/sweep-cli`, `@iyowei/codd`, and `@iyowei/codd-cli` carry no third-party runtime dependencies and make no network calls on the run path;
- `create-clis` bundles no network calls on the run path, and carries `prettier` plus `@trivago/prettier-plugin-sort-imports` as runtime dependencies solely to format newly generated scaffold files.

Reports we treat as security issues include, for example:

- **`sweep` (`sweep` / `@iyowei/sweep` / `@iyowei/sweep-cli`)**: removal of anything outside the configured roots, bypassing path validation / preset anchor / symlink / suspected install tree / cross-device guards, silently falling back from failed `trash` to permanent deletion, or forging CLI output so it differs from disk state (trashing or deleting listed and confirmed matched targets is the tool's intended purpose; full safety guarantees and known residual risks are documented in [safety-guardrails.md](packages/sweep/docs/designs/safety-guardrails.md), in Chinese);
- **`codd` (`codd` / `@iyowei/codd`)**: template/shell/YAML/XML injection through manifest inputs, path traversal in generated bundle paths, weakening default loopback binding or generated keyfile/credential permissions, or unsafe Helm upgrade secret clobbering;
- **`create-clis`**: overwriting existing non-empty directories without refusal, path traversal during template rendering, or leaking host secrets/files into generated repositories;
- **Distribution & release chain**: launcher PATH / cwd config (`bunfig.toml` / `.env`) hijacking, published artifacts that fail or bypass SHA-256 self-verification, or compromise of the release chain.
