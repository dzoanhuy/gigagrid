# Gigagrid

[![CI](https://github.com/dzoanhuy/gigagrid/actions/workflows/ci.yml/badge.svg)](https://github.com/dzoanhuy/gigagrid/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/dzoanhuy/gigagrid)](https://github.com/dzoanhuy/gigagrid/releases/latest)
[![License: MIT](https://img.shields.io/github/license/dzoanhuy/gigagrid)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)](#build)

A cross-platform (macOS, Windows, Linux) desktop CSV editor built for GB-scale files —
5–20GB / tens of millions of rows. Opens instantly via a byte-offset row index
(no full-file load), scrolls/searches by seeking, and keeps edits in memory
until you explicitly save. Built with [Tauri](https://tauri.app) (Rust core +
React/TypeScript frontend).

![GigaGrid Demo](docs/demo.gif)

## Features

- Open and scroll multi-GB raw CSV files without loading them into RAM
- Full-text search (find next/previous) across the whole file
- Goto a specific row/column
- Edit cells in place; overflowing content auto-scrolls into view
- Undo/redo (including whole-paste undo in one step)
- Multi-cell select, copy, and paste (TSV, compatible with spreadsheet apps)
- Save writes back the raw CSV, untouched except for your edits

## Download

Prebuilt macOS, Windows, and Linux (`.deb` / `.AppImage`) installers are published on the
[Releases page](https://github.com/dzoanhuy/gigagrid/releases/latest).

## Development

Requires [Node.js](https://nodejs.org) and [Rust](https://rustup.rs).

On Linux (Ubuntu/Debian), install system dependencies:

```sh
sudo apt update && sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
```

```sh
npm install
npm run tauri dev
```

## Build

```sh
npm run tauri build
```

Produces a macOS (`.dmg`), Windows (`.msi` / `.exe`), or Linux (`.deb` / `.AppImage`) installer depending on the host OS
(`src-tauri/tauri.conf.json`'s `bundle.targets: "all"`).

## Testing

```sh
cargo test --manifest-path src-tauri/Cargo.toml
npm test
```

## License

MIT — see [LICENSE](./LICENSE).
