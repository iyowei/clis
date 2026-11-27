# @iyowei/wake-cli

[![CI & Release](https://github.com/iyowei/clis/actions/workflows/release.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/release.yml)
[![npm version](https://img.shields.io/npm/v/@iyowei/wake-cli)](https://www.npmjs.com/package/@iyowei/wake-cli)
[![npm downloads](https://img.shields.io/npm/dm/@iyowei/wake-cli)](https://www.npmjs.com/package/@iyowei/wake-cli)
![node](https://img.shields.io/node/v/%40iyowei%2Fwake-cli)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fclis%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

**English** | [中文](README.zh-CN.md)

`wake` is a cross-platform Wake-on-LAN (`WoL`) CLI with zero third-party runtime dependencies. It wakes sleeping or powered-off computers on your local network or across subnets via always-on SSH jump hosts (`--relay`), and waits until SSH or any chosen TCP port responds before returning.

For programmatic integration inside scripts or automation tools, install the core library [`@iyowei/wake`](https://www.npmjs.com/package/@iyowei/wake).

## How It Works

When a desktop or server sleeps or shuts down, its OS and IP stack are usually unreachable, while the motherboard's network card stays in low-power listening mode. Sending a 102-byte UDP broadcast packet containing the target card's **MAC address** (e.g. `00:11:22:33:44:55`) tells the hardware to power on.

`wake` handles two setups automatically:

1. **Same LAN (direct broadcast)**: Your laptop and target computer share the same router. `wake` skips VPN/Docker virtual adapters (`utun`, `wg`, `tailscale`, etc.) so broadcast packets actually go out on your physical LAN interface.
2. **Remote / behind a VPN (`--relay`)**: Routers drop Layer-2 broadcasts across subnets, and VPN tunnels often swallow local broadcasts. Place `wake` on one or more always-on devices inside the target LAN (like a Raspberry Pi or spare Mac mini) and list them as SSH jump hosts (`--relay`). `wake` tries each jump host in order and falls back cleanly if the first one is offline.

## Target Machine Prerequisites

1. Enable `Power On By PCI-E` (sometimes named `Wake on LAN` / `Resume by PCI-E Device`) in BIOS, and set `ErP Ready` to `Disabled` so the NIC keeps standby power.
2. Find the target NIC's **MAC address** (and optionally its LAN IP for boot readiness polling):
   - Windows: run `ipconfig /all` and read `Physical Address`;
   - macOS: run `ifconfig` and read `ether` on `en0` / `en1`;
   - Linux: run `ip link` and read `link/ether`.
3. If you want `wake` to wait until the OS is ready, ensure port `22` (SSH) or another TCP port is reachable after boot.

## Installation

### 1. One-click script (macOS / Linux / Windows, no Node / Bun required)

Detects existing `bun` or `node >= 22.18.0`; falls back to an isolated private Bun runtime under `~/.local/share/clis/runtime`:

```shell
# macOS / Linux (curl)
curl \
  -fsSL \
  https://raw.githubusercontent.com/iyowei/clis/main/packages/wake-cli/install.sh \
  | sh

# Custom mirrors
curl \
  -fsSL \
  https://gh-proxy.com/https://raw.githubusercontent.com/iyowei/clis/main/packages/wake-cli/install.sh \
  | sh \
    -s -- \
    --installer-url \
      https://gh-proxy.com/https://raw.githubusercontent.com/iyowei/clis/main/install.sh \
    --bun-url \
      https://gh-proxy.com/https://github.com/oven-sh/bun/releases/latest/download \
    --registry \
      https://registry.npmmirror.com
```

### 2. Global install

```shell
npm install -g @iyowei/wake-cli
bun install -g @iyowei/wake-cli
```

### 3. Zero install

```shell
bunx @iyowei/wake-cli --help
npx @iyowei/wake-cli --help
```

## Quick Start: Same LAN

```shell
# 1. Interactive setup wizard (scans your local ARP table to prefill recent IPs & MACs)
wake init

# Or save a target non-interactively
wake init --name workstation --mac 00:11:22:33:44:55 --host 192.0.2.10 --default --yes

# 2. Wake default target and wait until TCP port 22 accepts connections
wake

# 3. Ad-hoc wake without writing config (--no-wait exits right after sending)
wake --mac 00:11:22:33:44:55 --host 192.0.2.10
wake --mac 00:11:22:33:44:55 --no-wait
```

## Remote Setup: SSH Jump Hosts & `~/.ssh/config`

When waking from outside the target LAN (or over WireGuard / VPN), `wake` runs `ssh -o BatchMode=yes` against your jump hosts, so password prompts cannot hang automation. If you have not configured `~/.ssh/config` before, follow these five steps:

### Step 1: Generate an SSH key pair (skip if you already have `~/.ssh/id_ed25519.pub`)

```text
ssh-keygen -t ed25519 -C "my-laptop"
```

### Step 2: Copy your public key to the jump host

Assuming the jump host is `ops@192.0.2.50`:

- **macOS / Linux**:

```text
ssh-copy-id ops@192.0.2.50
```

- **Windows (PowerShell)**:

```text
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh ops@192.0.2.50 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

### Step 3: Add clean aliases in `~/.ssh/config`

Add entries to `~/.ssh/config` (`C:\Users\<name>\.ssh\config` on Windows) so `wake` can reference short host names instead of raw IPs:

```text
Host home-pi
  HostName 192.0.2.50
  User ops
  Port 22
  IdentityFile ~/.ssh/id_ed25519

Host backup-mac
  HostName 198.51.100.20
  User ops
  Port 22
  IdentityFile ~/.ssh/id_ed25519
```

Test `ssh home-pi` and verify it logs in without asking for a password.

### Step 4: Install `wake` on the jump host and test non-interactive SSH

Install `wake` on each jump host, then verify non-interactive `BatchMode=yes` execution from your laptop:

```text
ssh -o BatchMode=yes home-pi "wake --version"
```

If it prints `wake`'s version cleanly, your relay channel is ready. If non-interactive SSH reports `wake: command not found` because your shell startup script is skipped, link `wake` into a system default path such as `/usr/local/bin/wake`:

```text
sudo ln -sf ~/.local/bin/wake /usr/local/bin/wake
```

### Step 5: Save jump hosts to target config and run diagnostics

```shell
# Try home-pi first, then fail over to backup-mac automatically
wake init --name workstation --mac 00:11:22:33:44:55 --host 192.0.2.10 --relay home-pi --relay backup-mac --default --yes --force

# Read-only check of config, LAN vs tunnel NICs, jump host reachability, and target status
wake doctor workstation

# Power on remotely
wake workstation
```

## Common Commands & Config Path

```shell
# List configured targets and default target
wake list

# Force direct local broadcast or disable local fallback when relays fail
wake workstation --local-only
wake workstation --no-local-fallback

# Switch language or check for updates
wake lang en
wake update --check
```

- Default config location: `~/.config/wake/config.json` on macOS/Linux, `%APPDATA%\wake\config.json` on Windows (override via `--config` or `WAKE_CONFIG`).

## Documentation

- [Engineering documentation index](https://github.com/iyowei/clis/blob/main/docs/README.md)
- [wake-cli docs & CLI surface contract](https://github.com/iyowei/clis/blob/main/packages/wake-cli/docs/README.md)
- [Core API package (`@iyowei/wake`)](https://github.com/iyowei/clis/blob/main/packages/wake/README.md)
