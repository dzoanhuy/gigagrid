/** Minimal line-style icon set for the toolbar — hand-drawn SVG primitives
 * (no icon-library dependency), sized to fill a 16x16 box and colored via
 * `currentColor` so every icon follows the button's text color automatically
 * (light/dark theme included, no separate icon palette to keep in sync). */
const common = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function IconFolder() {
  return (
    <svg {...common}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}

export function IconSave() {
  return (
    <svg {...common}>
      <path d="M5 3h11l3 3v15H5V3Z" />
      <path d="M8 3v6h8V3" />
      <path d="M8 21v-7h8v7" />
    </svg>
  );
}

export function IconMonitor() {
  return (
    <svg {...common}>
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M8 20h8" />
      <path d="M12 16v4" />
    </svg>
  );
}

export function IconSun() {
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
    </svg>
  );
}

export function IconMoon() {
  return (
    <svg {...common}>
      <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />
    </svg>
  );
}

export function IconGrid() {
  return (
    <svg {...common}>
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
    </svg>
  );
}

export function IconPin() {
  return (
    <svg {...common}>
      <circle cx="12" cy="9" r="5" />
      <path d="M12 14v7" />
    </svg>
  );
}

export function IconSearch() {
  return (
    <svg {...common}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}

export function IconHash() {
  return (
    <svg {...common}>
      <path d="M9 4L7 20M17 4l-2 16M4 9h18M4 15h18" />
    </svg>
  );
}

export function IconReplace() {
  return (
    <svg {...common}>
      <path d="M4 7h13l-3-3M20 17H7l3 3" />
    </svg>
  );
}

export function IconDownload() {
  return (
    <svg {...common}>
      <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
    </svg>
  );
}

export function IconClock() {
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}
