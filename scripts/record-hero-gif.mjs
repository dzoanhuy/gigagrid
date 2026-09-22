import { chromium } from "playwright";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DOCS_DIR = path.resolve(REPO_ROOT, "docs");
const RAW_DIR = path.resolve(DOCS_DIR, "raw_video");

if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });
if (!fs.existsSync(RAW_DIR)) fs.mkdirSync(RAW_DIR, { recursive: true });

const PORT = 1429;
const URL = `http://localhost:${PORT}`;

function waitForServer(url, timeoutMs = 25000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      http
        .get(url, (res) => {
          res.resume();
          resolve();
        })
        .on("error", () => {
          if (Date.now() - start > timeoutMs) reject(new Error("dev server did not start in time"));
          else setTimeout(poll, 300);
        });
    })();
  });
}

const INIT_SCRIPT = `
(function() {
  const HEADER = ["ID", "Name", "Department", "Role", "Location", "Status", "Balance"];
  const SAMPLE_PEOPLE = [
    ["Alex Vance", "Engineering", "Staff Architect", "San Francisco", "Active", "$18,500"],
    ["Sarah Jenkins", "Design", "Lead Designer", "Seattle", "Active", "$16,200"],
    ["Marcus Brody", "Operations", "Logistics Lead", "Chicago", "Pending", "$12,400"],
    ["Elena Woods", "Data Platform", "Senior Scientist", "New York", "Active", "$22,000"],
    ["David Kim", "Infrastructure", "DevOps Engineer", "Boston", "Active", "$17,800"],
    ["Amina Diallo", "Research", "Systems Analyst", "Austin", "Review", "$15,600"],
    ["Carlos Silva", "Engineering", "Backend Specialist", "Sao Paulo", "Active", "$14,900"],
    ["Priya Sharma", "Cloud Core", "Principal Eng", "Bangalore", "Active", "$24,500"],
    ["Lucas Dupont", "Security", "Security Lead", "Paris", "Active", "$19,200"],
    ["Rachel Morgan", "Product", "Product Manager", "London", "Active", "$18,000"],
    ["Taro Tanaka", "Engineering", "Robotics Engineer", "Tokyo", "Active", "$21,400"],
    ["Hannah Fischer", "Hardware", "Firmware Eng", "Berlin", "Active", "$16,800"],
    ["Mateo Rossi", "Platform", "Frontend Engineer", "Milan", "Active", "$15,200"],
    ["Chloe Martin", "Analytics", "BI Specialist", "Montreal", "Review", "$13,700"],
    ["Felix Zhao", "Engineering", "Kernel Developer", "Shanghai", "Active", "$23,100"],
    ["Isabella Gomez", "Network", "Network Architect", "Madrid", "Active", "$17,500"],
  ];

  const rows = [HEADER];
  for (let i = 1; i <= 200; i++) {
    const p = SAMPLE_PEOPLE[(i - 1) % SAMPLE_PEOPLE.length];
    const id = String(1000 + i);
    rows.push([id, p[0], p[1], p[2], p[3], p[4], p[5]]);
  }

  window.__mockRows__ = rows;
  window.__TOTAL_ROWS__ = 1250000;
  window.__tabCounter__ = 0;
  window.__sortCol__ = null;
  window.__filterQuery__ = "";
  window.__view__ = null;

  function computeView() {
    let idxs = rows.map((_, i) => i);
    if (window.__filterQuery__) {
      idxs = idxs.filter((i) => rows[i].some((cell) => (cell || "").toLowerCase().includes(window.__filterQuery__.toLowerCase())));
    }
    if (window.__sortCol__ !== null) {
      idxs = idxs.slice().sort((a, b) => (rows[a][window.__sortCol__] || "").localeCompare(rows[b][window.__sortCol__] || ""));
    }
    return idxs;
  }

  function viewLen() {
    return window.__view__ ? window.__view__.length : window.__TOTAL_ROWS__;
  }

  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      const allRows = window.__mockRows__;
      if (cmd === "plugin:dialog|open") return "/data/customers_1.2m_records.csv";
      if (cmd === "plugin:dialog|message") return "Yes";
      if (cmd === "take_pending_open") return null;

      if (cmd === "open_file") {
        window.__tabCounter__++;
        return {
          tab_id: window.__tabCounter__,
          path: args.path || "/data/customers_1.2m_records.csv",
          row_count: window.__TOTAL_ROWS__,
          format: "CSV",
          encoding: "UTF-8",
          line_ending: "LF",
        };
      }

      if (cmd === "get_rows") {
        const start = args.start;
        const count = args.count;
        const out = [];
        for (let i = 0; i < count; i++) {
          const idx = start + i;
          if (idx >= window.__TOTAL_ROWS__) break;
          if (idx === 0) {
            out.push(allRows[0]);
          } else {
            const mappedIdx = 1 + ((idx - 1) % (allRows.length - 1));
            const rowData = allRows[mappedIdx];
            out.push([String(1000 + idx), ...rowData.slice(1)]);
          }
        }
        return out;
      }

      if (cmd === "count_matches") {
        if (!args.query) return 0;
        return 48250;
      }

      if (cmd === "search") {
        const q = (args.query || "").toLowerCase();
        if (!q) return null;
        if (args.direction === "prev") return [1, 2];
        if (args.fromRow >= 7) return [11, 2];
        if (args.fromRow >= 1) return [7, 2];
        return [1, 2];
      }

      if (cmd === "set_filter") {
        window.__filterQuery__ = args.query || "";
        window.__view__ = (window.__filterQuery__ || window.__sortCol__ !== null) ? computeView() : null;
        return viewLen();
      }

      if (cmd === "set_sort") {
        window.__sortCol__ = args.col;
        window.__view__ = computeView();
        return viewLen();
      }

      if (cmd === "clear_sort") {
        window.__sortCol__ = null;
        window.__view__ = window.__filterQuery__ ? computeView() : null;
        return viewLen();
      }

      if (cmd === "clear_view") {
        window.__sortCol__ = null;
        window.__filterQuery__ = "";
        window.__view__ = null;
        return null;
      }

      if (cmd === "set_cell") {
        const { row, col, value } = args;
        if (allRows[row]) allRows[row][col] = value;
        return null;
      }

      if (cmd === "set_cells_batch") return null;
      if (cmd === "replace_all") return 1;
      if (cmd === "replace_cell") return true;
      if (cmd === "insert_row") return window.__TOTAL_ROWS__ + 1;
      if (cmd === "delete_row") return window.__TOTAL_ROWS__ - 1;
      if (cmd === "insert_col" || cmd === "delete_col") return null;
      if (cmd === "undo" || cmd === "redo") return [false, window.__TOTAL_ROWS__];
      if (cmd === "goto" || cmd === "save_file") return null;
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
})();
`;

async function main() {
  console.log("Starting Vite server on port " + PORT + "...");
  const vite = spawn("npm", ["run", "dev", "--", "--port", String(PORT)], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer(URL);
    console.log("Dev server ready at", URL);

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      viewport: { width: 920, height: 560 },
      recordVideo: {
        dir: RAW_DIR,
        size: { width: 920, height: 560 },
      },
      permissions: ["clipboard-read", "clipboard-write"],
    });

    const page = await context.newPage();
    page.on("dialog", (d) => d.accept());
    await page.addInitScript(INIT_SCRIPT);
    await page.goto(URL);

    // Inject cursor simulation
    await page.evaluate(() => {
      const cursor = document.createElement("div");
      cursor.id = "demo-cursor";
      cursor.style.position = "fixed";
      cursor.style.width = "18px";
      cursor.style.height = "18px";
      cursor.style.borderRadius = "50%";
      cursor.style.backgroundColor = "rgba(37, 99, 235, 0.65)";
      cursor.style.border = "2px solid #ffffff";
      cursor.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.35)";
      cursor.style.pointerEvents = "none";
      cursor.style.zIndex = "9999999";
      cursor.style.transform = "translate(-50%, -50%)";
      cursor.style.transition = "transform 0.08s ease, background-color 0.15s ease";
      cursor.style.left = "460px";
      cursor.style.top = "280px";
      document.body.appendChild(cursor);

      window.__setCursor = (x, y) => {
        cursor.style.left = `${x}px`;
        cursor.style.top = `${y}px`;
      };
      window.__pulseCursor = () => {
        cursor.style.backgroundColor = "rgba(239, 68, 68, 0.85)";
        cursor.style.transform = "translate(-50%, -50%) scale(0.85)";
        setTimeout(() => {
          cursor.style.backgroundColor = "rgba(37, 99, 235, 0.65)";
          cursor.style.transform = "translate(-50%, -50%) scale(1)";
        }, 180);
      };
    });

    async function moveMouseSmooth(targetX, targetY, steps = 12) {
      const current = await page.evaluate(() => {
        const c = document.getElementById("demo-cursor");
        return {
          x: parseFloat(c?.style.left || "460"),
          y: parseFloat(c?.style.top || "280"),
        };
      });
      for (let i = 1; i <= steps; i++) {
        const x = current.x + (targetX - current.x) * (i / steps);
        const y = current.y + (targetY - current.y) * (i / steps);
        await page.evaluate(({ cx, cy }) => window.__setCursor(cx, cy), { cx: x, cy: y });
        await page.mouse.move(x, y);
        await page.waitForTimeout(16);
      }
    }

    async function clickMouse(targetX, targetY) {
      await moveMouseSmooth(targetX, targetY);
      await page.evaluate(() => window.__pulseCursor());
      await page.mouse.click(targetX, targetY);
      await page.waitForTimeout(120);
    }

    // Step 1: Open file
    console.log("Step 1: Open file...");
    await page.waitForTimeout(400);
    const openBtn = await page.$('button[title="Open file"]');
    if (openBtn) {
      const openBox = await openBtn.boundingBox();
      if (openBox) {
        await clickMouse(openBox.x + openBox.width / 2, openBox.y + openBox.height / 2);
      }
    }
    await page.waitForSelector("text=customers_1.2m_records.csv", { timeout: 6000 });
    await page.waitForTimeout(800);

    // Step 2: Smooth scrolling down and back up
    console.log("Step 2: Smooth scrolling...");
    await moveMouseSmooth(480, 260, 14);

    for (let scrollPos = 150; scrollPos <= 1200; scrollPos += 200) {
      await page.evaluate((pos) => {
        const el = document.querySelector("[data-gigagrid-scroll]");
        if (el) el.scrollTop = pos;
      }, scrollPos);
      await page.waitForTimeout(70);
    }
    await page.waitForTimeout(350);

    for (let scrollPos = 1000; scrollPos >= 0; scrollPos -= 250) {
      await page.evaluate((pos) => {
        const el = document.querySelector("[data-gigagrid-scroll]");
        if (el) el.scrollTop = pos;
      }, scrollPos);
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(500);

    // Step 3: Fast Search
    console.log("Step 3: Fast Search...");
    await page.keyboard.press("Meta+f");
    await page.waitForTimeout(300);

    const searchInput = await page.$('input[placeholder="Search…"]');
    if (searchInput) {
      const box = await searchInput.boundingBox();
      if (box) {
        await moveMouseSmooth(box.x + 30, box.y + box.height / 2, 10);
      }
      await page.keyboard.type("Engineering", { delay: 60 });
      await page.waitForTimeout(600);

      // Next match
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(600);

      // Close search
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }

    // Step 4: Edit cell in-place
    console.log("Step 4: Edit cell in-place...");
    const targetCell = await page.evaluate(() => {
      const rows = document.querySelectorAll("[data-gigagrid-scroll] > div:last-child > div");
      for (const row of rows) {
        const cells = Array.from(row.children).filter(
          (c) => getComputedStyle(c).position !== "sticky"
        );
        for (const c of cells) {
          if (c.textContent?.trim() === "Pending") {
            const rect = c.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          }
        }
      }
      return null;
    });

    if (targetCell) {
      await moveMouseSmooth(targetCell.x, targetCell.y, 14);
      await page.evaluate(() => window.__pulseCursor());
      await page.mouse.dblclick(targetCell.x, targetCell.y);
      await page.waitForTimeout(300);

      await page.keyboard.press("Meta+a");
      await page.keyboard.type("Approved", { delay: 55 });
      await page.waitForTimeout(400);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(600);
    }

    // Step 5: Multi-cell selection
    console.log("Step 5: Multi-cell selection...");
    const selPoints = await page.evaluate(() => {
      const rows = document.querySelectorAll("[data-gigagrid-scroll] > div:last-child > div");
      if (rows.length > 5) {
        const row2 = Array.from(rows[2].children).filter((c) => getComputedStyle(c).position !== "sticky");
        const row5 = Array.from(rows[5].children).filter((c) => getComputedStyle(c).position !== "sticky");
        if (row2[1] && row5[3]) {
          const r1 = row2[1].getBoundingClientRect();
          const r2 = row5[3].getBoundingClientRect();
          return {
            start: { x: r1.x + 20, y: r1.y + r1.height / 2 },
            end: { x: r2.x + 40, y: r2.y + r2.height / 2 },
          };
        }
      }
      return null;
    });

    if (selPoints) {
      await moveMouseSmooth(selPoints.start.x, selPoints.start.y, 12);
      await page.mouse.down();
      await moveMouseSmooth(selPoints.end.x, selPoints.end.y, 14);
      await page.mouse.up();
      await page.waitForTimeout(800);
    }

    // Move mouse to bottom-right corner for clean loop rest
    await moveMouseSmooth(860, 520, 10);
    await page.waitForTimeout(1000);

    console.log("Closing page & context to finalize webm...");
    await page.close();
    await context.close();
    await browser.close();

    const files = fs.readdirSync(RAW_DIR).filter((f) => f.endsWith(".webm"));
    if (files.length === 0) {
      throw new Error("No webm video recorded!");
    }
    const latestVideo = path.join(RAW_DIR, files.sort().pop());
    console.log("Recorded video:", latestVideo);

    const gifOutput = path.resolve(DOCS_DIR, "demo.gif");
    console.log("Transcoding to GIF at", gifOutput);

    // Use -loglevel warning to keep stdout clean
    const ffmpegArgs = [
      "-y",
      "-loglevel",
      "warning",
      "-i",
      latestVideo,
      "-filter_complex",
      "[0:v] fps=14,scale=880:-1:flags=lanczos,split [a][b];[a] palettegen=max_colors=128:stats_mode=diff [p];[b][p] paletteuse=dither=bayer:bayer_scale=3",
      gifOutput,
    ];

    const ffmpeg = spawn("ffmpeg", ffmpegArgs, { stdio: "inherit" });
    await new Promise((res, rej) => {
      ffmpeg.on("close", (code) => {
        if (code === 0) res();
        else rej(new Error(`ffmpeg exited with code ${code}`));
      });
    });

    const stat = fs.statSync(gifOutput);
    console.log(`Generated GIF: ${gifOutput} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
  } finally {
    vite.kill("SIGTERM");
  }
}

main().catch((err) => {
  console.error("Recording error:", err);
  process.exit(1);
});
