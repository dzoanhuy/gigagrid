# Gigagrid

A cross-platform (macOS + Windows) desktop CSV editor built for GB-scale files —
5–20GB / tens of millions of rows. Opens instantly via a byte-offset row index
(no full-file load), scrolls/searches by seeking, and keeps edits in memory
until you explicitly save. Built with [Tauri](https://tauri.app) (Rust core +
React/TypeScript frontend).

## Features

- Open and scroll multi-GB raw CSV files without loading them into RAM
- Full-text search (find next/previous) across the whole file
- Goto a specific row/column
- Edit cells in place; overflowing content auto-scrolls into view
- Undo/redo (including whole-paste undo in one step)
- Multi-cell select, copy, and paste (TSV, compatible with spreadsheet apps)
- Save writes back the raw CSV, untouched except for your edits

## Development

Requires [Node.js](https://nodejs.org) and [Rust](https://rustup.rs).

```sh
npm install
npm run tauri dev
```

## Build

```sh
npm run tauri build
```

Produces a macOS or Windows installer depending on the host OS
(`src-tauri/tauri.conf.json`'s `bundle.targets: "all"`).

## Testing

```sh
cargo test --manifest-path src-tauri/Cargo.toml
npm test
```

## License

MIT — see [LICENSE](./LICENSE).
