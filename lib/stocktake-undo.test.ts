import { describe, expect, it } from "vitest";
import { isLargeStockDiff, restoreCounts, sameBatches } from "./inventory";
import type { InventoryBatch, InventoryItem } from "./types";

function batch(id: string, expiryDate: string | null, quantity: number): InventoryBatch {
  return { id, expiryDate, quantity, createdAt: "2026-11-01T00:00:00Z" };
}

function item(batches: InventoryBatch[]): InventoryItem {
  return {
    id: "i1", name: "瓶裝水", category: "客房備品", unit: "瓶", quantity: batches.reduce((s, b) => s + b.quantity, 0),
    safetyStock: 0, suggestedPurchase: 1, active: true, usageForecastEnabled: false, batches,
  } as InventoryItem;
}

describe("restoreCounts", () => {
  it("沒有其他人動過：直接回到原數量", () => {
    const before = item([batch("a", "2026-12-01", 10)]);
    const after = item([batch("a", "2026-12-01", 7)]);
    expect(restoreCounts(before, after, after)).toEqual([{ batchId: "a", actual: 10 }]);
  });

  it("中間別人又領用 1：只把這次的 −3 加回去，保留別人的 −1", () => {
    const before = item([batch("a", null, 10)]);
    const after = item([batch("a", null, 7)]);
    const current = item([batch("a", null, 6)]);
    expect(restoreCounts(before, after, current)).toEqual([{ batchId: "a", actual: 9 }]);
  });

  it("這次新增的批次扣回去；被扣光刪掉的批次用原到期日補回", () => {
    const before = item([batch("a", "2026-11-20", 2), batch("b", null, 5)]);
    const after = item([batch("b", null, 5), batch("c", "2027-01-01", 4)]);
    expect(restoreCounts(before, after, after)).toEqual([
      { batchId: "c", actual: 0 },
      { expiryDate: "2026-11-20", actual: 2 },
    ]);
  });

  it("別人已經把這次加的量用掉，會變負數就不能自動復原", () => {
    const before = item([batch("a", null, 2)]);
    const after = item([batch("a", null, 8)]);
    const current = item([batch("a", null, 3)]);
    expect(restoreCounts(before, after, current)).toBeNull();
  });

  it("這次加進去的批次已被用完刪掉，或原批次加的量被用完刪掉，都不能自動復原", () => {
    const before = item([batch("a", null, 10)]);
    expect(restoreCounts(before, item([batch("a", null, 15)]), item([]))).toBeNull();
    expect(restoreCounts(before, item([batch("a", null, 10), batch("n", "2027-01-01", 4)]), item([batch("a", null, 10)]))).toBeNull();
  });

  it("沒有變動時回傳空陣列", () => {
    const same = item([batch("a", null, 3)]);
    expect(restoreCounts(same, same, same)).toEqual([]);
  });

  it("原本沒到期日的批次補回時不帶日期", () => {
    expect(restoreCounts(item([batch("a", null, 1.5)]), item([]), item([]))).toEqual([{ expiryDate: undefined, actual: 1.5 }]);
  });
});

describe("sameBatches", () => {
  it("批次與數量都相同才算一樣", () => {
    expect(sameBatches(item([batch("a", null, 3)]), item([batch("a", null, 3)]))).toBe(true);
    expect(sameBatches(item([batch("a", null, 3)]), item([batch("a", null, 2)]))).toBe(false);
    expect(sameBatches(item([batch("a", null, 3)]), item([batch("b", null, 3)]))).toBe(false);
  });
});

describe("isLargeStockDiff", () => {
  it("少一半以上或變兩倍以上、而且差 3 以上才提醒", () => {
    expect(isLargeStockDiff(10, 4)).toBe(true);
    expect(isLargeStockDiff(10, 6)).toBe(false);
    expect(isLargeStockDiff(10, 20)).toBe(true);
    expect(isLargeStockDiff(2, 0)).toBe(false);
    expect(isLargeStockDiff(4, 1)).toBe(true);
    expect(isLargeStockDiff(0, 30)).toBe(false);
  });
});
