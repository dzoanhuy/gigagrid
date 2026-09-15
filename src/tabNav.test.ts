import { describe, expect, it } from "vitest";
import { findExistingTab, formatMatchCount, getAdjacentTabIndex, getTabIndexFromKey } from "./tabNav";

describe("getAdjacentTabIndex", () => {
  it("wraps around to the last tab when moving left from tab 0", () => {
    // Arrange
    const current = 0;
    const total = 5;

    // Act
    const result = getAdjacentTabIndex(current, total, "left");

    // Assert
    expect(result).toBe(4);
  });

  it("wraps around to tab 0 when moving right from the last tab", () => {
    // Arrange
    const current = 4;
    const total = 5;

    // Act
    const result = getAdjacentTabIndex(current, total, "right");

    // Assert
    expect(result).toBe(0);
  });

  it("moves to previous tab normally when within bounds", () => {
    // Arrange & Act & Assert
    expect(getAdjacentTabIndex(3, 5, "left")).toBe(2);
  });

  it("moves to next tab normally when within bounds", () => {
    // Arrange & Act & Assert
    expect(getAdjacentTabIndex(2, 5, "right")).toBe(3);
  });

  it("returns current index if only 1 tab exists", () => {
    expect(getAdjacentTabIndex(0, 1, "left")).toBe(0);
    expect(getAdjacentTabIndex(0, 1, "right")).toBe(0);
  });
});

describe("getTabIndexFromKey", () => {
  it("converts digit '1' through '9' to 0-based index", () => {
    expect(getTabIndexFromKey("1", 5)).toBe(0);
    expect(getTabIndexFromKey("3", 5)).toBe(2);
    expect(getTabIndexFromKey("5", 5)).toBe(4);
  });

  it("returns null if target index exceeds total tabs", () => {
    expect(getTabIndexFromKey("6", 5)).toBeNull();
    expect(getTabIndexFromKey("9", 5)).toBeNull();
  });

  it("returns null for non-digit keys", () => {
    expect(getTabIndexFromKey("0", 5)).toBeNull();
    expect(getTabIndexFromKey("a", 5)).toBeNull();
    expect(getTabIndexFromKey("Enter", 5)).toBeNull();
  });
});

describe("formatMatchCount", () => {
  it("returns ellipsis when total is null", () => {
    expect(formatMatchCount(0, null)).toBe("…");
  });

  it("returns '0 / 0' when total is 0", () => {
    expect(formatMatchCount(0, 0)).toBe("0 / 0");
  });

  it("formats ordinal and total when matches exist", () => {
    expect(formatMatchCount(1, 42)).toBe("1 / 42");
    expect(formatMatchCount(5, 10)).toBe("5 / 10");
  });
});

describe("findExistingTab", () => {
  const tabs = [
    { meta: { path: "/Users/dev/data/file1.csv", tab_id: 1 } },
    { meta: { path: "C:\\Users\\dev\\data\\file2.csv", tab_id: 2 } },
  ];

  it("finds tab with identical path", () => {
    const hit = findExistingTab(tabs, "/Users/dev/data/file1.csv");
    expect(hit?.meta.tab_id).toBe(1);
  });

  it("finds tab with slash vs backslash difference", () => {
    const hit = findExistingTab(tabs, "C:/Users/dev/data/file2.csv");
    expect(hit?.meta.tab_id).toBe(2);
  });

  it("returns undefined when file is not open in any tab", () => {
    const hit = findExistingTab(tabs, "/Users/dev/data/other.csv");
    expect(hit).toBeUndefined();
  });
});

