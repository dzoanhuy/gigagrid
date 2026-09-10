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
          if (r === 10 && c === 1)
            return "The quick brown fox jumps over the lazy dog while several other equally verbose sentences pile up right behind it, one after another, until the whole thing reads like a run-on paragraph that nobody asked for but everybody has to edit anyway.";
          if (r === 15 && c === 3)
            return "line one\\nline two\\nline three\\nline four\\nline five\\nline six\\nline seven\\nline eight\\nline nine\\nline ten";
          if (r === 20 && c === 4)
            return Array.from({ length: 40 }, (_, i) => "line " + (i + 1)).join("\\n");
          if (r === 5 && c === 2) return "needle-match-one";
          if (r === 30 && c === 0) return "needle-match-two";
          return "r" + r + "c" + c + "_" + "x".repeat((r * 3 + c * 2) % 15);
        })
      );
    }
    const rows = window.__mockRows__;
    if (cmd === "plugin:dialog|open") return "/mock/test.csv";
    if (cmd === "open_file")
      return { path: "/mock/test.csv", row_count: rows.length, format: "CSV", encoding: "UTF-8", line_ending: "LF" };
    if (cmd === "get_rows") {
      const start = args.start, count = args.count;
      window.__getRowsCalls__ = window.__getRowsCalls__ || [];
      window.__getRowsCalls__.push({ start, count });
      return rows.slice(start, start + count);
    }
    if (cmd === "count_matches") {
      if (!args.query) return 0;
      let n = 0;
      for (const row of rows) for (const cell of row) if (cell.includes(args.query)) n++;
      return n;
    }
    if (cmd === "search") {
      const q = args.query;
      if (!q) return null;
      const rowCount = rows.length;
      const fromRow = args.fromRow, fromCol = args.fromCol;
      const dir = args.direction;
      if (dir === "prev") {
        for (let offset = 0; offset < rowCount; offset++) {
          const r = (fromRow + rowCount - offset) % rowCount;
          const row = rows[r];
          const upper = offset === 0 ? fromCol : row.length;
          for (let c = Math.min(upper, row.length) - 1; c >= 0; c--) {
            if (row[c].includes(q)) return [r, c];
          }
        }
        const row0 = rows[fromRow];
        for (let c = row0.length - 1; c >= fromCol; c--) {
          if (row0[c].includes(q)) return [fromRow, c];
        }
        return null;
      }
      for (let offset = 0; offset < rowCount; offset++) {
        const r = (fromRow + offset) % rowCount;
        const row = rows[r];
        const startCol = offset === 0 ? fromCol + 1 : 0;
        for (let c = startCol; c < row.length; c++) {
          if (row[c].includes(q)) return [r, c];
        }
      }
      const rowA = rows[fromRow];
      for (let c = 0; c <= fromCol && c < rowA.length; c++) {
        if (rowA[c].includes(q)) return [fromRow, c];
      }
      return null;
    }
    if (cmd === "goto") return null;
    if (cmd === "set_cell" || cmd === "set_cells_batch") return null;
    if (cmd === "replace_all") {
      const { query, replacement } = args;
      if (!query) return 0;
      let count = 0;
      for (const row of rows) {
        for (let c = 0; c < row.length; c++) {
          if (row[c].includes(query)) {
            row[c] = row[c].split(query).join(replacement);
            count++;
          }
        }
      }
      return count;
    }
    if (cmd === "replace_cell") {
      const { row, col, query, replacement } = args;
      if (!query) return false;
      const r = rows[row];
      if (!r || r[col] === undefined || !r[col].includes(query)) return false;
      r[col] = r[col].split(query).join(replacement);
      return true;
    }
    if (cmd === "undo" || cmd === "redo") return false;
    if (cmd === "save_file") return null;
    if (cmd === "take_pending_open") return null;
    if (cmd === "plugin:event|listen") return 1;
    if (cmd === "plugin:event|unlisten") return null;
    return null;
  },
  transformCallback: (cb) => cb,
  unregisterCallback: () => {},
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
  unregisterListener: () => {},
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
    const context = await browser.newContext({
      viewport: { width: 1000, height: 700 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    await page.addInitScript(INIT_SCRIPT);
    await page.goto(URL);

    await page.click('button[title="Open file"]');
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

    // --- Check 4: edit box grows to available space for large content ---
    // reset scroll, then double-click the long-sentence cell (row 10, col 1)
    await page.evaluate(() => {
      document.querySelector("[data-gigagrid-scroll]").scrollTop = 0;
    });
    await page.waitForTimeout(300);
    const scrollBoxBefore = await page.evaluate(() => {
      const el = document.querySelector("[data-gigagrid-scroll]");
      const r = el.getBoundingClientRect();
      return { right: r.right, bottom: r.bottom };
    });
    const rowsAfterRescroll = await page.$$(rowSelector);
    const targetCell2 = async (rIdx, cIdx) => {
      const rowEl = rowsAfterRescroll[rIdx];
      const cells = await rowEl.$$(":scope > div");
      const dataCellsOnly = [];
      for (const c of cells) {
        const pos = await c.evaluate((el) => getComputedStyle(el).position);
        if (pos !== "sticky") dataCellsOnly.push(c);
      }
      return dataCellsOnly[cIdx];
    };
    const longTextCell = await targetCell2(9, 1); // logical row 10 = DOM idx 9 (freezeHeader excludes row 0)
    await longTextCell.dblclick();
    await page.waitForTimeout(300);
    const editBoxSize = await page.evaluate(() => {
      const ta = document.querySelector("textarea");
      if (!ta) return null;
      const r = ta.getBoundingClientRect();
      return { width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    });
    console.log("Edit box size for long wrapped sentence:", editBoxSize);
    console.log("Scroll container right/bottom edge:", scrollBoxBefore);
    if (editBoxSize) {
      console.log(
        "Edit box uses",
        Math.round((editBoxSize.width / (scrollBoxBefore.right - 48)) * 100) + "%",
        "of available width,",
        Math.round((editBoxSize.height / (scrollBoxBefore.bottom - editBoxSize.bottom + editBoxSize.height)) * 100) + "%",
        "of available height (rough)"
      );
    }
    await page.screenshot({ path: path.join(OUT_DIR, "cell-edit-long-text.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // row 15 col 3, 10 explicit lines — vertical growth check
    const multilineCell = await targetCell2(14, 3);
    await multilineCell.dblclick();
    await page.waitForTimeout(300);
    const editBoxSize2 = await page.evaluate(() => {
      const ta = document.querySelector("textarea");
      if (!ta) return null;
      const r = ta.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    console.log("Edit box size for 10-line content:", editBoxSize2);
    await page.screenshot({ path: path.join(OUT_DIR, "cell-edit-multiline.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // row 20 col 4, 40 lines — cap should engage, box must stay within the app
    const hugeCell = await targetCell2(19, 4);
    await hugeCell.dblclick();
    await page.waitForTimeout(300);
    const editBoxSize3 = await page.evaluate(() => {
      const ta = document.querySelector("textarea");
      const scrollEl = document.querySelector("[data-gigagrid-scroll]");
      if (!ta || !scrollEl) return null;
      const r = ta.getBoundingClientRect();
      const s = scrollEl.getBoundingClientRect();
      return {
        width: r.width,
        height: r.height,
        bottom: r.bottom,
        containerBottom: s.bottom,
        fitsWithinContainer: r.bottom <= s.bottom + 1,
        hasInternalScroll: ta.scrollHeight > ta.clientHeight,
      };
    });
    console.log("Edit box size for 40-line content (cap should engage):", editBoxSize3);
    await page.screenshot({ path: path.join(OUT_DIR, "cell-edit-huge.png") });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // --- Check 5: edit box font/color match the app theme ---
    const freshRows = await page.$$(rowSelector);
    const targetCell3 = async (rIdx, cIdx) => {
      const rowEl = freshRows[rIdx];
      const cells = await rowEl.$$(":scope > div");
      const dataCellsOnly = [];
      for (const c of cells) {
        const pos = await c.evaluate((el) => getComputedStyle(el).position);
        if (pos !== "sticky") dataCellsOnly.push(c);
      }
      return dataCellsOnly[cIdx];
    };
    const aCell = await targetCell3(0, 0);
    await aCell.dblclick();
    await page.waitForTimeout(200);
    const fontCheck = await page.evaluate(() => {
      const ta = document.querySelector("textarea");
      const bodyFontSize = getComputedStyle(document.body).fontSize;
      const taStyle = getComputedStyle(ta);
      return {
        bodyFontSize,
        textareaFontSize: taStyle.fontSize,
        textareaColor: taStyle.color,
        textareaBg: taStyle.backgroundColor,
        rootBg: getComputedStyle(document.documentElement).backgroundColor,
      };
    });
    console.log("Edit box font/color check:", fontCheck);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // --- Check 6: header/gutter background distinct from data background ---
    const bgCheck = await page.evaluate(() => {
      const headerCell = document.querySelector('[data-gigagrid-scroll] > div:first-child > div:nth-child(2)');
      const dataRow = document.querySelectorAll('[data-gigagrid-scroll] > div:last-child > div')[2];
      const dataCell = dataRow ? Array.from(dataRow.children).find((el) => getComputedStyle(el).position !== "sticky") : null;
      return {
        headerBg: headerCell ? getComputedStyle(headerCell).backgroundColor : null,
        dataBg: dataCell ? getComputedStyle(dataCell).backgroundColor : null,
      };
    });
    console.log("Header vs data background:", bgCheck, "(should differ)");

    // --- Check 7: click row-number / column-number header selects the whole row/col ---
    const gutterCell = await page.evaluateHandle(() => {
      const row = document.querySelectorAll('[data-gigagrid-scroll] > div:last-child > div')[2];
      return Array.from(row.children).find((el) => getComputedStyle(el).position === "sticky");
    });
    await gutterCell.asElement().click();
    await page.waitForTimeout(200);
    const rowSelectCount = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-gigagrid-scroll] > div:last-child > div'));
      let n = 0;
      for (const rowEl of rows) {
        for (const c of rowEl.children) {
          if (getComputedStyle(c).backgroundColor.includes("70, 130, 255")) n++;
        }
      }
      return n;
    });
    console.log("Selected cells after clicking a row-number gutter (expect = colCount = 5):", rowSelectCount);
    await page.screenshot({ path: path.join(OUT_DIR, "row-header-select.png") });

    const colHeaderCell = await page.$('[data-gigagrid-scroll] > div:first-child > div:nth-child(3)');
    await colHeaderCell.click();
    await page.waitForTimeout(200);
    const colSelectCount = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-gigagrid-scroll] > div:last-child > div'));
      let n = 0;
      for (const rowEl of rows) {
        for (const c of rowEl.children) {
          if (getComputedStyle(c).backgroundColor.includes("70, 130, 255")) n++;
        }
      }
      return n;
    });
    console.log("Selected cells after clicking a column header (expect = number of rendered rows):", colSelectCount);
    await page.screenshot({ path: path.join(OUT_DIR, "col-header-select.png") });

    // --- Check 8: Cmd+F toggles search, count shows, Enter selects result ---
    await page.keyboard.press("Meta+f");
    await page.waitForTimeout(200);
    const searchVisibleAfterToggle = await page.evaluate(() =>
      !!document.querySelector('input[placeholder="Search…"]'),
    );
    console.log("Search box visible after Cmd+F:", searchVisibleAfterToggle);
    await page.keyboard.type("needle-match");
    await page.waitForTimeout(400);
    const countText = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll("span"));
      const hit = spans.find((s) => /\d+ \/ \d+/.test(s.textContent || ""));
      return hit ? hit.textContent : null;
    });
    console.log("Match count shown:", countText, "(expect 1 / 2)");
    const selectedAfterSearch = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-gigagrid-scroll] > div:last-child > div'));
      let n = 0;
      for (const rowEl of rows) {
        for (const c of rowEl.children) {
          if (getComputedStyle(c).backgroundColor.includes("70, 130, 255")) n++;
        }
      }
      return n;
    });
    console.log("Cells selected after search found a result (expect 1):", selectedAfterSearch);
    await page.screenshot({ path: path.join(OUT_DIR, "search-result-selected.png") });
    await page.keyboard.press("Meta+g");
    await page.waitForTimeout(300);
    const countTextAfterNext = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll("span"));
      const hit = spans.find((s) => /\d+ \/ \d+/.test(s.textContent || ""));
      return hit ? hit.textContent : null;
    });
    console.log("Match count after Cmd+G (find next):", countTextAfterNext, "(expect 2 / 2)");
    await page.screenshot({ path: path.join(OUT_DIR, "search-find-next.png") });
    await page.keyboard.press("Meta+f");
    await page.waitForTimeout(200);
    const searchHiddenAfterToggleOff = await page.evaluate(
      () => !document.querySelector('input[placeholder="Search…"]'),
    );
    console.log("Search box hidden after Cmd+F again:", searchHiddenAfterToggleOff);

    // --- Check 9: copySelection fetches the FULL range from backend, not
    // just whatever the virtualized cache happened to hold ---
    await page.evaluate(() => {
      const el = document.querySelector("[data-gigagrid-scroll]");
      el.scrollTop = 0;
      window.__getRowsCalls__ = [];
    });
    await page.waitForTimeout(200);
    // select row 2 (anchor), scroll far down (forces the early rows out of
    // the small MAX_CACHE_ROWS-bounded cache in a real 20k+ row file; here
    // 50 rows all stay cached, but this still proves copy always fetches
    // fresh rather than silently trusting whatever's cached), then
    // shift+click row ~40's gutter to select a big range and copy it.
    const rowsForCopy = await page.$$(rowSelector);
    async function gutterAt(rowHandles, idx) {
      const cells = await rowHandles[idx].$$(":scope > div");
      for (const c of cells) {
        const pos = await c.evaluate((el) => getComputedStyle(el).position);
        if (pos === "sticky") return c;
      }
      return null;
    }
    const anchorGutter = await gutterAt(rowsForCopy, 0);
    await anchorGutter.click();
    const farGutter = await gutterAt(rowsForCopy, rowsForCopy.length - 1);
    await farGutter.click({ modifiers: ["Shift"] });
    await page.waitForTimeout(200);
    await page.keyboard.press("Meta+c");
    await page.waitForTimeout(300);
    const getRowsCallsForCopy = await page.evaluate(() => window.__getRowsCalls__ || []);
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    const clipboardLines = clipboardText.split("\n");
    const emptyLines = clipboardLines.filter((l) => l.trim() === "" || l.split("\t").every((c) => c === "")).length;
    console.log("get_rows calls during copy:", JSON.stringify(getRowsCallsForCopy));
    console.log(
      "Copied",
      clipboardLines.length,
      "lines, 0 empty expected (was silently empty for uncached rows before the fix); empty lines found:",
      emptyLines,
    );

    // --- Check 10: Cmd+Shift+ArrowUp extends selection to row 0 ---
    await page.evaluate(() => {
      document.querySelector("[data-gigagrid-scroll]").scrollTop = 0;
    });
    await page.waitForTimeout(200);
    const rowsForExtend = await page.$$(rowSelector);
    const anchorGutter2 = await gutterAt(rowsForExtend, 3);
    await anchorGutter2.click();
    await page.keyboard.press("Meta+Shift+ArrowUp");
    await page.waitForTimeout(200);
    const selectionAfterExtend = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll("span"));
      const hit = spans.find((s) => /selection: \d+ × \d+/.test(s.textContent || ""));
      return hit ? hit.textContent : null;
    });
    console.log("Selection after Cmd+Shift+ArrowUp from row 4:", selectionAfterExtend, "(expect 5 x 5 = rows 0-4, all cols)");
    await page.screenshot({ path: path.join(OUT_DIR, "shift-extend-to-top.png") });

    // --- Check 10b: plain Arrow moves the cursor by one cell, Shift+Arrow
    // extends by one cell, Cmd+Arrow jumps the CURSOR (not just the
    // scrollbar) to the edge ---
    const cursorText = async () => {
      const spans = Array.from(await page.$$eval("span", (els) => els.map((e) => e.textContent)));
      return spans.find((t) => /^cursor: /.test(t || "")) || null;
    };
    const selectionText = async () => {
      const spans = Array.from(await page.$$eval("span", (els) => els.map((e) => e.textContent)));
      return spans.find((t) => /^selection: /.test(t || "")) || null;
    };
    await page.evaluate(() => {
      document.querySelector("[data-gigagrid-scroll]").scrollTop = 0;
    });
    await page.waitForTimeout(200);
    const freshRowsForArrow = await page.$$(rowSelector);
    const targetCell4 = async (rIdx, cIdx) => {
      const cells = await freshRowsForArrow[rIdx].$$(":scope > div");
      const dataCellsOnly = [];
      for (const c of cells) {
        const pos = await c.evaluate((el) => getComputedStyle(el).position);
        if (pos !== "sticky") dataCellsOnly.push(c);
      }
      return dataCellsOnly[cIdx];
    };
    // click a plain cell first (row 4, col 4 by DOM position) as a clean start
    const startCell = await targetCell4(3, 2);
    await startCell.click();
    await page.waitForTimeout(150);
    console.log("Cursor before arrow moves:", await cursorText());

    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(150);
    console.log("Cursor after plain ArrowDown (expect row +1, same col):", await cursorText());

    await page.keyboard.press("Shift+ArrowRight");
    await page.waitForTimeout(150);
    console.log(
      "Selection after Shift+ArrowRight (expect 1 x 2, extends one cell right):",
      await selectionText(),
    );

    await page.keyboard.press("Meta+ArrowUp");
    await page.waitForTimeout(200);
    console.log(
      "Cursor after Cmd+ArrowUp (freezeHeader ON by default -> expect R2, the first data row" +
        " BELOW the frozen title row, not R1 itself):",
      await cursorText(),
    );
    await page.screenshot({ path: path.join(OUT_DIR, "arrow-key-nav.png") });

    // --- Check 10c: arrow-key nav does NOT scroll when the target cell is
    // already visible; DOES scroll once it would go off-screen ---
    await page.evaluate(() => {
      document.querySelector("[data-gigagrid-scroll]").scrollTop = 0;
      document.querySelector("[data-gigagrid-scroll]").scrollLeft = 0;
    });
    await page.waitForTimeout(200);
    const rowsForNoScroll = await page.$$(rowSelector);
    const targetCell5 = async (rIdx, cIdx) => {
      const cells = await rowsForNoScroll[rIdx].$$(":scope > div");
      const dataCellsOnly = [];
      for (const c of cells) {
        const pos = await c.evaluate((el) => getComputedStyle(el).position);
        if (pos !== "sticky") dataCellsOnly.push(c);
      }
      return dataCellsOnly[cIdx];
    };
    const nearTopCell = await targetCell5(0, 0);
    await nearTopCell.click();
    await page.waitForTimeout(150);
    const scrollTopBefore = await page.evaluate(
      () => document.querySelector("[data-gigagrid-scroll]").scrollTop,
    );
    // a handful of ArrowDown presses that stay well within the visible
    // viewport (this grid renders ~20+ rows at once) should NOT move the
    // scrollbar at all
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(80);
    }
    const scrollTopAfterSmallMoves = await page.evaluate(
      () => document.querySelector("[data-gigagrid-scroll]").scrollTop,
    );
    console.log(
      "scrollTop before/after 3 in-view ArrowDown presses:",
      scrollTopBefore,
      "->",
      scrollTopAfterSmallMoves,
      scrollTopBefore === scrollTopAfterSmallMoves ? "(unchanged, correct)" : "(BUG: scrolled while still visible)",
    );
    // now press ArrowDown enough times to genuinely go off the bottom edge
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("ArrowDown");
    }
    await page.waitForTimeout(150);
    const scrollTopAfterOffscreen = await page.evaluate(
      () => document.querySelector("[data-gigagrid-scroll]").scrollTop,
    );
    console.log(
      "scrollTop after moving off-screen (30 more ArrowDown):",
      scrollTopAfterOffscreen,
      scrollTopAfterOffscreen > scrollTopAfterSmallMoves ? "(scrolled, correct)" : "(BUG: did not scroll)",
    );

    // --- Check 11: header/frozen-row bar background covers the FULL
    // scrollable width, not just the viewport — resize a column wide enough
    // to force horizontal scroll, scroll all the way right, and compare the
    // bar's own rendered width against the container's scrollWidth.
    await page.evaluate(() => {
      document.querySelector("[data-gigagrid-scroll]").scrollTop = 0;
      document.querySelector("[data-gigagrid-scroll]").scrollLeft = 0;
    });
    await page.waitForTimeout(200);
    // drag the last column's resize handle out to force horizontal overflow
    const headerBarBox = await page.$('[data-gigagrid-scroll] > div:first-child');
    const lastColHandle = await page.$('[data-gigagrid-scroll] > div:first-child > div:last-child > div');
    const handleBox = await lastColHandle.boundingBox();
    await page.mouse.move(handleBox.x + 2, handleBox.y + 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + 600, handleBox.y + 2);
    await page.mouse.up();
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const el = document.querySelector("[data-gigagrid-scroll]");
      el.scrollLeft = el.scrollWidth;
    });
    await page.waitForTimeout(200);
    const barCoverage = await page.evaluate(() => {
      const scrollEl = document.querySelector("[data-gigagrid-scroll]");
      const headerBar = scrollEl.children[0];
      const frozenBar = scrollEl.children[1];
      return {
        scrollWidth: scrollEl.scrollWidth,
        headerBarWidth: headerBar.getBoundingClientRect().width,
        frozenBarWidth: frozenBar ? frozenBar.getBoundingClientRect().width : null,
      };
    });
    console.log(
      "Header bar width vs full scroll width:",
      barCoverage,
      barCoverage.headerBarWidth >= barCoverage.scrollWidth - 1 ? "COVERS FULL WIDTH (fixed)" : "GAP STILL PRESENT (bug)",
    );
    await page.screenshot({ path: path.join(OUT_DIR, "header-bg-scrolled-right.png") });

    // --- Check 12: Enter opens the edit box on the LAST-selected cell and
    // clears the multi-cell selection highlight ---
    await page.evaluate(() => {
      document.querySelector("[data-gigagrid-scroll]").scrollTop = 0;
      document.querySelector("[data-gigagrid-scroll]").scrollLeft = 0;
    });
    await page.waitForTimeout(200);
    const rowsForEnter = await page.$$(rowSelector);
    const targetCell6 = async (rIdx, cIdx) => {
      const cells = await rowsForEnter[rIdx].$$(":scope > div");
      const dataCellsOnly = [];
      for (const c of cells) {
        const pos = await c.evaluate((el) => getComputedStyle(el).position);
        if (pos !== "sticky") dataCellsOnly.push(c);
      }
      return dataCellsOnly[cIdx];
    };
    const rangeStart = await targetCell6(1, 0);
    await rangeStart.click();
    const rangeEnd = await targetCell6(3, 2);
    await rangeEnd.click({ modifiers: ["Shift"] });
    await page.waitForTimeout(150);
    console.log("Selection before Enter (expect a multi-cell range):", await selectionText());

    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    const editingAfterEnter = await page.evaluate(() => {
      const ta = document.querySelector("textarea");
      return ta ? { present: true, value: ta.value } : { present: false };
    });
    console.log("Textarea after Enter on a multi-cell selection (expect present:true, value = cell(3,2)'s):", editingAfterEnter);

    const selectedCountAfterEnter = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-gigagrid-scroll] > div:last-child > div'));
      let n = 0;
      for (const rowEl of rows) {
        for (const c of rowEl.children) {
          if (getComputedStyle(c).backgroundColor.includes("70, 130, 255")) n++;
        }
      }
      return n;
    });
    console.log("Highlighted (non-editing) cells after Enter (expect 0 — selection collapsed):", selectedCountAfterEnter);
    await page.screenshot({ path: path.join(OUT_DIR, "enter-opens-edit.png") });

    // --- Check 13: while editing, Cmd+A selects the FIELD's text, not the
    // grid's cells; arrow keys move the caret, not the grid cursor ---
    const selectAllOnFocus = await page.evaluate(() => {
      const ta = document.querySelector("textarea");
      return ta ? { selStart: ta.selectionStart, selEnd: ta.selectionEnd, len: ta.value.length } : null;
    });
    console.log("Textarea selection right when edit opens (auto-select-all on focus):", selectAllOnFocus);

    await page.keyboard.type("EDITEDVALUE");
    await page.waitForTimeout(100);
    await page.keyboard.press("Meta+a");
    await page.waitForTimeout(100);
    const cmdAWhileEditing = await page.evaluate(() => {
      const ta = document.querySelector("textarea");
      return ta
        ? { selStart: ta.selectionStart, selEnd: ta.selectionEnd, len: ta.value.length, activeIsTextarea: document.activeElement === ta }
        : null;
    });
    console.log("Textarea selection after Cmd+A while editing (expect selStart:0, selEnd:len, activeIsTextarea:true):", cmdAWhileEditing);
    const gridSelectionDuringEdit = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-gigagrid-scroll] > div:last-child > div'));
      let n = 0;
      for (const rowEl of rows) {
        for (const c of rowEl.children) {
          if (getComputedStyle(c).backgroundColor.includes("70, 130, 255")) n++;
        }
      }
      return n;
    });
    console.log("Grid-level highlighted cells after Cmd+A while editing (expect 0 — grid select-all did NOT fire):", gridSelectionDuringEdit);

    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    const caretAfterArrows = await page.evaluate(() => {
      const ta = document.querySelector("textarea");
      return ta ? ta.selectionStart : null;
    });
    console.log("Caret position after Home + 2x ArrowRight while editing (expect 2 — moved within the field):", caretAfterArrows);

    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const editingClosedAfterEscape = await page.evaluate(() => !document.querySelector("textarea"));
    const cellTextAfterCancel = await targetCell6(3, 2).then((c) => c.evaluate((el) => el.textContent));
    console.log("Edit box closed after Escape:", editingClosedAfterEscape);
    console.log("Cell(3,2) text after typed+Escape (expect ORIGINAL value, edit cancelled, not 'EDITEDVALUE'):", cellTextAfterCancel);

    // --- Check 14: Enter on a SINGLE selected cell (no range) edits that
    // cell, and a second Enter commits the new value ---
    const singleCell = await targetCell6(5, 1);
    await singleCell.click();
    await page.waitForTimeout(150);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    await page.keyboard.press("Meta+a");
    await page.keyboard.type("COMMITTED-VIA-ENTER");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    const cellTextAfterCommit = await targetCell6(5, 1).then((c) => c.evaluate((el) => el.textContent));
    const editingClosedAfterCommit = await page.evaluate(() => !document.querySelector("textarea"));
    console.log("Cell(5,1) text after Enter-edit + Cmd+A + type + Enter (expect 'COMMITTED-VIA-ENTER'):", cellTextAfterCommit);
    console.log("Edit box closed after commit:", editingClosedAfterCommit);
    // arrow keys should work again right after commit (focus returned to grid)
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(150);
    console.log("Cursor after ArrowDown right after commit (expect it moved, proving focus returned to the grid):", await cursorText());
    await page.screenshot({ path: path.join(OUT_DIR, "enter-commit-then-arrow.png") });

    // --- Check 15: Find & Replace — "Replace" advances to the next match
    // and only touches the current cell; "Replace All" clears every
    // remaining match across the file. Uses the same "needle-match" cells
    // from Check 8 (row 5 col 2, row 30 col 0 — 2 total matches). ---
    await page.evaluate(() => {
      document.querySelector("[data-gigagrid-scroll]").scrollTop = 0;
    });
    await page.waitForTimeout(200);
    await page.keyboard.press("Meta+f");
    await page.waitForTimeout(200);
    // The search box's `query`/cursor/count state survives a prior Cmd+F
    // toggle-off (the Toolbar stays mounted, only its rendered UI is
    // hidden) — Check 8 left it sitting on match 2/2. Clearing first makes
    // the query state actually CHANGE when re-filled with "needle-match"
    // (React bails on a same-value re-set), which is what re-triggers the
    // effect that resets the search cursor back to the FIRST match.
    await page.fill('input[placeholder="Search…"]', "");
    await page.waitForTimeout(200);
    await page.fill('input[placeholder="Search…"]', "needle-match");
    await page.waitForTimeout(400);
    console.log("Match count before replace (expect 1 / 2):", await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll("span"));
      const hit = spans.find((s) => /\d+ \/ \d+/.test(s.textContent || ""));
      return hit ? hit.textContent : null;
    }));

    await page.click('button[title="Toggle replace"]');
    await page.waitForTimeout(150);
    await page.fill('input[placeholder="Replace…"]', "REPLACED");
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Replace");
      btn.click();
    });
    await page.waitForTimeout(300);
    const afterOneReplace = await page.evaluate(() => window.__mockRows__[5][2]);
    console.log("Row5/Col2 value after single 'Replace' (expect 'REPLACED-one', was 'needle-match-one'):", afterOneReplace);
    const renderedCellText = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-gigagrid-scroll] > div:last-child > div'));
      for (const rowEl of rows) {
        const dataCells = Array.from(rowEl.children).filter((c) => getComputedStyle(c).position !== "sticky");
        if (dataCells[2]?.textContent === "REPLACED-one") return dataCells[2].textContent;
      }
      return null;
    });
    console.log("Rendered DOM shows the replaced value somewhere after cache-invalidation refetch (expect 'REPLACED-one'):", renderedCellText);
    const countAfterOne = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll("span"));
      const hit = spans.find((s) => /\d+ \/ \d+/.test(s.textContent || ""));
      return hit ? hit.textContent : null;
    });
    console.log("Match count after single Replace (expect 1 / 1 — ordinal reset to the fresh total, not racing the stale one):", countAfterOne);

    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Replace All");
      btn.click();
    });
    await page.waitForTimeout(300);
    const afterReplaceAll = await page.evaluate(() => window.__mockRows__[30][0]);
    console.log("Row30/Col0 value after 'Replace All' (expect 'REPLACED-two', was 'needle-match-two'):", afterReplaceAll);
    const countAfterAll = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll("span"));
      const hit = spans.find((s) => /\d+ \/ \d+/.test(s.textContent || ""));
      return hit ? hit.textContent : null;
    });
    console.log("Match count after Replace All (expect 0 / 0 stays until re-search — this reads the last count refresh):", countAfterAll);
    await page.screenshot({ path: path.join(OUT_DIR, "find-and-replace.png") });

    await browser.close();
  } finally {
    vite.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
