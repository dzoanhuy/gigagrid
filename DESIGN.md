---
version: 1.0.0
name: Gigagrid Desktop UI
description: Visual tokens and design specification for Gigagrid desktop high-performance CSV/grid viewer.
colors:
  bg: "#f6f6f6"
  fg: "#0f0f0f"
  border: "#dddddd"
  input-bg: "#ffffff"
  header-bg: "#e8e8e8"
  primary: "#396cd8"
  primary-hover: "#2c57b3"
  danger: "#d93025"
  tab-inactive-fg: "#666666"
  dark-bg: "#2f2f2f"
  dark-fg: "#f6f6f6"
  dark-border: "#444444"
  dark-input-bg: "#161616"
  dark-header-bg: "#3d3d3d"
typography:
  body:
    fontFamily: "Inter, Avenir, Helvetica, Arial, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
  monospace:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
  tab:
    fontFamily: "Inter, Avenir, Helvetica, Arial, sans-serif"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.2
rounded:
  xs: 2px
  sm: 4px
  md: 6px
  full: 9999px
spacing:
  xs: 2px
  sm: 4px
  md: 8px
  lg: 12px
  xl: 16px
components:
  tab-bar:
    backgroundColor: "{colors.bg}"
    height: 36px
    gap: 4px
  tab-item:
    backgroundColor: "transparent"
    rounded: "{rounded.sm}"
    padding: 4px 8px
  search-panel:
    backgroundColor: "{colors.bg}"
    rounded: "{rounded.md}"
    border: "1px solid {colors.border}"
    padding: 8px
---

# Gigagrid — Design Specification

## Overview
Gigagrid is a high-performance desktop CSV and tabular data viewer built with Tauri and React. The visual aesthetic is utility-focused, clean, and dense, optimizing screen real estate for data visualization.

## Colors
- Light Mode: Neutral light backgrounds (`#f6f6f6`), high-contrast dark text (`#0f0f0f`), and subtle borders (`#dddddd`).
- Dark Mode: Charcoal backgrounds (`#2f2f2f`), crisp light text (`#f6f6f6`), and darkened inputs (`#161616`).
- Accent: Focused blue (`#396cd8`) for active toggles, primary buttons, and cursor highlights. No gratuitous purple or gradient effects.

## Typography
- Main UI uses system sans-serif (`Inter`, `Helvetica`, `Arial`) at dense sizing (12px - 13px).
- Data grid and coordinate readouts use monospace fonts for precision alignment.

## Layout & Components

### 1. Tab Bar
- Position: Top bar pinned under titlebar.
- Sizing: Adaptive flex layout (`flex: 1 1 0`), `maxWidth: 200px`, `minWidth: 60px`.
- Ellipsis: File names truncate smoothly when multiple tabs share horizontal space.
- Close Button: Non-active tabs hide close button (`×`) when tab width drops below 80px to protect file label readability.

### 2. Floating Find & Replace Panel
- Position: Floating overlay at the top-right corner of the active grid viewport (`top: 8px`, `right: 16px`, `zIndex: 50`).
- Elevation: Subtle shadow (`box-shadow: 0 4px 16px rgba(0,0,0,0.18)`), theme border.
- Density: Compact 1-line search bar with match counter (`1 / 45`), Next/Prev buttons, close button, and a toggle chevron to reveal the Replace input row.
- Non-blocking: Keeps grid fully interactive underneath while search panel is open.

## Do's and Don'ts
- DO auto-select all text when the search input appears or is activated with `Cmd+F`.
- DO support both macOS (`Cmd`) and Windows/Linux (`Ctrl`) modifier keys for all shortcuts.
- DON'T allow tab switching shortcuts to swallow native text editing commands (`Cmd+Shift+Left/Right` text selection) inside inputs.
- DON'T introduce non-standard decorative animations that slow down rapid data inspection.
