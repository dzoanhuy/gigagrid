// Ad-hoc visual/layout smoke test for gigagrid: drives the Vite dev server in
// headless Chromium with a mocked Tauri IPC bridge (no native window needed),
// checks column-width consistency + shift-click selection rectangle.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = process.env.VISUAL_CHECK_OUT || __dirname;

const PORT = 1420;
const URL = `http://localhost:${PORT}`;

function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      http
        .get(url, (res) => {
          res.resume();
          resolve();
        })
        .on("error", () => {
          if (Date.now() - start > timeoutMs) reject(new Error("dev server did not start"));
          else setTimeout(poll, 300);
        });
    })();
  });
}

const INIT_SCRIPT = `
window.__TAURI_INTERNALS__ = {
  invoke: async (cmd, args) => {
    if (!window.__mockRows__) {
      window.__mockRows__ = Array.from({ length: 50 }, (_, r) =>
        Array.from({ length: 5 }, (_, c) => {
          if (r === 3 && c === 2) return "supercalifragilisticexpialidociousaverylongunbrokentoken";
          return "r" + r + "c" + c + "_" + "x".repeat((r * 3 + c * 2) % 15);
        })
      );
    }
    const rows = window.__mockRows__;
    if (cmd === "plugin:dialog|open") return "/mock/test.csv";
    if (cmd === "open_file") return { path: "/mock/test.csv", row_count: rows.length };
    if (cmd === "get_rows") {
      const start = args.start, count = args.count;
      return rows.slice(start, start + count);
    }
    if (cmd === "search" || cmd === "goto") return null;
    if (cmd === "set_cell" || cmd === "set_cells_batch") return null;
    if (cmd === "undo" || cmd === "redo") return false;
    if (cmd === "save_file") return null;
    return null;
  },
  transformCallback: (cb) => cb,
  unregisterCallback: () => {},
};
`;

async function main() {
  console.log("Starting vite dev server...");
  const vite = spawn("npm", ["run", "dev"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  vite.stdout.on("data", () => {});
  vite.stderr.on("data", (d) => process.stderr.write(d));

  try {
    await waitForServer(URL);
    console.log("Dev server up.");

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.addInitScript(INIT_SCRIPT);
    await page.goto(URL);

    await page.click("text=Open file");
    await page.waitForSelector("text=rows", { timeout: 5000 });
    await page.waitForTimeout(500); // let get_rows fetch + render settle

    // --- Check 1: column width consistency across rows for the SAME column ---
    const widths = await page.evaluate(() => {
      const cellsPerRow = [];
      const rows = Array.from(document.querySelectorAll('[data-gigagrid-scroll] > div:last-child > div'));
      for (const rowEl of rows) {
        const cells = Array.from(rowEl.children).filter(
          (el) => getComputedStyle(el).position !== "sticky"
        );
        cellsPerRow.push(cells.map((c) => Math.round(c.getBoundingClientRect().width)));
      }
      return cellsPerRow;
    });
    console.log("Per-row cell widths (first 8 rows):", JSON.stringify(widths.slice(0, 8)));
    const colCount = widths[0]?.length ?? 0;
    let inconsistent = false;
    for (let c = 0; c < colCount; c++) {
      const vals = new Set(widths.map((r) => r[c]).filter((v) => v !== undefined));
      if (vals.size > 1) {
        inconsistent = true;
        console.log(`Column ${c} widths differ across rows:`, [...vals]);
      }
    }
    console.log(inconsistent ? "COLUMN WIDTH: INCONSISTENT (bug present)" : "COLUMN WIDTH: CONSISTENT (fix confirmed)");

    await page.screenshot({ path: path.join(OUT_DIR, "grid-before-select.png") });

    // --- Check 2: shift+click selection rectangle ---
    const rowSelector = '[data-gigagrid-scroll] > div:last-child > div';
    const allRows = await page.$$(rowSelector);
    const targetCell = async (rIdx, cIdx) => {
      const rowEl = allRows[rIdx];
      const cells = await rowEl.$$(":scope > div");
      const dataCellsOnly = [];
      for (const c of cells) {
        const pos = await c.evaluate((el) => getComputedStyle(el).position);
        if (pos !== "sticky") dataCellsOnly.push(c);
      }
      return dataCellsOnly[cIdx];
    };
    const c1 = await targetCell(2, 1);
    await c1.click();
    const c2 = await targetCell(5, 3);
    await c2.click({ modifiers: ["Shift"] });
    await page.waitForTimeout(200);

    const selectedCount = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-gigagrid-scroll] > div:last-child > div'));
      let n = 0;
      for (const rowEl of rows) {
        const cells = Array.from(rowEl.children).filter((el) => getComputedStyle(el).position !== "sticky");
        for (const c of cells) {
          const bg = getComputedStyle(c).backgroundColor;
          if (bg.includes("70, 130, 255")) n++;
        }
      }
      return n;
    });
    console.log("Selected cell count after click(2,1) + shift+click(5,3):", selectedCount, "(expect 16 = 4 rows x 4 cols)");
    await page.screenshot({ path: path.join(OUT_DIR, "grid-after-shift-select.png") });

    // --- Check 3: freeze-header gap + last-row reachability ---
    // scroll to the very bottom and confirm the last row becomes visible
    await page.evaluate(() => {
      const el = document.querySelector("[data-gigagrid-scroll]");
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(500);
    const lastRowVisible = await page.evaluate(() => document.body.innerText.includes("r49c0"));
    console.log("Last row (r49) reachable by scrolling to bottom:", lastRowVisible);
    await page.screenshot({ path: path.join(OUT_DIR, "grid-scrolled-top.png") });

    await page.evaluate(() => {
      const el = document.querySelector("[data-gigagrid-scroll]");
      el.scrollTop = 0;
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT_DIR, "grid-scrolled-to-top-gap-check.png") });

    await browser.close();
  } finally {
    vite.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
