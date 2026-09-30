# Security Policy

## Supported versions

Security fixes are released as new versions; only the latest published release of each package is supported:

- `@iyowei/sweep-node-modules-cli`: the `sweep-nm` CLI;
- `@iyowei/sweep-node-modules`: the programmable API.

Older releases do not receive fixes.

## Reporting a vulnerability

Please report suspected vulnerabilities privately, through GitHub's private reporting form: open the repository's Security tab, go to Advisories, and click Report a vulnerability. Do not open a public issue for a security problem. If the private form is unavailable, open a short issue mentioning @iyowei to ask for a private channel, and leave out the details until one is arranged.

A useful report includes:

- what the issue is, and how it could be exploited;
- the affected package and version, or the commit hash when running from a clone;
- the runtime and its version (bun or node), and the operating system;
- the exact command used, and the configuration in effect (`sweep-nm config` reports which config file applies);
- a minimal reproduction, if possible.

The report stays private between the reporter and the maintainers until a fix is released. To be credited when the fix ships, say so in the report.

## What to expect

The project is maintained by one person; responses are best effort, and security reports are handled through the advisory thread. Please allow time for a fix before disclosing anything publicly.

## Scope

Deleting `node_modules` directories is the tool's purpose: a removal of targets that were listed and confirmed is not a vulnerability. The published packages also carry no third-party runtime dependencies and make no network calls on the run path.

Reports we treat as security issues include, for example:

- removal of anything outside the configured roots, or of targets the safety guards should reject;
- ways to bypass the guards around path validation, symlinks, suspected install trees, or cross-device targets;
- output that can be forged or injected into, so the CLI shows something other than what is actually on disk;
- a published artifact that fails or bypasses its self-check, or a compromise of the release chain.

The full set of safety guarantees, including the honest account of the known residual risks, is documented in [docs/sweep/designs/safety-guardrails.md](docs/sweep/designs/safety-guardrails.md) (in Chinese).
