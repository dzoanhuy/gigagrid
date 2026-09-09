import { describe, expect, it } from "vitest";
import { computeWindow } from "./Grid";

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
