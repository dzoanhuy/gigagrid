/** Helpers for tab switching shortcuts and match count presentation. */

export function getAdjacentTabIndex(
  currentIndex: number,
  totalTabs: number,
  direction: "left" | "right",
): number {
  if (totalTabs <= 1 || currentIndex < 0) return currentIndex;
  if (direction === "left") {
    return (currentIndex - 1 + totalTabs) % totalTabs;
  }
  return (currentIndex + 1) % totalTabs;
}

export function getTabIndexFromKey(key: string, totalTabs: number): number | null {
  const digit = parseInt(key, 10);
  if (Number.isNaN(digit) || digit < 1 || digit > 9) return null;
  const targetIndex = digit - 1;
  return targetIndex < totalTabs ? targetIndex : null;
}

export function formatMatchCount(ordinal: number, total: number | null): string {
  if (total === null) return "…";
  if (total === 0) return "0 / 0";
  return `${ordinal} / ${total}`;
}
