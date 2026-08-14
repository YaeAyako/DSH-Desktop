<div align="center">

# DeepSeek Harness Desktop

> [中文文档](README-zh.md) · [升级指南](UPGRADE.md)

**Run [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) in a native desktop window — the exact same UI and behavior as its web app, without opening a browser or signing in every time.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Node](https://img.shields.io/badge/Node-%3E%3D22-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white)]()
[![Built with DeepSeek Harness](https://img.shields.io/badge/Built%20with-DeepSeek%20Harness-4D6BFE)]()

</div>

---

## Why

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) ships a browser-based UI (`dsh web`). This project wraps that **same** UI in an Electron window so you can use it like any other desktop app:

- **Pixel-for-pixel parity** — it loads the official frontend bundle; nothing is reimplemented.
- **No browser** — a native window with a taskbar/dock icon; no tabs, no address bar.
- **No repeated sign-in** — sessions and API keys live in your existing `~/.dsh` and persist across restarts.

## How it works

```
 ┌────────────────────────────────┐
 │            Electron            │
 │  ┌──────────────────────────┐  │
 │  │  BrowserWindow           │  │
 │  │  (official Harness UI)   │◄─┼──── loads http://127.0.0.1:<port>
 │  └──────────────────────────┘  │
 └───────────────┬────────────────┘
                 │ spawns `node` (if needed)
 ┌───────────────▼────────────────┐
 │  node @deepseek-ai/dsh web     │
 │  (official backend, port 3080) │
 └────────────────────────────────┘
```

The Electron main process:

1. resolves a Node binary,
2. probes `127.0.0.1:<port>` (default `3080`) and **reuses an already-running Harness** if one is found,
3. otherwise spawns `@deepseek-ai/dsh`'s `web` profile on that port (falling back to `--port 0` if the port is taken by a non-Harness process),
4. parses the actual address from the backend's `dsh web: http://127.0.0.1:<port>` line,
5. loads that URL in a `BrowserWindow`.

Because the UI and the backend are the **same packages the browser uses**, the behavior is identical by construction.

## Features

- ✅ **1:1 UI/functionality parity** with `dsh web`
- 🚀 **Self-contained backend** — starts and stops it for you
- 🔐 **No re-login** — reuses `~/.dsh` sessions and `~/.dsh/.credentials.yaml`
- 🧭 **Reuses a running backend** — attaches to an existing `dsh web` instead of starting a second one, preventing session-log corruption from two backends sharing `~/.dsh`
- 🪟 **Single-instance lock** — launching again focuses the existing window
- 🧹 **Clean shutdown** — closes the backend and its tool subprocesses
- 🔗 **External links open in your system browser**
- 📦 **No build step** — the frontend bundle ships in the npm package

## Prerequisites

- **Node.js ≥ 22** (tested on 25) — the backend runs on your system Node.
- **Windows** (primary / tested). The shell also has a POSIX shutdown path, but Windows cleanup via `taskkill` is the verified one.

## Installation

```bash
git clone https://github.com/<your-name>/dsh-desktop.git
cd dsh-desktop
npm install
```

## Usage

```bash
npm start
```

On Windows you can also just double-click **`start.cmd`** (it installs dependencies on first run if they are missing).

## Configuration

Optional — create `dsh-desktop.config.json` next to `main.js`:

```json
{
  "node": "C:\\Program Files\\nodejs\\node.exe",
  "workspace": "C:\\Users\\you\\Projects",
  "dshHome": "C:\\Users\\you\\.dsh",
  "port": 3080
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `node` | auto-detected from `PATH` | Node executable that runs the backend |
| `workspace` | user home directory | The backend's working directory (the agent's workspace root) |
| `dshHome` | `~/.dsh` | Harness home (sessions, credentials, settings) |
| `port` | `3080` | Preferred port — the app reuses an existing Harness there, or starts one |

All keys are optional. The equivalent environment variables are `DSH_DESKTOP_NODE`, `DSH_DESKTOP_WORKSPACE`, `DSH_DESKTOP_PORT`, and `DSH_HOME`.

## Debugging

- **Logs** — backend output is written to `<userData>/backend.log` (usually `%APPDATA%\dsh-desktop\backend.log`).
- **Screenshot** — set `DSH_DESKTOP_SCREENSHOT=<path.png>` to capture the window after load (handy for debugging/CI).
- **Portable mode** — set `DSH_DESKTOP_USERDATA=<dir>` to relocate Electron's `userData` (localStorage, log).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `找不到后端入口` / backend entry not found | Run `npm install` — dependencies aren't installed yet. |
| Backend exits immediately | Check `<userData>/backend.log`; make sure Node ≥ 22 is on your `PATH`. |
| Port `3080` is taken by a non-Harness process | The app falls back to an OS-assigned port automatically. |

## Built with DeepSeek Harness

This project was developed end-to-end **using [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) itself** — every design decision, code edit, dependency install, and verification step (backend boot tests, the Electron shell, and this documentation) was performed by an agent running inside DeepSeek Harness.

## Author

Written by an AI coding agent — **deepseek-v4-pro** — running on DeepSeek Harness.

## Versioning & Upgrading the harness

DeepSeek Harness is currently a public preview (this project pins `0.1.0-rc.6`). Built zips are unaffected by future upstream releases. To upgrade to a newer harness version, follow [UPGRADE.md](UPGRADE.md) (re-scan peer dependencies + isolated verification are the key steps).

## License

[MIT](LICENSE). DeepSeek Harness and the `@deepseek-ai/*` packages are © their respective owners.

## Disclaimer

This is an unofficial, community-maintained wrapper. It is not affiliated with or endorsed by DeepSeek.
