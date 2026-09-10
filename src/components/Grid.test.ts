import { describe, expect, it } from "vitest";
import { computeWindow, fetchRowsInChunks } from "./Grid";

describe("computeWindow", () => {
  it("returns empty range for an empty file", () => {
    expect(computeWindow(0, 28, 600, 0, 10)).toEqual({ start: 0, count: 0 });
  });

  it("clips the start at 0 when scrolled near the top", () => {
    const r = computeWindow(0, 28, 560, 1000, 10);
    expect(r.start).toBe(0);
    expect(r.count).toBeGreaterThan(0);
  });

  it("clips the end at totalRows when scrolled near the bottom", () => {
    const totalRows = 100;
    const r = computeWindow(100 * 28, 28, 560, totalRows, 10);
    expect(r.start + r.count).toBeLessThanOrEqual(totalRows);
  });

  it("includes an overscan buffer around the visible rows", () => {
    // scrollTop=280 -> visible rows start at row 10 (280/28); overscan=5
    // means the fetched window should start at row 5, not row 10.
    const r = computeWindow(280, 28, 280, 1000, 5);
    expect(r.start).toBe(5);
  });

  it("is a pure function — same inputs always give the same output", () => {
    const a = computeWindow(560, 28, 600, 5000, 10);
    const b = computeWindow(560, 28, 600, 5000, 10);
    expect(a).toEqual(b);
  });
});

describe("fetchRowsInChunks", () => {
  function makeCountingFetcher() {
    const calls: Array<{ start: number; count: number }> = [];
    const fetchChunk = async (start: number, count: number) => {
      calls.push({ start, count });
      return Array.from({ length: count }, (_, i) => [`r${start + i}`]);
    };
    return { calls, fetchChunk };
  }

  it("makes a single call when count fits in one chunk", async () => {
    const { calls, fetchChunk } = makeCountingFetcher();
    const rows = await fetchRowsInChunks(10, 33, 5000, fetchChunk);
    expect(calls).toEqual([{ start: 10, count: 33 }]);
    expect(rows.length).toBe(33);
    expect(rows[0]).toEqual(["r10"]);
    expect(rows[32]).toEqual(["r42"]);
  });

  it("splits a selection spanning multiple chunk boundaries with no gaps or overlaps", async () => {
    const { calls, fetchChunk } = makeCountingFetcher();
    const rows = await fetchRowsInChunks(0, 12345, 5000, fetchChunk);
    expect(calls).toEqual([
      { start: 0, count: 5000 },
      { start: 5000, count: 5000 },
      { start: 10000, count: 2345 },
    ]);
    expect(rows.length).toBe(12345);
    // every row must be present exactly once, in order — this is exactly
    // the failure mode reported against a real ~200k-row selection (whole
    // rows silently blank when fetched in one giant call)
    for (let r = 0; r < rows.length; r++) {
      expect(rows[r]).toEqual([`r${r}`]);
    }
  });

  it("makes no calls and returns no rows for an empty selection", async () => {
    const { calls, fetchChunk } = makeCountingFetcher();
    const rows = await fetchRowsInChunks(0, 0, 5000, fetchChunk);
    expect(calls).toEqual([]);
    expect(rows).toEqual([]);
  });
});
