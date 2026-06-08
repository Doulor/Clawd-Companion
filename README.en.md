<div align="center">

# Clawd Companion

**A desktop pet companion for Claude Code — a transparent overlay that shows tool calls, session status, and completion alerts in real time.**

![GitHub all releases](https://img.shields.io/github/downloads/Doulor/Clawd-Companion/total?label=downloads)
![GitHub release](https://img.shields.io/github/v/release/Doulor/Clawd-Companion)
![License](https://img.shields.io/github/license/Doulor/Clawd-Companion)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-blue)

[中文](./README.md) · [Install](#install) · [Features](#features) · [Development](#development) · [Star History](#star-history)

</div>

## Preview

<div align="center">
  <img src="README-ICON/thinking.png" width="340" alt="Clawd thinking" />
  &nbsp;
  <img src="README-ICON/thinking-card.png" width="240" alt="Session start notification card" />
</div>

<div align="center">
  <img src="README-ICON/edit-tool.png" width="340" alt="Clawd working — Edit tool" />
</div>

<div align="center">
  <img src="README-ICON/done.png" width="220" alt="Clawd done" />
  &nbsp;
  <img src="README-ICON/error.png" width="220" alt="Clawd error" />
</div>

## Table of Contents

- [Preview](#preview)
- [Features](#features)
- [Install](#install)
- [Usage](#usage)
- [Development](#development)
- [Versioning & Releases](#versioning--releases)
- [Tech Stack](#tech-stack)
- [Contributing](#contributing)
- [License](#license)
- [Star History](#star-history)

## Features

### Core experience

- 🪟 **Transparent desktop pet window**, always-on-top, draggable with screen-edge clamping.
- 🔌 **Local event service** that receives Claude Code hook events over HTTP and WebSocket.
- 📡 **Hook forwarder** that automatically forwards `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Notification` / `Stop`.
- 🔄 **Auto-update** powered by GitHub Releases — silent checks on startup, one-click install.
- 🎬 **Action animation mapping** — customize the Clawd sprite animation per tool/event.
- 📊 **Runtime statistics** — tool call rankings, session counts, permission stats, and active hours persisted locally.
- 💾 **Config import/export** — back up or restore your full JSON configuration with one click.

### Done and error alerts

Both completion and error states get their own distinct animations paired with bubble/card feedback so you notice the result immediately.

<div align="center">
  <img src="README-ICON/9c20bcfa-454e-40c4-ae42-e38ea104369d.png" width="240" alt="Clawd done — green checkmark + notification card" />
</div>

### Git status awareness

Watches your project `.git` in real time. `commit` / `checkout` / `merge` and similar actions surface as capsule popups that don't interrupt your flow.

<div align="center">
  <img src="README-ICON/c4e6d373-194f-49f2-94f6-1dc71be15db2.png" width="280" alt="Git status capsule — commit popup" />
</div>

### Token usage dashboard

Scans session data under `~/.claude/projects`:

- Today / 30-day / all-time token totals
- Monthly calendar heatmap for the last 12 months
- Per-model token ranking (Top 5 by default, expandable to all)

<div align="center">
  <img src="README-ICON/644288fe-7301-4a1d-95b8-39110fde755b.png" width="560" alt="Token usage dashboard — heatmap + model breakdown" />
</div>

### Sound system

Configurable event-triggered sounds with built-in clips and custom `WAV / MP3 / OGG / FLAC` support:

- Four trigger events: done, error, permission request, session start
- Each event can be enabled/disabled and replaced independently
- Powered by the HTML5 Audio API — no external dependencies

### Multi-session mode

Track multiple Claude Code sessions simultaneously — the main Clawd follows the first session while mini Clawds appear around it, each independently showing its own status with tool stream ribbons.

<div align="center">
  <img src="README-ICON/a3fe425f-aee1-420d-aea5-f50133afb42a.png" width="560" alt="Multi-session mode — multiple Clawds with tool stream ribbons" />
</div>

### Idle animation

Configurable animation pool, playback interval, and repeat count; each Clawd (main + 3 companions) can independently choose a fixed animation or use the pool for random playback.

<div align="center">
  <img src="README-ICON/b65b9943-aa72-4056-970b-3f76dc826e65.png" width="560" alt="Idle animation settings — animation pool + interval config" />
</div>

### Auto-start with Claude Code

**Off by default.** Enable "Auto-start with Claude Code" in Settings → App Behavior to have Clawd Companion launch automatically on every `SessionStart`:

- If the main app is already running, the existing instance is reused.
- If the main app is not running, the forwarder starts it: `npm start` in dev, or the installed `.exe` in production.

Environment variable overrides (advanced):

```bash
CLAWD_COMPANION_AUTOSTART=1   # force on
CLAWD_COMPANION_AUTOSTART=0   # force off
```

## Install

1. Download the latest installer from [Releases](https://github.com/Doulor/Clawd-Companion/releases).
2. Run `Clawd-Companion-Setup-*.exe` to install.
3. Launch Clawd Companion and open the Settings panel.
4. Click "One-click install" to configure Claude Code hooks.
5. Restart your Claude Code session — Clawd will respond to events as they happen.

> Requires Windows 10 / 11. Node.js 22+ is only required for development.

## Usage

After launching, Clawd lives on your screen as a transparent overlay. Most controls live in the right-click menu and the Settings panel.

<div align="center">
  <img src="README-ICON/055a36bb-b7a1-481d-8ffc-b83229147dfb.png" width="640" alt="Settings panel overview — connection status + desktop pet" />
</div>

| Section | Capabilities |
| --- | --- |
| Right-click menu | Show/hide pet, open settings, quit |
| Settings → Appearance | Theme (Classic / Liquid Glass), size, scale, opacity |
| Settings → Behavior | Auto-start with Claude Code, animation mapping, sounds, notification rules |
| Settings → Data | Event history, runtime stats, token usage, import/export |
| Settings → Plugins | Enable plugins, view permissions and logs |
| Edit mode | Drag Clawd, bubbles/cards, and ribbons directly on the pet window |

For implementation details see the "Claude Code 启动时自动启动本应用" section in [`CLAUDE.md`](./CLAUDE.md).

## Development

```bash
# Clone
git clone https://github.com/Doulor/Clawd-Companion.git
cd Clawd-Companion

# Install dependencies
npm install

# Dev mode (Electron + Vite HMR)
npm run dev:electron

# Build
npm run build

# Package as an installer
npm run dist

# Validate latest.yml filename consistency
npm run dist:validate

# Type check
npm run typecheck

# Unit tests
npm test

# Summarize GitHub release download counts
npm run downloads
```

### Project layout

```
.
├── apps/
│   ├── desktop/                # Electron main process + settings UI
│   └── hook-forwarder/         # Node.js CLI that forwards hooks to the local event service
├── scripts/                    # Versioning, validation, download stats, lint
├── src/                        # Pet renderer (React + Vite)
├── build/                      # Icons and installer assets
├── plugin-market/              # Bundled plugin marketplace
├── release/                    # electron-builder output (gitignored)
└── CLAUDE.md                   # Project-level Claude Code guide
```

## Versioning & Releases

```bash
npm run version:patch   # bump patch (1.5.2 → 1.5.3)
npm run version:minor   # bump minor (1.5.2 → 1.6.0)
npm run version:major   # bump major (1.5.2 → 2.0.0)
```

The release flow is documented in [`CLAUDE.md`](./CLAUDE.md):

- Push a `v*.*.*` tag → CI builds, renames artifacts, and publishes to GitHub Releases automatically.
- Manual flow: `npm run dist`, then `gh release create`.

## Multi-CLI support

Starting with v1.6, Clawd Companion tracks multiple AI coding CLIs through a single `Provider` abstraction:

- **Claude Code** (default): registers hooks via `~/.claude/settings.json`, listening for `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Notification` / `Stop`.
- **OpenAI Codex** (new): registers hooks via `~/.codex/config.toml` (TOML), listening for `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `PermissionRequest` / `Stop`.

Manage both providers side-by-side under Settings → Sources. Adding a third CLI in the future only requires implementing the `Provider` interface. See the *Multi-CLI architecture* section in [`CLAUDE.md`](./CLAUDE.md) for details.

## Tech Stack

- Electron + React + TypeScript + Vite
- `electron-updater` (GitHub Releases)
- Local HTTP + WebSocket event service
- Claude Code hooks forwarder (Node.js CLI, 44 unit tests)
- `electron-builder` NSIS installer

## Continuous Integration

- **CI** (`.github/workflows/ci.yml`): runs typecheck and unit tests on push/PR.
- **Release** (`.github/workflows/release.yml`): on a `v*.*.*` tag push, builds, renames artifacts, and publishes to GitHub Releases.

## Contributing

Issues, feature requests, and pull requests are welcome. Before opening a PR, please make sure:

1. `npm run typecheck` passes
2. `npm test` passes
3. `npm run lint` passes
4. Keep the change focused and avoid unrelated refactors

## License

[MIT](./LICENSE) © Doulor

## Star History

<a href="https://www.star-history.com/#Doulor/Clawd-Companion&type=Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Doulor/Clawd-Companion&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Doulor/Clawd-Companion&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Doulor/Clawd-Companion&type=Date" />
  </picture>
</a>
